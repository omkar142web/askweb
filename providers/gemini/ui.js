"use strict";

const fs = require("fs");

const COMPOSER_SELECTORS = [
    '[aria-label="Enter a prompt for Gemini"]',
    'rich-textarea .ql-editor',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
    // Fallback: only match actual writable controls with "prompt" in aria-label.
    // Never match <a> links or other non-writable elements (e.g. nav items
    // like "HTML Template Improvement Prompts").
    'input[aria-label*="prompt" i], textarea[aria-label*="prompt" i], [contenteditable="true"][aria-label*="prompt" i]',
];

const SEND_BUTTON_SELECTORS = [
    'button[aria-label="Send message"]',
    'button.send-button',
    'button[aria-label*="Send" i]',
    'button[aria-label*="send" i]',
    'button[type="submit"]',
];

const STOP_BUTTON_SELECTORS = [
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Cancel" i]',
    '.stop-button',
    '[class*="stop"]',
];

const ASSISTANT_MESSAGE_SELECTORS = [
    'model-response',
    '.model-response-text',
    '.response-content',
    'message-content',
    '[data-message-author="assistant"]',
    '.response-container',
];

const USER_MESSAGE_SELECTORS = [
    'user-query',
    '.query-text',
    '.user-query',
    '[data-message-author="user"]',
    '.conversation-turn-user',
];

const ATTACH_BUTTON_SELECTORS = [
    'button[aria-label*="file" i]',
    'button[aria-label*="upload" i]',
    '.attachment-button',
    'input[type="file"]',
];

const COPY_BUTTON_SELECTORS = [
    'gem-icon-button button[aria-label="Copy"]',
    'button[aria-label="Copy"]:not([aria-label*="prompt" i]):not([aria-label*="code" i]):not([aria-label*="image" i])',
    'button[aria-label*="Copy" i]:not([aria-label*="prompt" i]):not([aria-label*="code" i]):not([aria-label*="image" i])',
    '[data-testid*="copy" i]:not([data-testid*="code" i]):not([data-testid*="image" i])',
];

const FILE_INPUT_SELECTOR = 'input[type="file"]';

const MODAL_OVERLAY_SELECTORS = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '[data-testid*="modal"]',
    '[data-testid*="dialog"]',
    '[data-testid*="popup"]',
    '.modal',
    '.overlay',
];

const SELECTORS = {
    promptInput: COMPOSER_SELECTORS,
    sendButton: SEND_BUTTON_SELECTORS,
    stopButton: STOP_BUTTON_SELECTORS,
    assistantMessage: ASSISTANT_MESSAGE_SELECTORS,
    userMessage: USER_MESSAGE_SELECTORS,
    attachButton: ATTACH_BUTTON_SELECTORS,
    fileInput: [FILE_INPUT_SELECTOR],
    copyButton: COPY_BUTTON_SELECTORS,
    messageBoundary: ['[data-message-author]', 'model-response', 'user-query', 'message-content'],
};

const selector = (name) => SELECTORS[name].join(", ");

const domIsVisible = (el) => {
    if (!el) return false;
    try {
        if (typeof el.checkVisibility === "function") {
            return el.checkVisibility({
                visibilityProperty: true,
                opacityProperty: true,
                sizeProperty: true,
            });
        }
    } catch (e) {}
    return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
};

const firstVisibleElement = (sel) => {
    return [...document.querySelectorAll(sel)].find(domIsVisible) || null;
};

const elementText = (el) => {
    if (!el) return "";
    return "value" in el ? el.value || "" : el.innerText || el.textContent || "";
};

const isUsableControl = (el) => {
    if (
        !!el &&
        !el.disabled &&
        !el.readOnly &&
        el.getAttribute("aria-disabled") !== "true" &&
        el.getAttribute("aria-hidden") !== "true"
    ) {
        // Only accept elements that can actually receive text input
        // (input, textarea, or contentEditable). Rejects <a>, <button>,
        // <div>, etc. that happen to match a broad selector.
        const tag = el.tagName.toLowerCase();
        return tag === "input" || tag === "textarea" || el.isContentEditable;
    }
    return false;
};

