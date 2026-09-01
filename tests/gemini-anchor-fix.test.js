const { chromium } = require("playwright");
const ui = require("../providers/gemini/ui");
const { selector } = ui;

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // --- Test 1: isUsableControl rejects <a> but accepts textarea ---
    await page.setContent(`
        <a href="/templates" aria-label="HTML Template Improvement Prompts" style="display:block">Templates</a>
        <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
    `);

    const ctrlResult = await page.evaluate(
        (isUsableControlSrc) => {
            const isUsableControl = eval(isUsableControlSrc);
            const anchor = document.querySelector('a[aria-label*="prompt" i]');
            const textarea = document.querySelector('textarea[aria-label*="prompt" i]');
            return {
                anchorTag: anchor ? anchor.tagName : "not found",
                anchorUsable: isUsableControl(anchor),
                textareaTag: textarea ? textarea.tagName : "not found",
                textareaUsable: isUsableControl(textarea),
            };
        },
        ui.PAGE_DOM_SOURCE.isUsableControl
    );

    console.log("Test 1 - isUsableControl results:", JSON.stringify(ctrlResult, null, 2));
    if (ctrlResult.anchorUsable === true) {
        console.error("FAIL: anchor should NOT be usable");
        process.exit(1);
    }
    if (ctrlResult.textareaUsable !== true) {
        console.error("FAIL: textarea should be usable");
        process.exit(1);
    }
    console.log("PASS: anchor rejected, textarea accepted\n");

    // --- Test 2: isPromptReady returns false when only an <a> with no modal ---
    await page.setContent(`
        <a href="/templates" aria-label="HTML Template Improvement Prompts" style="display:block">Templates</a>
    `);
    const ready2 = await ui.isPromptReady(page);
    console.log("Test 2 - isPromptReady (only anchor, no modal):", ready2);
    if (ready2 !== false) {
        console.error("FAIL: isPromptReady should return false for anchor-only DOM");
        process.exit(1);
    }
    console.log("PASS: isPromptReady correctly rejected anchor-only DOM\n");

    // --- Test 3: isPromptReady returns true when real textarea present ---
    await page.setContent(`
        <a href="/templates" aria-label="HTML Template Improvement Prompts" style="display:block">Templates</a>
        <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
    `);
    const ready3 = await ui.isPromptReady(page);
    console.log("Test 3 - isPromptReady (textarea + anchor, no modal):", ready3);
    if (ready3 !== true) {
        console.error("FAIL: isPromptReady should return true when a real textarea is present");
        process.exit(1);
    }
    console.log("PASS: isPromptReady correctly detected real textarea\n");

    // --- Test 4: isPromptReady returns false when modal is present ---
    await page.setContent(`
        <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
        <div role="dialog" aria-modal="true" style="display:block">Modal content</div>
    `);
    const ready4 = await ui.isPromptReady(page);
    console.log("Test 4 - isPromptReady (textarea + modal):", ready4);
    if (ready4 !== false) {
        console.error("FAIL: isPromptReady should return false when modal present");
        process.exit(1);
    }
    console.log("PASS: isPromptReady correctly blocked on modal\n");

    // --- Test 5: typePrompt should not crash on the textarea ---
    await page.setContent(`
        <a href="/templates" aria-label="HTML Template Improvement Prompts" style="display:block">Templates</a>
        <textarea aria-label="Enter a prompt for Gemini" style="display:block;width:100px;height:40px"></textarea>
    `);
    const input = ui.promptInput(page);
    await ui.typePrompt(page, input, "Hello Gemini!");
    const typed = await page.$eval('textarea[aria-label="Enter a prompt for Gemini"]', (el) => el.value);
    console.log("Test 5 - typePrompt typed:", JSON.stringify(typed));
    if (typed !== "Hello Gemini!") {
        console.error("FAIL: typePrompt did not fill the textarea correctly");
        process.exit(1);
    }
    console.log("PASS: typePrompt filled textarea correctly\n");

    await browser.close();
    console.log("ALL TESTS PASSED");
    process.exit(0);
})();
