"use strict";

const { chromium } = require("playwright");
const ui = require("../providers/gemini/ui");
const { selector } = ui;

const failures = [];
let total = 0;
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}

// Capture console.log output during an async call.
async function withLogCapture(promise) {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => { logs.push(args.join(" ")); };
    try {
        const result = await promise;
        return { result, logs };
    } finally {
        console.log = orig;
    }
}

// --- DOM fixtures ---

function baseDOM(options = {}) {
    const {
        composerText = "Hello Gemini",
        userMessages = [],
        assistantMessages = [],
        stopVisible = false,
        sendOnclick = "document.getElementById('stopBtn').style.display='block';document.getElementById('composer').value='';",
        delaySend = 0,
    } = options;

    let onclick = `window.sendClickCount=(window.sendClickCount||0)+1;${sendOnclick}`;
    if (delaySend > 0) {
        onclick = `window.sendClickCount=(window.sendClickCount||0)+1;setTimeout(function(){${sendOnclick}}, ${delaySend});`;
    }

    const userHTML = userMessages
        .map((text, i) => `<user-query id="uq-${i}">${text}</user-query>`)
        .join("");
    const assistantHTML = assistantMessages
        .map((text, i) => `<model-response id="ar-${i}"><div class="response-content">${text}</div></model-response>`)
        .join("");

    return `
        <textarea id="composer" aria-label="Enter a prompt for Gemini" style="display:block;width:400px;height:60px">${composerText}</textarea>
        <button aria-label="Send message" onclick="${onclick}">Send</button>
        <button id="stopBtn" aria-label="Stop" style="display:${stopVisible ? "block" : "none"};">Stop</button>
        <div id="chat">${userHTML}${assistantHTML}</div>
    `;
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // =====================================================================
    // Test 1: waitForSendAccepted detects via stop button visibility
    // =====================================================================
    await page.setContent(`<div id="app">${baseDOM({ composerText: "hi", stopVisible: false })}</div>`);

    const p1 = ui.waitForSendAccepted(page, 0, 5000);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        document.getElementById("stopBtn").style.display = "block";
    });
    const r1 = await p1;
    check("waitForSendAccepted: detects via stop button", r1 === true);

    // =====================================================================
    // Test 2: waitForSendAccepted detects via composer becoming empty
    // =====================================================================
    await page.setContent(`<div id="app">${baseDOM({ composerText: "hi", stopVisible: false })}</div>`);

    const p2 = ui.waitForSendAccepted(page, 0, 5000);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        document.getElementById("composer").value = "";
    });
    const r2 = await p2;
    check("waitForSendAccepted: detects via composer empty", r2 === true);

    // =====================================================================
    // Test 3: waitForSendAccepted detects via user message count increase
    // =====================================================================
    await page.setContent(`<div id="app">${baseDOM({ composerText: "hi", userMessages: ["previous"] })}</div>`);

    const before3 = await page.locator(selector("userMessage")).count();
    const p3 = ui.waitForSendAccepted(page, before3, 5000);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        const el = document.createElement("user-query");
        el.id = "new-uq";
        el.textContent = "new prompt";
        document.getElementById("chat").appendChild(el);
    });
    const r3 = await p3;
    check("waitForSendAccepted: detects via user message count", r3 === true);

    // =====================================================================
    // Test 4: pressSendAndConfirm confirms on FIRST attempt (no retry).
    // The onclick clears composer + shows stop button immediately.
    // =====================================================================
    await page.setContent(`<div id="app">${baseDOM({ composerText: "hi" })}</div>`);
    await page.evaluate(() => { window.sendClickCount = 0; });

    const { result: r4, logs: logs4 } = await withLogCapture(ui.pressSendAndConfirm(page, 5000));
    const clickCount4 = await page.evaluate(() => window.sendClickCount || 0);

    check("pressSendAndConfirm: returns true on first attempt", r4 === true);
    check("pressSendAndConfirm: does NOT log retry message", !logs4.some((l) => l.includes("Send may have failed")));
    check("pressSendAndConfirm: logs 'Send confirmed'", logs4.some((l) => l.includes("Send confirmed.")));
    check("pressSendAndConfirm: send button clicked once", clickCount4 === 1);

    // =====================================================================
    // Test 5: pressSendAndConfirm confirms via stop button only (no new
    // user message element added).  The old single-signal code would fail
    // here and retry; the new multi-signal code succeeds on first try.
    // =====================================================================
    await page.setContent(`<div id="app">${baseDOM({ composerText: "hi", userMessages: [] })}</div>`);
    await page.evaluate(() => { window.sendClickCount = 0; });

    const { result: r5, logs: logs5 } = await withLogCapture(ui.pressSendAndConfirm(page, 5000));
    const clickCount5 = await page.evaluate(() => window.sendClickCount || 0);

    check("pressSendAndConfirm (stop-btn only): returns true", r5 === true);
    check("pressSendAndConfirm (stop-btn only): does NOT retry", !logs5.some((l) => l.includes("Send may have failed")));
    check("pressSendAndConfirm (stop-btn only): clicked once", clickCount5 === 1);

    // =====================================================================
    // Test 6: pressSendAndConfirm delayed detection — first click worked
    // but DOM changes happen AFTER the first attempt's timeout.  The pre-
    // retry check should catch it WITHOUT a second send click.
    // =====================================================================
    await page.setContent(`<div id="app">${baseDOM({ composerText: "hi", delaySend: 3500 })}</div>`);
    await page.evaluate(() => { window.sendClickCount = 0; });

    const { result: r6, logs: logs6 } = await withLogCapture(ui.pressSendAndConfirm(page, 2000));
    const clickCount6 = await page.evaluate(() => window.sendClickCount || 0);

    check("pressSendAndConfirm (delayed): returns true", r6 === true);
    check("pressSendAndConfirm (delayed): uses delayed detection path", logs6.some((l) => l.includes("detection was delayed")));
    check("pressSendAndConfirm (delayed): NO second send click", clickCount6 === 1);

    // =====================================================================
    // Test 7: waitForAnswer does NOT treat a stale same-text response as new.
    // An existing message with text "Old response text" is present; count (1)
    // is greater than assistantCountBefore (0) but contentFresh is false
    // because newText === previousLastText.  Only a genuinely new message
    // (with different text) should be detected.
    // =====================================================================
    await page.setContent(`
        <div id="app">
            <model-response><div class="response-content">Old response text</div></model-response>
            <textarea id="composer" aria-label="Enter a prompt for Gemini" style="display:block"></textarea>
            <button aria-label="Stop" style="display:none">Stop</button>
        </div>
    `);

    const answerPromise = ui.waitForAnswer(page, 0);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const el = document.createElement("model-response");
        el.innerHTML = '<div class="response-content">Brand new response</div>';
        document.getElementById("app").appendChild(el);
    });
    const answer7 = await answerPromise;
    check("waitForAnswer: detects genuinely new response after stale present", answer7.includes("Brand new response"));

    // =====================================================================
    // Test 8: waitForAnswer detects new response when count grows
    // =====================================================================
    await page.setContent(`
        <div id="app">
            <model-response><div class="response-content">Previous answer</div></model-response>
            <textarea id="composer" aria-label="Enter a prompt for Gemini" style="display:block"></textarea>
        </div>
    `);

    const answerPromise2 = ui.waitForAnswer(page, 1);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
        const el = document.createElement("model-response");
        el.innerHTML = '<div class="response-content">This is the new answer</div>';
        document.getElementById("app").appendChild(el);
    });
    const answer8 = await answerPromise2;
    check("waitForAnswer: detects new response when count grew", answer8.includes("This is the new answer"));

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