const PAGE_DOM_SOURCE = {
    firstVisibleElement: `(function(){const domIsVisible=${domIsVisible.toString()};return ${firstVisibleElement.toString()}})()`,
    domIsVisible: `(${domIsVisible.toString()})`,
    elementText: `(${elementText.toString()})`,
    isUsableControl: `(${isUsableControl.toString()})`,
};

const geminiDom = {
    selector,
    locator: (page, name) => page.locator(selector(name)),
    visible: (page, name) => page.locator(selector(name)).filter({ visible: true }).first(),
    visibleAll: (page, name) => page.locator(selector(name)).filter({ visible: true }),
    textLocator: (page, pattern) => page.getByText(pattern).first(),
    pageHelpers: () => PAGE_DOM_SOURCE,
    promptPayload: () => ({
        selector: selector("promptInput"),
        finderSource: PAGE_DOM_SOURCE.firstVisibleElement,
        textSource: PAGE_DOM_SOURCE.elementText,
        usableSource: PAGE_DOM_SOURCE.isUsableControl,
    }),
};

const promptInput = (page) => geminiDom.visible(page, "promptInput");
const sendButton = (page) => geminiDom.locator(page, "sendButton").first();
const stopButton = (page) => geminiDom.locator(page, "stopButton").first();
const attachButton = (page) => geminiDom.locator(page, "attachButton").first();
const fileInput = (page) => geminiDom.locator(page, "fileInput");
const assistantMessages = (page) => geminiDom.visibleAll(page, "assistantMessage");
const userMessages = (page) => geminiDom.locator(page, "userMessage");

const UPLOAD_OVERLAY_TEXT = /add\s+files|upload|attach/i;

async function isUploadOverlay(page) {
    const texts = Array.from(document.querySelectorAll("body *")).map((el) =>
        ((el.textContent || "").trim().slice(0, 200))
    );
    return texts.some((t) => UPLOAD_OVERLAY_TEXT.test(t));
}

function modalVisible(page) {
    return page.locator(MODAL_OVERLAY_SELECTORS.join(", ")).first().isVisible().catch(() => false);
}

async function dismissBlockingUI(page) {
    const overlay = await page
        .evaluate(
            ({ uploadText }) => {
                const text = document.body ? document.body.innerText : "";
                return new RegExp(uploadText).test(text);
            },
            { uploadText: UPLOAD_OVERLAY_TEXT.source }
        )
        .catch(() => false);

    if (overlay) {
        try {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(300);
        } catch {}
    }

    const modals = await page
        .locator(MODAL_OVERLAY_SELECTORS.join(", "))
        .filter({ visible: true })
        .count()
        .catch(() => 0);

    if (modals > 0) {
        try {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(300);
        } catch {}
    }

    return false;
}

async function dismissAndSettle(page, ms = 1000) {
    await dismissBlockingUI(page);
    await page.waitForTimeout(ms);
}

async function isPromptReady(page) {
    const input = promptInput(page);
    const count = await input.count().catch(() => 0);
    if (count === 0) return false;
    const modal = await modalVisible(page);
    if (modal) return false;
    // Verify the matched element is a writable input control
    // (not just any visible element matching the selector, e.g. <a> links)
    const writable = await page
        .evaluate(
            ({ selector, finderSource, usableSource }) => {
                const el = eval(finderSource)(selector);
                if (!el) return false;
                return eval(usableSource)(el);
            },
            geminiDom.promptPayload()
        )
        .catch(() => false);
    return writable;
}

async function waitForEnabled(page, input) {
    await page.waitForFunction(
        ({ selector, finderSource, usableSource }) => {
            const el = eval(finderSource)(selector);
            if (!el) return false;
            return eval(usableSource)(el) && (el.offsetParent !== null || el.tagName === "TEXTAREA");
        },
        geminiDom.promptPayload(),
        { timeout: 20000 }
    );
}

function startPopupMonitor(page, { intervalMs = 1000 } = {}) {
    let active = true;
    let timer = null;
    let tickCount = 0;

    async function tick() {
        if (!active) return;
        try {
            await dismissBlockingUI(page);
        } catch (error) {}
        tickCount++;
        if (active) {
            timer = setTimeout(tick, intervalMs);
            if (timer.unref) timer.unref();
        }
    }

    timer = setTimeout(tick, intervalMs);
    if (timer.unref) timer.unref();

    return {
        stop() {
            active = false;
            if (timer) clearTimeout(timer);
        },
        tickCount: () => tickCount,
    };
}

