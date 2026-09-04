"use strict";

const crypto = require("crypto");
const path = require("path");
const ui = require("./ui");
const { registerProvider } = require("..");
const {
    buildFullPrompt,
    buildTextPayload,
    stageTempPayload,
    buildCappedTransmissionPlan,
    resolveChunkSizeOverride,
    buildTransmissionFinale,
    SINGLE_PASTE_MAX,
    ANON_MAX_PARTS,
    ANON_PART_SIZE_CEILING,
    PART_TAG_OVERHEAD,
} = require("../../lib/payload");

const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_LOGIN_URL = "https://gemini.google.com";
const CONVERSATION_URL_RE = null;

// Minimum spacing between rapid chunked sends. Sends are already serialized
// on each part's ack completion (transmitPart awaits generation end), so a
// typical gap is many seconds and no extra sleep is needed - this floor only
// kicks in for freak sub-second round-trips, keeping a burst profile tame.
const MIN_PART_GAP_MS = 1000;

// Measured with a live probe (Sep 2026): Gemini's composer silently
// truncates pasted input at exactly 32,001 chars, cutting off the part
// close tag, so composer verification can never pass for larger parts.
// Cap chunk bodies (tags/header take only ~hundreds of chars on top) well
// under that ceiling. ChatGPT's textarea has no such cap, so this limit
// applies to the Gemini provider only.
const GEMINI_MAX_PART_CHARS = 29000;

function buildGeminiDeliveryPlan(payload) {
    const manualChunkSize = resolveChunkSizeOverride();
    if (manualChunkSize) {
        console.log(`>> Using manual chunk size override: ${manualChunkSize} chars (${(manualChunkSize / 1024).toFixed(1)} KB).`);
    } else {
        console.log(`>> Gemini composer cap: chunk bodies limited to ${GEMINI_MAX_PART_CHARS} chars.`);
    }
    return {
        plan: buildCappedTransmissionPlan(payload, GEMINI_MAX_PART_CHARS, manualChunkSize),
        manualChunkSize,
    };
}

const GOOGLE_AUTH_COOKIE_NAMES = [
    "SID",
    "LSID",
    "SSID",
    "__Secure-1P_APISID",
    "__Secure-3P_APISID",
    "APISID",
    "SAPI",
];

function isOnAuthPage(page) {
    const url = page.url();
    return (
        url.includes("accounts.google.com") ||
        url.includes("/auth/") ||
        url.includes("consent") ||
        url.includes("signin")
    );
}

async function isLoggedInViaCookies(context) {
    try {
        const cookies = await context.cookies("https://gemini.google.com").catch(() => []);
        return cookies.some((c) => GOOGLE_AUTH_COOKIE_NAMES.includes(c.name) && c.value && c.value.length > 10);
    } catch {
        return false;
    }
}

async function gotoGemini(page, targetUrl) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`>> Navigating to ${targetUrl} (attempt ${attempt}/3)...`);
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            console.log(`>> Navigation complete (${page.url()}).`);
            return;
        } catch (error) {
            lastError = error;
            console.log(`>> Gemini navigation failed (${error.message}), retrying ${attempt}/3...`);
            await page.waitForTimeout(3000);
        }
    }
    throw lastError;
}

async function waitForGenerationEnd(page) {
    return ui.waitForGenerationEnd(page);
}

async function waitForPartLanding(page, closeTag, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastSnippet = "";
    while (Date.now() < deadline) {
        const found = await page
            .evaluate(
                ({ userSel, needle }) => {
                    const msgs = document.querySelectorAll(userSel);
                    for (const msg of msgs) {
                        if ((msg.innerText || "").includes(needle)) return true;
                    }
                    return false;
                },
                { userSelector: ui.selector("userMessage"), needle: closeTag }
            )
            .catch(() => false);
        if (found) return { ok: true, snippet: "" };

        lastSnippet = await page
            .evaluate(
                (userSel) => {
                    const msgs = document.querySelectorAll(userSel);
                    const last = msgs[msgs.length - 1];
                    return (((last && (last.innerText || "")) || "") + "").trim().slice(0, 120);
                },
                ui.selector("userMessage")
            )
            .catch(() => "");
        await page.waitForTimeout(600);
    }
    return { ok: false, snippet: lastSnippet };
}

