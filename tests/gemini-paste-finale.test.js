"use strict";

// Gemini regression tests (headless, mocked DOM):
// 1. typePrompt must paste large payloads into Gemini's contenteditable
//    composer. The old input.fill(text) hung (30s timeout) because fill()
//    only targets textarea/input elements - Gemini uses a contenteditable div.
// 2. isFreshAssistantAnswer must reject the stale per-part ack, mirroring the
//    ChatGPT finale-race fix (providers/gemini port).

const { chromium } = require("playwright");
const ui = require("../providers/gemini/ui");
const { buildCappedTransmissionPlan } = require("../lib/payload");

// Gemini composer cap (live-probed): input truncates at 32,001 chars.
const GEMINI_MAX_PART_CHARS = 29000;

let total = 0;
const failures = [];
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}

// Race a promise against a timeout so a fill()-style hang fails fast
// instead of stalling the suite for 30s+.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function composerDOM() {
    return `
        <div id="gem-composer" class="ql-editor" role="textbox" contenteditable="true"
             aria-label="Enter a prompt for Gemini" data-placeholder="Ask Gemini"
             style="display:block;width:400px;height:60px;overflow:auto;"></div>
        <button aria-label="Send message">Send</button>
        <div id="chat"></div>
    `;
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    try {
        // --- Part 1: large paste into a contenteditable composer ---
        await page.setContent(composerDOM());
        // ~45 KB part, shaped like a real transmission part with close tag.
        const body = `x = ${"0123456789abcdef".repeat(2800)}\n`;
        const part = `[PAYLOAD PART 1/3 chars=45000]\n${body}[/PAYLOAD PART 1/3]`;

        await withTimeout(ui.typePrompt(page, ui.promptInput(page), part), 60000, "typePrompt-45KB");
        check(
            "typePrompt pastes 45KB into contenteditable composer",
            await ui.composerHasContent(page, "[/PAYLOAD PART 1/3]", Math.floor(part.length * 0.9))
        );

        // --- Part 2: retyping clears previous content (no leftover) ---
        await withTimeout(ui.typePrompt(page, ui.promptInput(page), "hello"), 30000, "typePrompt-small");
        const typed = await ui.promptInput(page)
            .evaluate((el) => el.innerText || el.textContent || "")
            .catch(() => "");
        check("retype clears composer (exact small text)", typed.trim() === "hello");

        // --- Part 3: freshness predicate (finale-race port) ---
        const { isFreshAssistantAnswer } = ui;
        check("predicate exported", typeof isFreshAssistantAnswer === "function");
        const ACK_3 = "Got part 3/3. I have the complete code now.";
        const REAL = "Here is the review of index.js: ...";
        check(
            "already-present ack bubble is NOT fresh",
            isFreshAssistantAnswer({ count: 3, text: ACK_3 }, { count: 3, text: ACK_3, previousText: ACK_3 }) === false
        );
        check(
            "finale answer in a new bubble IS fresh",
            isFreshAssistantAnswer({ count: 4, text: REAL }, { count: 3, text: ACK_3, previousText: ACK_3 }) === true
        );
        check(
            "same count is never fresh",
            isFreshAssistantAnswer({ count: 3, text: REAL }, { count: 3, text: ACK_3, previousText: ACK_3 }) === false
        );
        check(
            "empty text is never fresh",
            isFreshAssistantAnswer({ count: 4, text: "" }, { count: 3, text: ACK_3, previousText: ACK_3 }) === false
        );

        // --- Part 4: chunked parts fit the Gemini composer cap ---
        // A 132 KB payload (the reported failing size) must be split so no
        // single part exceeds what the composer retains.
        const bigPayload = `tell me about this\n\n<file name="index.js" lang="js">\n\`\`\`js\n${"x = 0123456789abcdef\n".repeat(7000)}\`\`\`\n</file>`;
        const bigPlan = buildCappedTransmissionPlan(bigPayload, GEMINI_MAX_PART_CHARS);
        check(
            "132KB payload splits into composer-safe parts",
            bigPlan.totalParts > 1 && bigPlan.parts.every((p) => p.length <= 32001)
        );
        check(
            "capped plan preserves all payload chars",
            bigPlan.totalChars === bigPayload.length
        );
        // Small payloads keep minimal packing (single part, unchanged).
        const smallPlan = buildCappedTransmissionPlan("x".repeat(26000), GEMINI_MAX_PART_CHARS);
        check("26KB payload stays a single part", smallPlan.totalParts === 1);

        // --- Part 5: usage-limit text must ignore sidebar upsell ---
        const { isUsageLimitText } = ui;
        check("limit helper exported", typeof isUsageLimitText === "function");
        check(
            "sidebar Premium upsell is NOT a limit",
            isUsageLimitText("Gemini\n3.5 Flash-Lite\nSign in\nGoogle One AI Premium\nUpgrade for more") === false
        );
        check("rate limit IS a limit", isUsageLimitText("You have hit the rate limit. Try again later.") === true);
        check("quota IS a limit", isUsageLimitText("Quota exceeded for this session") === true);
        check("empty text is not a limit", isUsageLimitText("") === false);

        // --- Part 6: no-generation watchdog throws fast with guidance ---
        // Empty chat, nothing ever generates: with a tiny timeout the wait
        // must fail quickly (not hang) with the rate-limit guidance.
        await page.setContent(composerDOM());
        let watchdogError = null;
        try {
            await ui.waitForAnswer(page, 0, { noGenerationTimeoutMs: 1500 });
        } catch (e) {
            watchdogError = e;
        }
        check(
            "silent prompt fails fast with rate-limit guidance",
            !!watchdogError && /did not start generating/.test(watchdogError.message || "")
        );

        // --- Part 7: ack-shaped bubbles are classified, real answers are not ---
        const { looksLikePartAck } = ui;
        check("ack classifier exported", typeof looksLikePartAck === "function");
        check("bare OK is an ack", looksLikePartAck("OK") === true);
        check("OK with period is an ack", looksLikePartAck("OK.") === true);
        check(
            "Got part N/M is an ack",
            looksLikePartAck("Got part 3/5. I have the complete code now. What would you like me to do?") === true
        );
        check("filename answer is NOT an ack", looksLikePartAck("index.js") === false);
        check(
            "real review answer is NOT an ack",
            looksLikePartAck("Here is the review of index.js: the code looks good overall.") === false
        );
        check("empty text is not an ack", looksLikePartAck("") === false);

        // --- Part 7b: conversation-id extraction from Gemini URLs ---
        const { extractConversationId } = ui;
        check("id helper exported", typeof extractConversationId === "function");
        check(
            "hex app id extracted",
            extractConversationId("https://gemini.google.com/app/4d463cb902594888") === "4d463cb902594888"
        );
        check(
            "id with query string extracted",
            extractConversationId("https://gemini.google.com/app/cc8499ae130dfe07?hl=en") === "cc8499ae130dfe07"
        );
        check("bare /app yields null", extractConversationId("https://gemini.google.com/app") === null);
        check("short segment yields null", extractConversationId("https://gemini.google.com/app/xyz") === null);

        // --- Part 8: end-to-end ack-skip in waitForAnswer ---
        // Chat holds 2 ack bubbles (the baseline). A late "OK" arrives first
        // and must be skipped; the real answer arrives after and must resolve.
        await page.addInitScript(() => {
            let clipboard = "";
            Object.defineProperty(navigator, "clipboard", {
                value: {
                    writeText: async (text) => { clipboard = text; },
                    readText: async () => clipboard,
                },
                configurable: true,
            });
        });
        await page.goto("about:blank");
        await page.setContent(`
            <div id="chat">
                <model-response><div class="response-content">ACK-OLD</div></model-response>
                <model-response><div class="response-content">ACK-OLD</div></model-response>
            </div>
            <div id="gem-composer" role="textbox" contenteditable="true" aria-label="Enter a prompt for Gemini" style="display:block;width:400px;height:60px;"></div>
            <button aria-label="Stop" style="display:none">Stop</button>
        `);
        const skipLogs = [];
        const savedLog = console.log;
        console.log = (...args) => { skipLogs.push(args.join(" ")); };
        let skipResult = null;
        let skipError = null;
        try {
            const pending = ui.waitForAnswer(page, 2, {
                baseline: { count: 2, text: "ACK-OLD" },
                noGenerationTimeoutMs: 20000,
            });
            setTimeout(() => {
                page.evaluate(() => {
                    const el = document.createElement("model-response");
                    el.innerHTML = '<div class="response-content">OK</div>';
                    document.getElementById("chat").appendChild(el);
                }).catch(() => {});
            }, 800);
            setTimeout(() => {
                page.evaluate(() => {
                    const el = document.createElement("model-response");
                    el.innerHTML = '<div class="response-content">FINAL-ANSWER-UNIQUE</div><button id="copyFinal" aria-label="Copy">Copy</button>';
                    document.getElementById("chat").appendChild(el);
                    document.getElementById("copyFinal").addEventListener("click", () => {
                        navigator.clipboard.writeText("FINAL-ANSWER-UNIQUE");
                    });
                }).catch(() => {});
            }, 2000);
            skipResult = await withTimeout(pending, 30000, "ack-skip-e2e");
        } catch (e) {
            skipError = e;
        } finally {
            console.log = savedLog;
        }
        check(
            "late ack is skipped, finale answer resolves",
            !skipError && typeof skipResult === "string" && skipResult.includes("FINAL-ANSWER-UNIQUE")
        );
        check(
            "ack-skip logged the ignored ack",
            skipLogs.some((l) => l.includes("Ignoring per-part ack"))
        );

        // --- Part 9: copy-button scoping (answer-local first, page fallback) ---
        // Regression: the extractor once grabbed a stale ack's button via the
        // page-wide fallback because the fresh bubble's toolbar had not
        // mounted yet, copying "OK" instead of the real answer.
        await page.setContent(`
            <div id="chat">
                <model-response><div class="response-content">STALE-ACK</div><button id="copyStale" aria-label="Copy">Copy</button></model-response>
                <model-response><div class="response-content">FRESH-ANSWER</div><button id="copyFresh" aria-label="Copy">Copy</button></model-response>
            </div>
            <div role="textbox" contenteditable="true" aria-label="Enter a prompt for Gemini" style="display:block;width:400px;height:60px;"></div>
            <button aria-label="Stop" style="display:none">Stop</button>
        `);
        await page.evaluate(() => {
            document.getElementById("copyStale").addEventListener("click", () => {
                navigator.clipboard.writeText("STALE-ACK");
            });
            document.getElementById("copyFresh").addEventListener("click", () => {
                navigator.clipboard.writeText("FRESH-ANSWER");
            });
        });
        // NOTE: assistantMessages() matches both `model-response` and the
        // inner `.response-content`, so nth() indexing on it is unreliable.
        // Select bubbles via model-response directly (as the app does with
        // .last()).
        const freshAnswer = page.locator("model-response").nth(1);
        const extractedFresh = await withTimeout(
            ui.extractAnswerMarkdown(page, freshAnswer),
            20000,
            "extract-local-button"
        );
        check(
            "extraction prefers the answer-local copy button",
            typeof extractedFresh === "string" && extractedFresh.includes("FRESH-ANSWER")
        );

        // Fallback preserved: newest bubble has no toolbar yet AND the older
        // button lives outside its parent chain, so only the page-wide
        // phase-2 search (after the local patience window) may claim it.
        await page.setContent(`
            <div id="old-chat">
                <model-response><div class="response-content">STALE-ACK</div><button id="copyStale2" aria-label="Copy">Copy</button></model-response>
            </div>
            <div id="chat">
                <model-response><div class="response-content">FRESH-NO-TOOLBAR-YET</div></model-response>
            </div>
            <div role="textbox" contenteditable="true" aria-label="Enter a prompt for Gemini" style="display:block;width:400px;height:60px;"></div>
            <button aria-label="Stop" style="display:none">Stop</button>
        `);
        await page.evaluate(() => {
            document.getElementById("copyStale2").addEventListener("click", () => {
                navigator.clipboard.writeText("STALE-ACK");
            });
        });
        const toolbarless = page.locator("model-response").nth(1);
        const extractedFallback = await withTimeout(
            ui.extractAnswerMarkdown(page, toolbarless),
            20000,
            "extract-page-fallback"
        );
        check(
            "page-scope fallback still works when local toolbar absent",
            typeof extractedFallback === "string" && extractedFallback.includes("STALE-ACK")
        );
    } finally {
        await browser.close().catch(() => {});
    }

    console.log(`\n${total - failures.length}/${total} passed`);
    if (failures.length) {
        console.log("FAILURES: " + failures.join(", "));
        process.exit(1);
    }
    console.log("ALL TESTS PASSED");
})().catch((error) => {
    console.error("TEST ERROR:", error.message);
    process.exit(1);
});