async function attachViaFileInput(page, files) {
    const inputs = fileInput(page);
    const count = await inputs.count().catch(() => 0);
    if (count === 0) throw new Error("no input[type=file] in DOM");

    for (let i = 0; i < count; i++) {
        try {
            await inputs.nth(i).setInputFiles(
                files.map((file) => file.fullPath),
                { timeout: 5000 }
            );
            await page.waitForTimeout(1500);
            return true;
        } catch (error) {
            continue;
        }
    }
    throw new Error("file input attach failed");
}

async function attachViaChooser(page, files) {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 6000 });
    await attachButton(page).click().catch(() => {});

    let chooser;
    try {
        chooser = await chooserPromise;
    } catch {
        throw new Error("file chooser not found");
    }

    await chooser.setFiles(files.map((file) => file.fullPath));
    await page.waitForTimeout(2000);
    return true;
}

async function attachFiles(page, files) {
    await dismissBlockingUI(page);
    try {
        await attachViaFileInput(page, files);
        return "file-input";
    } catch (inputError) {
        console.log(`>> Gemini file-input attach failed (${inputError.message || inputError}), trying chooser...`);
        try {
            await attachViaChooser(page, files);
            return "chooser";
        } catch (chooserError) {
            throw new Error(`all Gemini attach strategies failed: ${chooserError.message || chooserError}`);
        }
    }
}

async function clearComposer(page, input) {
    // input.fill("") hangs on contenteditable rich-text composers (Gemini's
    // .ql-editor div), so clear with select-all + delete, which works for
    // both contenteditable divs and plain textareas.
    try {
        await input.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
        await page.waitForTimeout(80);
        await input.press("Backspace");
        await page.waitForTimeout(120);
    } catch { /* fall through to the evaluate fallback below */ }
    if (!(await composerEmpty(page).catch(() => true))) {
        await promptInput(page)
            .evaluate((el) => {
                if ("value" in el) el.value = "";
                else el.innerHTML = "";
                el.dispatchEvent(new InputEvent("input", { bubbles: true }));
            })
            .catch(() => {});
    }
}

async function composerTextLength(page) {
    return promptInput(page)
        .evaluate((el) => ("value" in el ? el.value || "" : el.innerText || el.textContent || "").length)
        .catch(() => 0);
}

async function pasteViaClipboardKeys(page, input, text) {
    const copied = await page
        .evaluate((t) => navigator.clipboard.writeText(t), text)
        .then(() => true)
        .catch(() => false);
    if (!copied) return false;
    try {
        await input.click({ timeout: 5000, force: true });
    } catch { /* already focused from typePrompt */ }
    await page.waitForTimeout(200);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.waitForTimeout(80);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
    for (let check = 0; check < 8; check++) {
        await page.waitForTimeout(400);
        if ((await composerTextLength(page)) >= text.length * 0.7) return true;
    }
    return false;
}

async function pasteViaInsertText(page, text) {
    // Slice feed so a single huge insertion doesn't block the page; 2000
    // chars per slice with surrogate-pair-safe boundaries.
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(offset + 2000, text.length);
        const lastCode = text.charCodeAt(end - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff && end < text.length) end += 1;
        try {
            await page.keyboard.insertText(text.slice(offset, end));
        } catch {
            return false;
        }
        offset = end;
        await page.waitForTimeout(30);
    }
    return true;
}

async function typePrompt(page, input, text) {
    await dismissBlockingUI(page);
    try {
        await input.click({ timeout: 10000, force: true });
    } catch { /* visibility is verified via the paste check below */ }
    await clearComposer(page, input);

    if (text) {
        // Strategy 1: clipboard paste (fastest for 40+ KB parts). Never use
        // input.fill() here - it hangs on Gemini's contenteditable composer.
        let pasted = await pasteViaClipboardKeys(page, input, text);
        // Strategy 2: typed insertion in slices (covers contexts where the
        // async clipboard API is unavailable or denied).
        if (!pasted) {
            console.log(`>> Clipboard paste unavailable, typing ${(text.length / 1024).toFixed(1)} KB in slices...`);
            await clearComposer(page, input);
            pasted = await pasteViaInsertText(page, text);
        }
        if (pasted) {
            console.log(`>> Pasted ${(text.length / 1024).toFixed(1)} KB into Gemini composer.`);
        } else {
            console.log(`>> WARNING: Gemini composer paste could not be verified (${(text.length / 1024).toFixed(1)} KB).`);
        }
    }

    await page.waitForTimeout(400);
}