async function transcriptContainsCloseTag(page, closeTag) {
    return page
        .evaluate(
            ({ userSel, needle }) => {
                const msgs = document.querySelectorAll(userSel);
                for (const msg of msgs) {
                    if ((msg.innerText || "").includes(needle)) return true;
                }
                return false;
            },
            { userSelector: ui.selector("userMessage"), needle: closeTag }
        )
        .catch(() => false);
}

function composerHasContent(page, needle, minLength) {
    return ui.promptInput(page)
        .evaluate(
            (el, { needle, minLength }) => {
                const text = "value" in el ? el.value : el.innerText || el.textContent || "";
                return text.includes(needle) && text.length >= minLength;
            },
            { needle, minLength }
        )
        .catch(() => false);
}

function looksLikeUsageLimit(page) {
    return page
        .evaluate(() => (document.body ? document.body.innerText : ""))
        .then((text) => ui.isUsageLimitText(text || ""))
        .catch(() => false);
}

async function collectFailureDiagnostics(page) {
    try {
        const ready = await ui.isPromptReady(page);
        const text = await page
            .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300))
            .catch(() => "");
        return `(promptReady=${ready}, page: ${text || "(empty)"})`;
    } catch {
        return "";
    }
}

async function sendFinaleConfirmed(page, input, text, attempts = 3) {
    const marker = "TRANSMISSION COMPLETE - all";

    for (let attempt = 1; attempt <= attempts; attempt++) {
        console.log(`>> Sending TRANSMISSION COMPLETE (attempt ${attempt}/${attempts})...`);
        await waitForGenerationEnd(page);
        await ui.typePrompt(page, input, text);

        if (!(await composerHasContent(page, marker, marker.length))) {
            console.log(">> Composer missing TRANSMISSION COMPLETE text, repasting...");
            await ui.typePrompt(page, input, text);
            if (!(await composerHasContent(page, marker, marker.length))) {
                console.log(`>> Still missing after repaste (attempt ${attempt}/${attempts}).`);
                if (attempt < attempts) await page.waitForTimeout(3000);
                continue;
            }
        }

        await page.waitForTimeout(500);
        const userCountBefore = await ui.userMessages(page).count().catch(() => 0);
        await ui.trySend(page, ui.sendButton(page));

        // Confirm the click was actually accepted (user bubble +1, composer
        // cleared, or generation started). Clicking while a reply is still
        // generating is a no-op that leaves the composer full - without this
        // check we would burn the whole landing timeout on an unsent finale
        // and then mistake a stale per-part ack for the finale answer.
        const accepted = await ui.waitForSendAccepted(page, userCountBefore, 8000);
        if (!accepted) {
            console.log(`>> Finale send not accepted (attempt ${attempt}/${attempts}), retrying...`);
            await ui.dismissAndSettle(page, 500);
            continue;
        }

        // Send accepted (new user bubble / cleared composer / generation
        // started). That IS the delivery confirmation: unlike ChatGPT,
        // Gemini collapses user bubbles in the transcript ("You said ..."),
        // so the finale text is not reliably searchable in the DOM and a
        // transcript-text poll could never confirm even while Gemini was
        // already answering - causing duplicate finale resends. Brief settle
        // to let the bubble render, then proceed; the finale answer itself
        // is awaited by waitForAnswer via the post-finale baseline.
        await page.waitForTimeout(500);
        return true;
    }
    return false;
}

