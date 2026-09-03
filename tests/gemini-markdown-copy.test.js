"use strict";

const { chromium } = require("playwright");
const ui = require("../providers/gemini/ui");

const failures = [];
let total = 0;
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}

const MARKDOWN_TEXT = "# Heading\n\n**Bold** and *italic* text.\n\n- item one\n- item two\n\n1. first\n2. second\n\n```js\nconst x = 1;\n```\n";

// Installs a clipboard mock that records writeText calls and returns them
// on the next readText. Must be called after every setContent/.goto.
async function installClipboardMock(page) {
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
}

function renderGeminiResponse(options = {}) {
    const {
        markdown = MARKDOWN_TEXT,
        copyButton = true,
        copyButtonLabel = "Copy",
        copyButtonId = "copyBtn",
        copyText = markdown,
    } = options;
    const btnHtml = copyButton
        ? `<button id="${copyButtonId}" aria-label="${copyButtonLabel}">Copy</button>`
        : "";
    return `
        <div id="app">
            <model-response>
                <div class="response-content">${markdown}</div>
                ${btnHtml}
            </model-response>
            <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
            <button aria-label="Stop" style="display:none">Stop</button>
        </div>
    `;
}

// Wire a button's click handler so it writes the given text to the mock clipboard
function wireCopyButton(page, buttonId, copyText) {
    return page.evaluate(({ id, text }) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener("click", () => {
                navigator.clipboard.writeText(text);
            });
        }
    }, { id: buttonId, text: copyText });
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await installClipboardMock(page);

    // =================================================================
    // Test 1: findCopyButton locates a visible copy button near the answer
    // =================================================================
    await page.setContent(`<div id="app">${renderGeminiResponse()}</div>`);
    await page.evaluate(() => {
        window.__lastClipboardWrite = "";
        navigator.clipboard.writeText = (text) => { window.__lastClipboardWrite = text; };
        navigator.clipboard.readText = async () => window.__lastClipboardWrite;
    });
    const answer1 = ui.assistantMessages(page).last();
    const copyBtn = await ui.findCopyButton(page, answer1);
    check("findCopyButton: locates visible copy button", !!copyBtn);

    // =================================================================
    // Test 2: extractAnswerMarkdown clicks copy button and reads clipboard
    // =================================================================
    await page.setContent(`<div id="app">${renderGeminiResponse({ copyText: "# Heading\n\n**Bold**\n" })}</div>`);
    await page.evaluate(() => {
        let clipboard = "";
        navigator.clipboard.writeText = async (text) => { clipboard = text; };
        navigator.clipboard.readText = async () => clipboard;
    });
    await wireCopyButton(page, "copyBtn", "# Heading\n\n**Bold**\n");
    const answer2 = ui.assistantMessages(page).last();
    const extracted = await ui.extractAnswerMarkdown(page, answer2);
    check("extractAnswerMarkdown: returns clipboard content after click", typeof extracted === "string" && extracted.startsWith("# Heading"));

    // =================================================================
    // Test 3: extractAnswerMarkdown returns null when no copy button
    // =================================================================
    await page.setContent(`<div id="app">${renderGeminiResponse({ copyButton: false })}</div>`);
    await page.evaluate(() => {
        let clipboard = "";
        navigator.clipboard.writeText = async (text) => { clipboard = text; };
        navigator.clipboard.readText = async () => clipboard;
    });
    const answer3 = ui.assistantMessages(page).last();
    const extracted3 = await ui.extractAnswerMarkdown(page, answer3, { buttonPollDeadlineMs: 300 });
    check("extractAnswerMarkdown: returns null when copy button absent", extracted3 === null);

    // =================================================================
    // Test 4: waitForAnswer throws when copy button is unavailable (no fallback)
    // =================================================================
    await page.setContent(`<div id="app">${renderGeminiResponse({ copyButton: false })}</div>`);
    await page.evaluate(() => {
        let clipboard = "";
        navigator.clipboard.writeText = async (text) => { clipboard = text; };
        navigator.clipboard.readText = async () => clipboard;
    });
    const result4Promise = ui.waitForAnswer(page, 0, { buttonPollDeadlineMs: 300 });
    let threw4 = false;
    try {
        await result4Promise;
    } catch (e) {
        threw4 = true;
    }
    check("waitForAnswer: throws when copy button unavailable (no fallback)", threw4);

    // =================================================================
    // Test 5: waitForAnswer uses copy button when present
    // =================================================================
    await page.setContent(`<div id="app">${renderGeminiResponse({ copyText: "# Markdown from copy button\n" })}</div>`);
    await page.evaluate(() => {
        let clipboard = "";
        navigator.clipboard.writeText = async (text) => { clipboard = text; };
        navigator.clipboard.readText = async () => clipboard;
    });
    await wireCopyButton(page, "copyBtn", "# Markdown from copy button\n");
    const result5 = await ui.waitForAnswer(page, 0);
    check("waitForAnswer: uses copy button when present", typeof result5 === "string" && result5.includes("# Markdown from copy button"));

    // =================================================================
    // Test 6: findCopyButton picks response copy button, NOT code-block
    // copy button, when both are present inside the answer
    // =================================================================
    await page.setContent(`
        <div id="app">
            <model-response>
                <div class="response-content">
                    <p>Some text.</p>
                    <pre><code>const x = 1;</code>
                    <button aria-label="Copy code">Copy code</button>
                    </pre>
                    <button id="responseCopy" aria-label="Copy">Copy</button>
                </div>
            </model-response>
            <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
            <button aria-label="Stop" style="display:none">Stop</button>
        </div>
    `);
    await page.evaluate(() => {
        let clipboard = "";
        navigator.clipboard.writeText = async (text) => { clipboard = text; };
        navigator.clipboard.readText = async () => clipboard;
    });
    await wireCopyButton(page, "responseCopy", "# Response Markdown\n");
    await page.evaluate(() => {
        const codeBtn = document.querySelector('button[aria-label="Copy code"]');
        if (codeBtn) {
            codeBtn.addEventListener("click", () => {
                navigator.clipboard.writeText("const x = 1;");
            });
        }
    });
    const answer6 = ui.assistantMessages(page).last();
    const copyBtn6 = await ui.findCopyButton(page, answer6);
    check("findCopyButton: locates response copy button when code-block copy button also present", !!copyBtn6);

    const result6 = await ui.extractAnswerMarkdown(page, answer6);
    check("extractAnswerMarkdown: extracts response Markdown (not code-block)", typeof result6 === "string" && result6 === "# Response Markdown\n");

    // =================================================================
    // Test 7: extractAnswerMarkdown picks copy button from the target
    // answer when multiple responses have copy buttons
    // =================================================================
    await page.setContent(`
        <div id="app">
            <model-response>
                <div class="response-content">Previous response</div>
                <button aria-label="Copy" id="oldCopy">Copy</button>
            </model-response>
            <model-response>
                <div class="response-content">${MARKDOWN_TEXT}</div>
                <button aria-label="Copy" id="newCopy">Copy</button>
            </model-response>
            <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
            <button aria-label="Stop" style="display:none">Stop</button>
        </div>
    `);
    await page.evaluate(() => {
        let clipboard = "";
        navigator.clipboard.writeText = async (text) => { clipboard = text; };
        navigator.clipboard.readText = async () => clipboard;
    });
    await wireCopyButton(page, "oldCopy", "Old response text\n");
    await wireCopyButton(page, "newCopy", "New response Markdown\n");
    const answer7 = ui.assistantMessages(page).last();
    const result7 = await ui.extractAnswerMarkdown(page, answer7);
    check("extractAnswerMarkdown: picks copy button from the target answer, not previous", typeof result7 === "string" && result7 === "New response Markdown\n");

    await browser.close();

    console.log(`\n${total - failures.length}/${total} passed`);
    if (failures.length) {
        console.log("FAILURES: " + failures.join(", "));
        process.exit(1);
    }
    console.log("ALL TESTS PASSED");
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