async function sendButtonUsable(page) {
    return page
        .evaluate(
            (sel) => {
                const btn = document.querySelector(sel);
                if (!btn) return false;
                return !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
            },
            selector("sendButton")
        )
        .catch(() => false);
}

async function trySend(page, sendBtn) {
    const count = await sendBtn.count().catch(() => 0);
    if (count > 0) {
        try {
            await sendBtn.click({ force: true });
        } catch {
            await page.keyboard.press("Enter");
        }
    } else {
        await page.keyboard.press("Enter");
    }
}

async function waitForSendAccepted(page, countBefore, timeoutMs) {
    return page
        .waitForFunction(
            ({ userSel, stopSel, promptSel, finderSource, textSource, before }) => {
                // Signal 1: a new user message appeared in the conversation.
                const msgs = document.querySelectorAll(userSel);
                if (msgs.length > before) return true;
                // Signal 2: the stop button became visible (Gemini shows a stop
                // button as soon as generation starts, replacing the send button).
                if (eval(finderSource)(stopSel)) return true;
                // Signal 3: the composer was cleared (the prompt text was
                // consumed by the send action).
                const input = eval(finderSource)(promptSel);
                if (input) {
                    const text = eval(textSource)(input);
                    if (text.trim().length === 0) return true;
                }
                return false;
            },
            {
                userSel: selector("userMessage"),
                stopSel: selector("stopButton"),
                promptSel: selector("promptInput"),
                finderSource: PAGE_DOM_SOURCE.firstVisibleElement,
                textSource: PAGE_DOM_SOURCE.elementText,
                before: countBefore,
            },
            { timeout: timeoutMs }
        )
        .then(() => true)
        .catch(() => false);
}

async function pressSendAndConfirm(page, timeoutMs = 8000) {
    const button = sendButton(page);
    const countBefore = await userMessages(page).count().catch(() => 0);
    console.log(">> Clicking send button...");
    await trySend(page, button);
    await page.waitForTimeout(1000);

    const sentDetected = await waitForSendAccepted(page, countBefore, timeoutMs);

    if (!sentDetected) {
        console.log(">> Send may have failed, retrying...");
        await dismissAndSettle(page);
        // Before re-clicking, check whether the first click silently succeeded.
        // Gemini can take a moment to render the user message element after the
        // send — the stop button appearing or the composer emptying are more
        // immediate and reliable signals than the user-message count.
        const alreadyAccepted = await waitForSendAccepted(page, countBefore, 3000);
        if (alreadyAccepted) {
            console.log(">> Send confirmed (initial click succeeded, detection was delayed).");
            return true;
        }
        await trySend(page, button);
        await page.waitForTimeout(1000);
        const retryResult = await waitForSendAccepted(page, countBefore, timeoutMs);
        if (retryResult) console.log(">> Send confirmed on retry.");
        else console.log(">> Send not confirmed after retry.");
        return retryResult;
    }
    console.log(">> Send confirmed.");
    return sentDetected;
}

async function waitForGenerationEnd(page, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    let noticed = false;
    while (Date.now() < deadline) {
        const visible = await stopButton(page).isVisible().catch(() => false);
        if (!visible) return true;
        if (!noticed) {
            console.log(">> Waiting for in-flight generation to settle...");
            noticed = true;
        }
        await page.waitForTimeout(750);
    }
    return false;
}

async function isStopVisible(page) {
    return stopButton(page).isVisible().catch(() => false);
}

async function composerEmpty(page) {
    return page
        .evaluate(
            ({ sel, finderSource, textSource }) => {
                const el = eval(finderSource)(sel);
                if (!el) return true;
                const text = "value" in el ? el.value : el.innerText || el.textContent || "";
                return text.trim().length < 5;
            },
            geminiDom.promptPayload()
        )
        .catch(() => false);
}

async function composerHasContent(page, needle, minLength) {
    return promptInput(page)
        .evaluate((el, { needle, minLength }) => {
            const text = "value" in el ? el.value : el.innerText || el.textContent || "";
            return text.includes(needle) && text.length >= minLength;
        }, { needle, minLength })
        .catch(() => false);
}