async function transmitPart(page, input, part, index, total) {
    const openTag = `[PAYLOAD PART ${index}/${total} chars=${part.length}]`;
    const closeTag = `[/PAYLOAD PART ${index}/${total}]`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        if (attempt > 1 && (await transcriptContainsCloseTag(page, closeTag))) {
            console.log(`>> Part ${index}/${total} is already in the transcript, treating as landed.`);
            return true;
        }

        process.stdout.write(`>> Sending part ${index}/${total} (${(part.length / 1024).toFixed(1)} KB)...`);
        await ui.typePrompt(page, input, part);

        if (!(await composerHasContent(page, closeTag, Math.floor(part.length * 0.9)))) {
            console.log(" composer incomplete, repasting...");
            await ui.typePrompt(page, input, part);
            if (!(await composerHasContent(page, closeTag, Math.floor(part.length * 0.9)))) {
                console.log(` still incomplete (attempt ${attempt}/2).`);
                continue;
            }
        }

        if (!(await ui.sendButtonUsable(page))) {
            console.log(" send button not enabled yet, waiting...");
            await waitForGenerationEnd(page);
        }

        const userBefore = await ui.userMessages(page).count().catch(() => 0);
        await ui.trySend(page, ui.sendButton(page));

        // Gemini collapses long user bubbles in the transcript ("You said
        // [TRANSMISSION HEADER] ... [PAYL..."), so the part close tag is not
        // searchable in the DOM and the close-tag landing poll below can
        // never confirm. Send-acceptance (new user bubble / cleared composer
        // / generation started) is the reliable landing signal instead -
        // then await the per-part "OK" ack before returning.
        const accepted = await ui.waitForSendAccepted(page, userBefore, 10000);
        if (accepted) {
            console.log(" accepted.");
            await waitForGenerationEnd(page);
            return true;
        }

        const landing = await waitForPartLanding(page, closeTag, 15000);
        if (landing.ok) {
            console.log(" landed.");
            await waitForGenerationEnd(page);
            return true;
        }

        console.log(` not confirmed (attempt ${attempt}/2)${landing.snippet ? `, last message starts: "${landing.snippet}"` : ""}.`);

        if (await looksLikeUsageLimit(page)) {
            const diag = await collectFailureDiagnostics(page);
            throw new Error(
                `Chunked transmission aborted: part ${index}/${total} was refused - this session hit a usage/context limit. Log in to lift it.${diag}`
            );
        }

        if (attempt < 2) {
            await page.waitForTimeout(8000);
            await ui.dismissAndSettle(page, 500);
        }
    }

    const diag = await collectFailureDiagnostics(page);
    const ceilingHint =
        index >= 2
            ? " If early parts landed but a later one persistently fails, the session likely hit the usage/context limit - log in to lift it."
            : "";
    throw new Error(`Chunked transmission aborted: part ${index}/${total} could not be delivered after retries. ${ceilingHint}${diag}`);
}

async function sendChunkedPayload(page, input, plan, finalQuestion) {
    console.log(`>> Starting chunked transmission of ${plan.totalParts} part(s)...`);
    let lastPartEnd = 0;
    for (let i = 0; i < plan.totalParts; i++) {
        // Adaptive pacing: sleep only the deficit below the minimum gap.
        // Normal parts take seconds (paste + ack cycle), so this is usually
        // skipped entirely - unlike the old fixed 3s pause after every part.
        const gap = Date.now() - lastPartEnd;
        if (lastPartEnd && gap < MIN_PART_GAP_MS) {
            await page.waitForTimeout(MIN_PART_GAP_MS - gap);
        }
        await transmitPart(page, input, plan.parts[i], i + 1, plan.totalParts);
        lastPartEnd = Date.now();
    }

    console.log(">> All parts delivered, sending TRANSMISSION COMPLETE + question...");
    const preFinaleCount = await ui.assistantMessages(page).count().catch(() => 0);
    const finale = buildTransmissionFinale(plan.totalParts, finalQuestion);
    const sent = await sendFinaleConfirmed(page, input, finale);
    if (!sent) {
        throw new Error(
            "TRANSMISSION COMPLETE could not be delivered after retries - the session likely stopped accepting messages. Check the browser window."
        );
    }
    console.log(">> TRANSMISSION COMPLETE confirmed.");
    // Snapshot immediately after acceptance - deliberately NO settle wait:
    // a fast finale answer may already be streaming, and waiting it out here
    // would absorb the real answer into the baseline (observed live with a
    // one-word answer completing inside the old settle window). Late
    // per-part acks are filtered by content in waitForAnswer instead
    // (looksLikePartAck), and the finale answer self-corrects via the
    // stabilization phase even if first seen partial.
    const settled = ui.assistantMessages(page);
    const postCount = await settled.count().catch(() => 0);
    const postText = postCount > 0 ? (await settled.last().innerText().catch(() => "")).trim() : "";
    console.log(`>> Post-finale baseline: ${postCount} replies (was ${preFinaleCount} before finale).`);
    // Include the finale text so waitForAnswer can resend it once if the
    // send was accepted but generation never starts (anonymous throttle).
    return { count: postCount, text: postText, finale };
}

async function looksLoggedOut(page) {
    return page
        .evaluate(() => {
            const text = document.body ? document.body.innerText : "";
            const url = window.location.href;
            return url.includes("accounts.google.com") || /sign in/i.test(text);
        })
        .catch(() => false);
}

