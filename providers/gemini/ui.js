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

async function typePrompt(page, input, text) {
    await dismissBlockingUI(page);
    await input.click({ timeout: 10000, force: true });
    await input.fill("");

    if (text) {
        await input.fill(text);
        await page.waitForTimeout(400);
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

async function waitForAnswer(page, assistantCountBefore = 0) {
    console.log(">> Waiting for answer to appear...");
    const replies = assistantMessages(page);
    const previousLastText = (await replies.last().innerText().catch(() => "")).trim();

    const deadline = Date.now() + 3 * 60 * 1000;
    let sawGeneration = false;
    let ready = false;
    let lastProgressLog = 0;

    while (Date.now() < deadline) {
        const stopVisible = await isStopVisible(page);
        if (stopVisible && !sawGeneration) {
            sawGeneration = true;
            console.log(">> Generation started (stop button visible).");
        }

        const count = await replies.count().catch(() => 0);
        const grew = count > assistantCountBefore;
        const newText = count > 0 ? (await replies.last().innerText().catch(() => "")).trim() : "";

        if (grew || ((sawGeneration || (await composerEmpty(page))) && !stopVisible && newText && newText !== previousLastText)) {
            ready = true;
            const elapsed = ((Date.now() - (deadline - 3 * 60 * 1000)) / 1000).toFixed(1);
            console.log(`>> Answer appeared after ${elapsed}s (replies: ${count}, text length: ${newText.length}).`);
            break;
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
    const STABLE_POLLS_REQUIRED = 3;
    const POLL_MS = 1000;
    let stableCount = 0;
    let textStableCount = 0;
    let prevLength = -1;
    const answer = replies.last();
    await answer.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});

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

        // If the text has been stable for 3+ consecutive polls but the stop
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

    console.log(`>> Generation stable (${totalPolls} polls, final length: ${prevLength} chars).`);
    return await answer.innerText().catch(() => "");
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
    transcriptContainsText,
    waitForAnswer,
};