// Pure: does page text indicate a real usage/rate limit? NOTE: a bare
// "Premium"/"Upgrade" match is NOT enough - the Gemini sidebar permanently
// advertises premium plans, which used to cause bogus mid-transmission
// aborts. Require limit-context phrasing.
function isUsageLimitText(text) {
    if (!text) return false;
    return (
        /usage\s+(limit|cap)\b/i.test(text) ||
        /rate\s+limit/i.test(text) ||
        /too many requests/i.test(text) ||
        /\bquota\b/i.test(text) ||
        /try again (later|in \d+)/i.test(text) ||
        /something went wrong/i.test(text)
    );
}

async function transcriptContainsText(page, needle) {
    return page
        .evaluate(
            ({ userSel, needle }) => {
                const msgs = document.querySelectorAll(userSel);
                for (const msg of msgs) {
                    if ((msg.innerText || "").includes(needle)) return true;
                }
                return false;
            },
            { userSelector: selector("userMessage"), needle }
        )
        .catch(() => false);
}

// Exclude code-block copy buttons (aria-label contains "code"), image
// copy buttons (aria-label contains "image"), and prompt copy buttons
// (aria-label contains "prompt") so we only match the response-level
// copy button.
const GENERIC_COPY_BUTTON_FALLBACK = 'button[aria-label*="copy" i]:not([aria-label*="code" i]):not([aria-label*="image" i]):not([aria-label*="prompt" i])';

async function findCopyButton(page, answer) {
    const parent = answer.locator("xpath=..");
    // The copy button in Gemini lives inside <model-response> or
    // .response-container, but the answer element (MESSAGE-CONTENT) may
    // be nested deeper. Search answer → parent → model-response ancestor → page.
    const responseAncestor = answer.locator("xpath=ancestor::model-response").first();
    const scopes = [answer, parent, responseAncestor, page];
    // Tiers of selectors, most specific first
    const tiers = [
        selector("copyButton"),
        GENERIC_COPY_BUTTON_FALLBACK,
    ];
    for (const sel of tiers) {
        for (const scope of scopes) {
            // Use .first() rather than .last() so that when multiple copy buttons
            // match (e.g. code-block copy buttons alongside the response-level
            // copy button), we still pick the first match within the scope.
            // The GENERIC_COPY_BUTTON_FALLBACK excludes buttons whose aria-label
            // contains "code", "image", or "prompt", filtering out code-block
            // copy buttons and prompt copy buttons.
            const button = scope.locator(sel).first();
            if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
                const scopeName = scope === answer ? "answer" : scope === parent ? "parent" : scope === responseAncestor ? "response-ancestor" : "page";
                console.log(`>> Copy button found (scope: ${scopeName}).`);
                return button;
            }
        }
    }
    console.log(">> No visible copy button found in any tier.");
    return null;
}

async function extractAnswerMarkdown(page, answer, options = {}) {
    const {
        pollIntervalMs = 50,
        buttonPollDeadlineMs = 10000,
        clipboardPollDeadlineMs = 5000,
    } = options;

    console.log(">> Clearing clipboard for answer extraction...");
    await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});

    // Gemini hides copy buttons until hover (mat-badge-hidden, etc.).
    // Hover once to reveal them, then poll rapidly — no fixed wait — so
    // we trigger the copy action the instant the button becomes available.
    await answer.hover({ timeout: 2000, force: true }).catch(() => {});

    const buttonDeadline = Date.now() + buttonPollDeadlineMs;
    let copyButton = null;
    while (Date.now() < buttonDeadline) {
        copyButton = await findCopyButton(page, answer);
        if (copyButton) break;
        await page.waitForTimeout(pollIntervalMs);
    }

    if (!copyButton) {
        console.log(">> Copy button not found in answer block after polling.");
        return null;
    }

    console.log(">> Copy button found, clicking...");
    try {
        await copyButton.click({ timeout: 5000 });
    } catch {
        console.log(">> Copy button click failed, retrying with force...");
        try {
            await copyButton.click({ timeout: 3000, force: true });
        } catch {
            console.log(">> Copy button force-click failed, retrying with DOM click...");
            try {
                await copyButton.evaluate((button) => button.click());
            } catch {
                console.log(">> Copy button DOM click also failed.");
                return null;
            }
        }
    }

    // Poll the clipboard rapidly instead of a fixed post-click delay so we
    // return as soon as the copied content is available.
    const clipboardDeadline = Date.now() + clipboardPollDeadlineMs;
    let text = "";
    while (Date.now() < clipboardDeadline) {
        text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
        if (typeof text === "string" && text.trim()) break;
        await page.waitForTimeout(pollIntervalMs);
    }

    if (typeof text === "string" && text.trim()) {
        console.log(`>> Clipboard read successful (${text.length} chars).`);
    } else {
        console.log(">> Clipboard read returned empty content.");
    }
    return typeof text === "string" && text.trim() ? text : null;
}