async function sendQuestion(page, question, targetUrl, context) {
    console.log(">> Sending question via Gemini...");
    await gotoGemini(page, targetUrl);
    await page.waitForTimeout(2000);

    console.log(">> Opening Gemini...");
    let loggedIn = context ? await isLoggedInViaCookies(context) : null;
    if (loggedIn) console.log(">> Login detected via session cookie.");
    else if (loggedIn === false) console.log(">> Not logged in (no Gemini session cookie).");

    const settleDeadline = Date.now() + 5 * 60 * 1000;
    let lastNotice = 0;

    while (Date.now() < settleDeadline) {
        if (context) {
            loggedIn = await isLoggedInViaCookies(context);
        }

        await ui.dismissBlockingUI(page);

        if (await ui.isPromptReady(page)) break;

        if (Date.now() - lastNotice > 15000) {
            lastNotice = Date.now();
            const elapsed = Math.round((Date.now() - (settleDeadline - 5 * 60 * 1000)) / 1000);
            if (loggedIn) {
                console.log(`>> Logged in, waiting for the prompt to become ready... (${elapsed}s) url=${page.url()}`);
            } else if (isOnAuthPage(page)) {
                console.log(`>> Waiting for login... (${elapsed}s) Not logged in.`);
            } else {
                console.log(`>> Waiting for Gemini prompt... (${elapsed}s) url=${page.url()}`);
            }
        }
        await page.waitForTimeout(1000);
    }

    if (!(await ui.isPromptReady(page))) {
        const pageText = await page
            .evaluate(() => document.body.innerText.slice(0, 500))
            .catch(() => "");
        throw new Error(
            `Prompt input never became usable at ${page.url()}. Page text: ${pageText.replace(/\s+/g, " ").trim() || "(empty)"}. Run \`askweb --login\` to log in manually.`
        );
    }

    console.log(">> Prompt input detected, focusing...");
    const input = ui.promptInput(page);
    try {
        await input.click({ timeout: 10000, force: true });
    } catch {
        await ui.dismissAndSettle(page);
        await input.waitFor({ state: "visible", timeout: 15000 });
        await ui.waitForEnabled(page, input);
        await input.click({ timeout: 10000, force: true });
    }

    await page.waitForTimeout(500);
    console.log(">> Prompt input ready.");

    const assistantCountBefore = await ui.assistantMessages(page).count().catch(() => 0);

    const loggedInFinal = context ? await isLoggedInViaCookies(context) : !(await looksLoggedOut(page));
    if (!loggedInFinal) {
        console.log(">> Detected: not logged in. Upload features will be unavailable.");
    } else {
        console.log(">> Logged in.");
    }

    if (question.files && question.files.length > 0) {
        const fileNames = question.files.map((file) => file.name).join(", ");
        console.log(`>> Loaded ${question.files.length} file(s): ${fileNames}`);
        if (!loggedInFinal) {
            console.log(">> Not logged in - file upload is unavailable, using paste mode.");
        } else {
            try {
                await ui.attachFiles(page, question.files);
                console.log(`>> Attached ${question.files.length} file(s) via upload.`);
                await page.waitForTimeout(3000);
            } catch (error) {
                console.log(`>> Upload failed (${error.message || error}), falling back to paste.`);
                await ui.dismissAndSettle(page);
            }
        }
    }

    if (!(await ui.isPromptReady(page))) {
        await ui.dismissAndSettle(page);
    }

    const payload = buildFullPrompt(question);

    let deliveryPlan = null;
    let stagedAttachmentName = null;

    if (payload.length > SINGLE_PASTE_MAX) {
        console.log(
            `>> Payload is ${(payload.length / 1024).toFixed(1)} KB, above the ${Math.round(SINGLE_PASTE_MAX / 1024)} KB single-message budget.`
        );
        let staged = null;
        if (!loggedInFinal) {
            console.log(">> Not logged in - skipping upload attempts, going straight to chunked transmission.");
        } else {
            staged = stageTempPayload(payload);
        }
        if (staged) {
            try {
                await ui.attachFiles(page, [staged]);
                stagedAttachmentName = staged.name;
                question.deliveryMeta = { mode: "attachment", chars: payload.length };
                console.log(`>> Payload uploaded as a single attachment (${staged.name}).`);
                await page.waitForTimeout(3000);
            } catch (error) {
                console.log(`>> Single-file attachment failed (${error.message || error}), switching to chunked transmission.`);
                await ui.dismissAndSettle(page);
            }
        }
        if (!stagedAttachmentName) {
            const { plan, manualChunkSize } = buildGeminiDeliveryPlan(payload);
            deliveryPlan = plan;
            if (!loggedInFinal && deliveryPlan.totalParts > ANON_MAX_PARTS) {
                const maxKB = Math.round((ANON_MAX_PARTS * (ANON_PART_SIZE_CEILING - PART_TAG_OVERHEAD)) / 1024);
                throw new Error(
                    `Payload is ${(payload.length / 1024).toFixed(1)} KB - an anonymous chat can only receive about ${maxKB} KB in ${ANON_MAX_PARTS} part(s). Log in to lift this limit.`
                );
            }
            question.deliveryMeta = { mode: "chunked", parts: deliveryPlan.totalParts, chars: deliveryPlan.totalChars };
            console.log(
                `>> Chunked transmission planned: ${deliveryPlan.totalParts} part(s), ${(deliveryPlan.totalChars / 1024).toFixed(1)} KB total` +
                    (manualChunkSize ? ` (ASKWEB_CHUNK_SIZE=${manualChunkSize}).` : ", packed to the fewest messages possible.")
            );
        }
    }

    const finalInput = ui.promptInput(page);

    if (deliveryPlan) {
        const finalQuestion = question.text || "";
        const baseline = await sendChunkedPayload(page, finalInput, deliveryPlan, finalQuestion);
        console.log(`>> Chunked transmission complete (baseline: ${baseline.count} replies).`);
        return baseline;
    }

    const expectedParts = [];
    if (question.text) expectedParts.push(question.text.trim().slice(0, 60));
    if (question.files && question.files.length > 0) expectedParts.push("</file>");
    if (question.commandResults && question.commandResults.length > 0) {
        expectedParts.push('<command name="');
    }

    console.log(">> Writing prompt...");
    let verified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await ui.typePrompt(page, finalInput, payload);
        const typed = await ui.promptInput(page)
            .evaluate((el) => ("value" in el ? el.value : el.innerText || el.textContent || ""))
            .catch(() => "");
        if (expectedParts.every((part) => typed.includes(part))) {
            verified = true;
            break;
        }
        console.log(`>> Prompt text did not stick (attempt ${attempt}/3), retyping...`);
        await ui.dismissAndSettle(page, 500);
    }
    if (!verified) {
        try { await finalInput.click({ timeout: 10000, force: true }); } catch {}
    }

    console.log(">> Sending prompt...");
    await ui.pressSendAndConfirm(page);

    return assistantCountBefore;
}