// Pure: pull the conversation id out of a Gemini URL. Anonymous chats live
// at /app/<hex-id> (observed live: /app/4d463cb902594888); a bare /app or
// any other layout yields null and the caller falls back to a generated id.
function extractConversationId(url) {
    const m = (url || "").match(/\/app\/([a-f0-9]{8,64})/i);
    return m ? m[1] : null;
}

// Pure: does this bubble look like a per-part transmission ack rather than a
// real answer? The transmission header instructs the model to reply with ONLY
// "OK" per part (observed variants: "OK", "Got part N/M..."), so acks match a
// narrow shape. Used to skip late acks that would otherwise be extracted as
// the finale answer. Conservative on purpose: anything longer or off-pattern
// is treated as a genuine answer.
function looksLikePartAck(text) {
    const t = (text || "").trim();
    if (!t) return false;
    if (/^(ok|okay|got it|received|noted|acknowledged)[.!]?$/i.test(t)) return true;
    if (t.length <= 200 && /got\s+part\s+\d+\s*\/\s*\d+/i.test(t)) return true;
    if (t.length <= 200 && /part\s+\d+\s*\/\s*\d+\s*(received|ok|complete|done)/i.test(t)) return true;
    return false;
}

// Pure predicate: is the currently-visible last assistant bubble a genuinely
// new answer relative to a post-finale baseline snapshot? Mirrors the ChatGPT
// path in index.js (isFreshAssistantAnswer): after a chunked transmission a
// late per-part ack can land after the pre-finale count snapshot, so `count >
// countBefore` alone fires on the stale ack. Kept pure (no page access) so it
// is unit-testable.
function isFreshAssistantAnswer(seen, baseline) {
    if (!seen || !baseline) return false;
    if (typeof seen.count !== "number" || typeof baseline.count !== "number") return false;
    if (seen.count <= baseline.count) return false;
    if (!seen.text) return false;
    if (seen.text === baseline.text) return false;
    if (baseline.previousText && seen.text === baseline.previousText) return false;
    return true;
}