const provider = {
    id: "gemini",
    name: "Gemini",
    url: GEMINI_URL,
    loginUrl: GEMINI_LOGIN_URL,
    conversationUrlRe: CONVERSATION_URL_RE,
    capabilities: {
        fileUpload: true,
        login: true,
        anonymousUsage: false,
    },

    navigate: gotoGemini,
    waitUntilReady: async (page, context) => {
        await gotoGemini(page, GEMINI_URL);
        await page.waitForTimeout(2000);
        console.log(">> Opening Gemini...");
        let loggedIn = context ? await isLoggedInViaCookies(context) : null;
        if (loggedIn) console.log(">> Login detected via session cookie.");
        else if (loggedIn === false) console.log(">> Not logged in (no Gemini session cookie).");

        const deadline = Date.now() + 5 * 60 * 1000;
        let lastNotice = 0;
        while (Date.now() < deadline) {
            if (context) {
                loggedIn = await isLoggedInViaCookies(context);
            }
            await ui.dismissBlockingUI(page);
            if (await ui.isPromptReady(page)) break;
            if (Date.now() - lastNotice > 15000) {
                lastNotice = Date.now();
                const elapsed = Math.round((Date.now() - (deadline - 5 * 60 * 1000)) / 1000);
                if (loggedIn) {
                    console.log(`>> Logged in, waiting for the prompt to become ready... (${elapsed}s) url=${page.url()}`);
                } else if (isOnAuthPage(page)) {
                    console.log(`>> Waiting for login... (${elapsed}s) Not logged in.`);
                } else {
                    console.log(`>> Waiting for Gemini prompt... (${elapsed}s) url=${page.url()}`);
                }
            }
            await page.waitForTimeout(1000);
        }

        if (!(await ui.isPromptReady(page))) {
            throw new Error(`Gemini prompt input never became usable at ${page.url()}. Run \`askweb --login\` to log in manually.`);
        }

        console.log(">> Prompt input detected, focusing...");
        const input = ui.promptInput(page);
        try {
            await input.click({ timeout: 10000, force: true });
        } catch {
            await ui.dismissAndSettle(page);
            await input.waitFor({ state: "visible", timeout: 15000 });
            await ui.waitForEnabled(page, input);
            await input.click({ timeout: 10000, force: true });
        }
        await page.waitForTimeout(500);
        console.log(">> Prompt input ready.");
        return input;
    },

    startPopupMonitor: (page) => ui.startPopupMonitor(page),
    isLoggedIn: isLoggedInViaCookies,
    isOnAuthPage,
    runLoginFlow: async (page, context) => {
        console.log(">> Starting login flow. Please log in with your Google account (up to 10 min)...");
        await gotoGemini(page, GEMINI_LOGIN_URL);
        await page.waitForTimeout(2000);

        const startTime = Date.now();
        const maxWait = 10 * 60 * 1000;

        while (Date.now() - startTime < maxWait) {
            await page.waitForTimeout(2000);
            const loggedInByCookie = context ? await isLoggedInViaCookies(context) : false;
            if (loggedInByCookie) {
                console.log(">> Login detected via session cookie. Session saved in the browser profile for future runs.");
                return;
            }
            await ui.dismissBlockingUI(page);
        }

        throw new Error("Login timed out after 10 minutes. Please try again.");
    },

    runLogoutFlow: async (page, context) => {
        console.log(">> Opening Gemini. Please log out manually...");
        await gotoGemini(page, GEMINI_URL);
        await page.waitForTimeout(2000);

        const startTime = Date.now();
        const maxWait = 10 * 60 * 1000;

        while (Date.now() - startTime < maxWait) {
            await page.waitForTimeout(2000);
            const loggedInByCookie = context ? await isLoggedInViaCookies(context) : false;
            if (!loggedInByCookie) {
                console.log(">> Logout detected via session cookie. Session cleared.");
                return;
            }
        }

        throw new Error("Logout timed out after 10 minutes. Please try again.");
    },

    promptInput: (page) => ui.promptInput(page),
    sendButton: (page) => ui.sendButton(page),
    stopButton: (page) => ui.stopButton(page),
    attachButton: (page) => ui.attachButton(page),
    fileInput: (page) => ui.fileInput(page),
    getAssistantMessages: (page) => ui.assistantMessages(page),
    getUserMessages: (page) => ui.userMessages(page),
    dismissBlockingUI: (page) => ui.dismissBlockingUI(page),
    dismissAndSettle: (page, ms) => ui.dismissAndSettle(page, ms),
    isPromptReady: (page) => ui.isPromptReady(page),
    waitForEnabled: (page, input) => ui.waitForEnabled(page, input),
    uploadOverlayVisible: (page) => ui.uploadOverlayVisible(page),
    isStopVisible: (page) => ui.isStopVisible(page),
    waitForGenerationEnd: (page) => ui.waitForGenerationEnd(page),

    canUploadFiles: () => true,
    attachFiles: (page, files) => ui.attachFiles(page, files),
    typePrompt: (page, input, text) => ui.typePrompt(page, input, text),
    sendPrompt: (page) => ui.pressSendAndConfirm(page),

    looksLoggedOut: (page) => looksLoggedOut(page),
    resetComposer: (page, targetUrl) => ui.dismissAndSettle(page),

    sendQuestion: (page, question, targetUrl, context) => sendQuestion(page, question, targetUrl || GEMINI_URL, context),
    waitForAnswer: (page, countBefore, options) => ui.waitForAnswer(page, countBefore, options),

    getConversationId: async (page) => {
        // The SPA updates the URL a moment after the answer completes, so
        // poll briefly like the ChatGPT provider does before falling back.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            const id = ui.extractConversationId(page.url());
            if (id) return id;
            await page.waitForTimeout(250);
        }
        return crypto.randomUUID();
    },

    getConversationTitle: async (page) => {
        const title = await page.title().catch(() => "");
        return title.replace(/\s*-\s*Gemini\s*$/i, "").trim() || null;
    },

    cleanup: () => {},
};

module.exports = provider;
registerProvider(provider);