async function waitForAnswer(page, assistantCountBefore = 0, options = {}) {
    console.log(">> Waiting for answer to appear...");
    const replies = assistantMessages(page);
    const previousLastText = (await replies.last().innerText().catch(() => "")).trim();
    // Give up early (instead of the full 3-minute deadline) when generation
    // never even starts: an accepted send with no reply within this window
    // means the prompt was throttled/dropped, and polling longer cannot help.
    // With options.finale (chunked path) we resend once after a cooldown
    // first, since burst throttles are often time-based.
    const { noGenerationTimeoutMs = 60000, finale: finaleText = null } = options;
    let waitStart = Date.now();
    let retriedFinale = false;
    // Chunked path only: post-finale snapshot taken after the finale send was
    // accepted and late per-part acks settled (see sendChunkedPayload in
    // providers/gemini/index.js).
    const answerBaseline =
        options && options.baseline && typeof options.baseline.count === "number"
            ? { count: options.baseline.count, text: options.baseline.text || "", previousText: previousLastText }
            : null;
    if (answerBaseline) {
        console.log(`>> Waiting for a new answer after the finale (baseline: ${answerBaseline.count} replies).`);
    }

    const deadline = Date.now() + 3 * 60 * 1000;
    let sawGeneration = false;
    let ready = false;
    let lastProgressLog = 0;
    // Stall clock: any count/text change resets it. If only acks arrive and
    // the finale is never answered, fail honestly instead of hanging.
    const STALL_TIMEOUT_MS = 90000;
    let lastCount = await replies.count().catch(() => 0);
    let lastSeenText = previousLastText;
    let lastProgressAt = Date.now();

    while (Date.now() < deadline) {
        const stopVisible = await isStopVisible(page);
        if (stopVisible && !sawGeneration) {
            sawGeneration = true;
            console.log(">> Generation started (stop button visible).");
        }

        const count = await replies.count().catch(() => 0);
        const grew = count > assistantCountBefore;
        const newText = count > 0 ? (await replies.last().innerText().catch(() => "")).trim() : "";
        if (count !== lastCount || newText !== lastSeenText) {
            lastProgressAt = Date.now();
            lastCount = count;
            lastSeenText = newText;
        }

        const grewFresh =
            grew && answerBaseline ? isFreshAssistantAnswer({ count, text: newText }, answerBaseline) : grew;
        const fallbackFire =
            (sawGeneration || (await composerEmpty(page))) && !stopVisible && newText && newText !== previousLastText;
        const candidate = grewFresh || fallbackFire;

        if (candidate && answerBaseline && looksLikePartAck(newText)) {
            // A late per-part ack, not the finale answer: absorb it into the
            // baseline and keep waiting instead of extracting "OK" as final.
            console.log(`>> Ignoring per-part ack (replies: ${count}, ${newText.length} chars), still waiting for the finale answer...`);
            answerBaseline.count = count;
            answerBaseline.text = newText;
            answerBaseline.previousText = newText;
            assistantCountBefore = count;
            await page.waitForTimeout(700);
            continue;
        }

        if (candidate) {
            ready = true;
            const elapsed = ((Date.now() - (deadline - 3 * 60 * 1000)) / 1000).toFixed(1);
            console.log(`>> Answer appeared after ${elapsed}s (replies: ${count}, text length: ${newText.length}).`);
            break;
        }

        // The prompt was sent but Gemini never started generating (no stop
        // button, no new bubble, no text change). Observed after rapid
        // anonymous bursts: the send is accepted yet throttled server-side.
        // Resend the finale once after a cooldown - if the throttle was
        // time-based, the resend generates. Otherwise fail fast with
        // guidance instead of hanging until the deadline.
        if (!sawGeneration && Date.now() - waitStart > noGenerationTimeoutMs) {
            if (finaleText && !retriedFinale) {
                retriedFinale = true;
                console.log(">> No generation started - cooling down 30s, then resending the finale once...");
                await page.waitForTimeout(30000);
                await typePrompt(page, promptInput(page), finaleText);
                const userBefore = await userMessages(page).count().catch(() => 0);
                await trySend(page, sendButton(page));
                const resent = await waitForSendAccepted(page, userBefore, 10000);
                console.log(resent ? ">> Finale resent, waiting for generation..." : ">> Finale resend not accepted, continuing to wait...");
                waitStart = Date.now();
                continue;
            }
            throw new Error(
                "Gemini did not start generating within 60s of the sent prompt - the anonymous session was likely rate-limited after rapid sends. " +
                    "Wait a minute and retry (or `node index.js --continue`), or log in with `node index.js --login --provider gemini` to lift the limit."
            );
        }

        // Stall: only acks (or nothing new) for a long while, so the finale
        // was never answered. Fail honestly instead of hanging to the deadline.
        if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
            throw new Error(
                "Gemini stopped responding after the last message - the finale was likely never answered (anonymous burst limit). " +
                    "Wait a minute and retry (or `node index.js --continue`), or log in with `node index.js --login --provider gemini` to lift the limit."
            );
        }

        const now = Date.now();
        if (now - lastProgressLog > 10000) {
            lastProgressLog = now;
            const elapsed = Math.round((now - (deadline - 3 * 60 * 1000)) / 1000);
            const status = sawGeneration ? "generation in progress" : "waiting for response";
            console.log(`>> Still waiting for answer... (${elapsed}s elapsed, ${status}, replies: ${count}).`);
        }
        await page.waitForTimeout(700);
    }

    if (!ready) {
        throw new Error("No answer appeared - the final message may not have been accepted. Check the browser window.");
    }

    console.log(">> Answer received, waiting for generation to stabilize...");
    // Reduced from 3 to 2 polls: the stop button disappearing already strongly
    // signals completion, and 2 polls (0.8s) gives enough time for text to settle.
    const STABLE_POLLS_REQUIRED = 2;
    // Reduced from 500ms to 400ms for slightly faster response.
    const POLL_MS = 400;
    const stabStart = Date.now();
    let stableCount = 0;
    let textStableCount = 0;
    const answer = replies.last();
    await answer.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    let prevLength = (await answer.innerText().catch(() => "")).trim().length;

    const STABILIZATION_DEADLINE = Date.now() + 60 * 1000;
    let totalPolls = 0;
    while (stableCount < STABLE_POLLS_REQUIRED) {
        await page.waitForTimeout(POLL_MS);
        totalPolls += 1;

        const stopVisible = await isStopVisible(page);

        const text = await answer.innerText().catch(() => "");
        const lastLength = text.trim().length;

        const textStable = lastLength === prevLength && lastLength > 0;
        // Full stability requires text stability AND the stop button having
        // disappeared, which indicates generation has fully ended.
        const unchanged = textStable && !stopVisible;
        stableCount = unchanged ? stableCount + 1 : 0;
        textStableCount = textStable ? textStableCount + 1 : 0;
        prevLength = lastLength;

        if (!unchanged && totalPolls > 0 && totalPolls % 5 === 0) {
            console.log(`>> Still generating... (poll ${totalPolls}, current length: ${lastLength} chars, stop visible: ${stopVisible}).`);
        }

        // Early exit: if the stop button is no longer visible and text is non-empty,
        // generation has completed. No need to wait for text stability.
        if (!stopVisible && lastLength > 0) {
            console.log(`>> Stop button disappeared and text is non-empty (${lastLength} chars); treating generation as complete.`);
            break;
        }

        // If the text has been stable for 2+ consecutive polls but the stop
        // button is still visible, the generation has likely completed but
        // the UI hasn't hidden the stop button yet. Proceed using text-only
        // stability as the signal.
        if (textStableCount >= STABLE_POLLS_REQUIRED && stopVisible) {
            console.log(`>> Text stable for ${textStableCount} polls; stop button still visible, treating generation as complete.`);
            break;
        }

        // Hard deadline backstop: never hang indefinitely.
        if (Date.now() >= STABILIZATION_DEADLINE) {
            console.log(`>> Stabilization deadline reached after ${totalPolls} polls; proceeding with current text (${lastLength} chars).`);
            break;
        }
    }

    console.log(`>> Generation stable (${totalPolls} polls, final length: ${prevLength} chars, took ${Date.now() - stabStart}ms).`);
    // Re-resolve: another bubble may have arrived while stabilizing (e.g. the
    // finale answer landing just after a late per-part ack) - extracting from
    // the stale handle would copy the wrong message.
    const finalAnswer = replies.last();
    let markdown = await extractAnswerMarkdown(page, finalAnswer, options);
    if (!markdown) {
        throw new Error(
            "Failed to capture response via Gemini's Copy button — no fallback is configured. " +
            "Wait for the response to finish generating, then re-run."
        );
    }
    console.log(`>> Raw Markdown captured via copy button (${markdown.length} chars).`);
    return markdown;
}

module.exports = {
    SELECTORS,
    selector,
    geminiDom,
    PAGE_DOM_SOURCE,
    domIsVisible,
    firstVisibleElement,
    elementText,
    isUsableControl,
    promptInput,
    sendButton,
    stopButton,
    attachButton,
    fileInput,
    assistantMessages,
    userMessages,
    isUploadOverlay,
    uploadOverlayVisible: isUploadOverlay,
    dismissBlockingUI,
    dismissAndSettle,
    isPromptReady,
    waitForEnabled,
    startPopupMonitor,
    attachFiles,
    attachViaFileInput,
    attachViaChooser,
    typePrompt,
    sendButtonUsable,
    trySend,
    waitForSendAccepted,
    pressSendAndConfirm,
    isStopVisible,
    waitForGenerationEnd,
    composerEmpty,
    composerHasContent,
    isUsageLimitText,
    looksLikePartAck,
    extractConversationId,
    transcriptContainsText,
    isFreshAssistantAnswer,
    findCopyButton,
    extractAnswerMarkdown,
    waitForAnswer,
};
