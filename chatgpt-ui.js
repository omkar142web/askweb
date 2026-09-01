#!/usr/bin/env node

"use strict";

const COMPOSER_SELECTORS = [
    "#mobile-composer-prompt",
    "#prompt-textarea",
    'textarea[aria-label="Chat with ChatGPT"]',
    'textarea[placeholder="Ask ChatGPT"]',
    '[contenteditable="true"][role="textbox"]',
];

const SEND_BUTTON_SELECTORS = [
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
];

const STOP_BUTTON_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
];

const ATTACH_BUTTON_SELECTORS = [
    '[data-testid="composer-plus-btn"]',
    'button[aria-label="Add files and more"]',
];

const COPY_BUTTON_SELECTORS = [
    '[data-testid="copy-turn-action-button"]',
    'button[aria-label="Copy response"]',
];

const ASSISTANT_MESSAGE_SELECTORS = [
    '[data-message-author-role="assistant"]',
    '[class*="_assistantMessage"]:not([class*="Actions"])',
];

const USER_MESSAGE_SELECTORS = [
    '[data-message-author-role="user"]',
    '[class*="_userMessageGroup"]',
    '[class*="_userMessage"]:not([class*="Actions"])',
];

const FILE_MENU_BUTTON_SELECTORS = ["[role=menuitem]", "[role=menu] button", "[role=dialog] button"];

const FILE_INPUT_SELECTOR = 'input[type="file"]';

const UPLOAD_PROGRESS_SELECTORS = ["[role=progressbar]", ".animate-spin"];

const MESSAGE_BOUNDARY_SELECTOR = "[data-message-author-role]";

const SELECTORS = {
    promptInput: COMPOSER_SELECTORS,
    sendButton: SEND_BUTTON_SELECTORS,
    stopButton: STOP_BUTTON_SELECTORS,
    attachButton: ATTACH_BUTTON_SELECTORS,
    copyButton: COPY_BUTTON_SELECTORS,
    assistantMessage: ASSISTANT_MESSAGE_SELECTORS,
    userMessage: USER_MESSAGE_SELECTORS,
    fileMenuButton: FILE_MENU_BUTTON_SELECTORS,
    fileInput: [FILE_INPUT_SELECTOR],
    uploadProgress: UPLOAD_PROGRESS_SELECTORS,
    messageBoundary: [MESSAGE_BOUNDARY_SELECTOR],
};

const selector = (name) => SELECTORS[name].join(", ");

const POPUP_DISMISS_PATTERNS = [
    { text: /stay\s*logged\s*out/i, label: "Stay logged out" },
    { text: /continue\s+logged\s*out/i, label: "Continue logged out" },
    { text: /use\s+without\s+signing\s*in/i, label: "Use without signing in" },
    { text: /use\s+chatgpt\s+without\s+an?\s+account/i, label: "Use ChatGPT without an account" },
    { text: /continue\s+without\s+an?\s+account/i, label: "Continue without an account" },
    { text: /continue\s+without\s+signing\s*in/i, label: "Continue without signing in" },
    { text: /not\s+now/i, label: "Not now" },
    { text: /maybe\s+later/i, label: "Maybe later" },
    { text: /^skip$/i, label: "Skip" },
    { text: /^close$/i, label: "Close" },
    { text: /^no\s+thanks$/i, label: "No thanks" },
    { text: /^accept\s*all\s*(cookies)?$/i, label: "Accept all cookies" },
    { text: /^got\s*it$/i, label: "Got it" },
    { text: /^dismiss$/i, label: "Dismiss" },
];

const UPLOAD_OVERLAY_TEXT = /add\s+anything/i;

function domIsVisible(el) {
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
}

function firstVisibleElement(selector) {
    return [...document.querySelectorAll(selector)].find(domIsVisible) || null;
}

function elementText(el) {
    if (!el) return "";
    return "value" in el ? el.value || "" : el.innerText || el.textContent || "";
}

function isUsableControl(el) {
    return (
        !!el &&
        !el.disabled &&
        !el.readOnly &&
        el.getAttribute("aria-disabled") !== "true" &&
        el.getAttribute("aria-hidden") !== "true"
    );
}

const PAGE_DOM_SOURCE = {
    firstVisibleElement: `(function(){const domIsVisible=${domIsVisible.toString()};return ${firstVisibleElement.toString()}})()`,
    domIsVisible: `(${domIsVisible.toString()})`,
    elementText: `(${elementText.toString()})`,
    isUsableControl: `(${isUsableControl.toString()})`,
};

const CHATGPT_DOM = {
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

const promptInput = (page) => CHATGPT_DOM.visible(page, "promptInput");
const sendButton = (page) => CHATGPT_DOM.locator(page, "sendButton").first();
const stopButton = (page) => CHATGPT_DOM.locator(page, "stopButton").first();
const attachButton = (page) => CHATGPT_DOM.locator(page, "attachButton").first();
const fileInput = (page) => CHATGPT_DOM.locator(page, "fileInput");
const assistantMessages = (page) => CHATGPT_DOM.visibleAll(page, "assistantMessage");
const userMessages = (page) => CHATGPT_DOM.locator(page, "userMessage");

const CLOSE_CONTROL_NAME = /^(close|dismiss|skip|no\s+thanks|cancel|got\s*it)\b/i;
const DISMISS_CTA_NAME = new RegExp(POPUP_DISMISS_PATTERNS.map((p) => p.text.source).join("|"), "i");
const CLOSE_ATTR_TOKEN = /close|dismiss|skip/i;

const AUTH_TEXT_SIGNALS =
    "sign\\s*in|log\\s*in|log\\s*out|sign\\s*up|create\\s+an?\\s*account|create\\s+account|logged\\s*out|anonymous|without\\s+an?\\s*account|without\\s+signing\\s*in|continue\\s+without|use\\s+chatgpt\\s+without|stay\\s+logged\\s*out|no\\s+auth|no-auth|sign\\s*in\\s*to\\s*chatgpt|consent|manage\\s+cookie|accept\\s+(all\\s+)?cookie|reject\\s+non\\s*essential|privacy";

const AUTH_TESTID_SIGNALS =
    "no-auth|auth|login|signin|sign-in|signup|sign-up|onboarding|anonymous|consent|gate|cookie|paywall";

const MODAL_SELECTORS = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '[data-testid*="modal"]',
    '[data-testid*="dialog"]',
    '[data-testid*="popup"]',
    '[data-testid*="sheet"]',
    '[data-testid*="overlay"]',
    '[data-testid*="consent"]',
    '[data-testid*="gate"]',
];

const POPUP_CONFIG = {
    modalSelectors: MODAL_SELECTORS,
    modalSelectorJoined: MODAL_SELECTORS.join(", "),
    authTestid: AUTH_TESTID_SIGNALS,
    authText: AUTH_TEXT_SIGNALS,
    composerSelectors: COMPOSER_SELECTORS,
    composerSelectorJoined: COMPOSER_SELECTORS.join(", "),
    domIsVisibleSrc: `(${domIsVisible.toString()})`,
};

function inspectPopupImpl(cfg) {
    var isVisible = eval(cfg.domIsVisibleSrc);
    function accName(el) {
        if (!el) return "";
        if (typeof el.getAttribute !== "function") return "";
        var labelled = el.getAttribute("aria-labelledby");
        if (labelled) {
            var ids = String(labelled).split(/\s+/).filter(Boolean);
            var txt = "";
            for (var i = 0; i < ids.length; i++) {
                var r = document.getElementById(ids[i]);
                if (r) txt += " " + (r.textContent || "");
            }
            if (txt.trim()) return txt.trim();
        }
        var al = el.getAttribute("aria-label");
        if (al && al.trim()) return al.trim();
        var t = el.getAttribute("title");
        if (t && t.trim()) return t.trim();
        return (el.textContent || "").replace(/\s+/g, " ").trim();
    }
    function isRendered(el) {
        if (!el) return false;
        if (el.disabled) return false;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
        return isVisible(el) || el.offsetParent !== null;
    }

    var authTestid = new RegExp(cfg.authTestid, "i");
    var authText = new RegExp(cfg.authText, "i");

    var modalEls = [];
    try {
        var found = document.querySelectorAll(cfg.modalSelectorJoined);
        for (var i = 0; i < found.length; i++) {
            if (isVisible(found[i]) && modalEls.indexOf(found[i]) === -1) modalEls.push(found[i]);
        }
    } catch (e) {}

    var authPopup = null;
    var authModalIndex = -1;
    for (var k = 0; k < modalEls.length; k++) {
        var m = modalEls[k];
        var td = (m.getAttribute && m.getAttribute("data-testid")) || "";
        if (authTestid.test(td)) {
            authPopup = m;
            authModalIndex = k;
            break;
        }
        if (authText.test(accName(m))) {
            authPopup = m;
            authModalIndex = k;
            break;
        }
        if (authText.test((m.textContent || "").replace(/\s+/g, " ").trim())) {
            authPopup = m;
            authModalIndex = k;
            break;
        }
    }

    var composer = null;
    try {
        var cfound = document.querySelectorAll(cfg.composerSelectorJoined);
        for (var c = 0; c < cfound.length; c++) {
            if (isVisible(cfound[c])) {
                composer = cfound[c];
                break;
            }
        }
    } catch (e) {}

    return {
        hasAuthPopup: !!authPopup,
        authPopupName: authPopup ? accName(authPopup) : "",
        authModalIndex: authModalIndex,
        composerVisible: !!composer,
        composerUsable: !!(composer && isRendered(composer)),
        modalCount: modalEls.length,
    };
}

async function inspectPopup(page) {
    return page.evaluate(inspectPopupImpl, POPUP_CONFIG).catch(() => ({
        hasAuthPopup: false,
        authPopupName: "",
        composerVisible: false,
        composerUsable: false,
        modalCount: 0,
    }));
}

async function hasAuthPopup(page) {
    const state = await inspectPopup(page);
    return state.hasAuthPopup;
}

async function locateAuthDialog(page) {
    const state = await inspectPopup(page);
    if (!state.hasAuthPopup) return null;
    const visibleModals = page
        .locator(POPUP_CONFIG.modalSelectorJoined)
        .filter({ visible: true });
    if ((await visibleModals.count().catch(() => 0)) <= state.authModalIndex) return null;
    return visibleModals.nth(state.authModalIndex);
}

async function controlDescription(loc) {
    const al = await loc.getAttribute("aria-label").catch(() => null);
    if (al && al.trim()) return `button[aria-label="${al}"]`;
    const tt = await loc.getAttribute("title").catch(() => null);
    if (tt && tt.trim()) return `button[title="${tt}"]`;
    const dt = await loc.getAttribute("data-testid").catch(() => null);
    if (dt && dt.trim()) return `button[data-testid="${dt}"]`;
    const txt = (await loc.textContent().catch(() => "")).trim().replace(/\s+/g, " ");
    if (txt && txt.length <= 50) return `button "${txt}"`;
    const hasSvg = (await loc.locator("svg").count().catch(() => 0)) > 0;
    if (hasSvg) return "icon-only button";
    return "button";
}

async function isUsableButton(loc) {
    return (
        (await loc.isVisible().catch(() => false)) &&
        (await loc.isEnabled().catch(() => false))
    );
}

async function findIconCloseButton(dialog) {
    const btns = dialog.locator("button, [role=button]");
    const n = await btns.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
        const b = btns.nth(i);
        if (!(await isUsableButton(b))) continue;
        const al = await b.getAttribute("aria-label").catch(() => null);
        const txt = (await b.textContent().catch(() => "")).trim();
        if (al && al.trim()) continue;
        if (txt) continue;
        const hasSvg = (await b.locator("svg").count().catch(() => 0)) > 0;
        if (!hasSvg) continue;
        const box = await b.boundingBox().catch(() => null);
        if (!box || box.width === 0 || box.height === 0) continue;
        if (box.width > 72 || box.height > 72) continue;
        return b;
    }
    return null;
}

async function findDismissControl(page) {
    const dialog = await locateAuthDialog(page);
    if (!dialog) return null;

    const strategies = [
        () => dialog.getByRole("button", { name: CLOSE_CONTROL_NAME }),
        () => dialog.getByRole("button", { name: DISMISS_CTA_NAME }),
        () =>
            dialog.locator(
                '[aria-label*="close" i], [aria-label*="dismiss" i], [title*="close" i], [data-testid*="close" i], [data-testid*="dismiss" i]'
            ),
        () => dialog.getByRole("button", { name: /^(got\s*it|accept\s+all)\b/i }),
    ];

    for (const strategy of strategies) {
        const b = strategy().first();
        if ((await b.count().catch(() => 0)) === 0) continue;
        if (!(await isUsableButton(b))) continue;
        const desc = await controlDescription(b);
        return { button: b, description: desc || "close/dismiss control" };
    }

    const icon = await findIconCloseButton(dialog);
    if (icon) {
        const desc = await controlDescription(icon);
        return { button: icon, description: desc || "icon-only close button" };
    }
    return null;
}

async function safeClick(page, button) {
    try {
        await button.click({ timeout: 3000 });
        return true;
    } catch (e1) {
        await page.waitForTimeout(200);
        try {
            await button.click({ timeout: 3000 });
            return true;
        } catch (e2) {
            return false;
        }
    }
}

async function pressEscape(page) {
    try {
        await page.keyboard.press("Escape", { timeout: 2000 });
    } catch (e) {}
}

async function isUploadOverlay(page) {
    const loc = page.getByText(UPLOAD_OVERLAY_TEXT).first();
    if ((await loc.count().catch(() => 0)) === 0) return false;
    return loc.isVisible().catch(() => false);
}

async function dismissAuthPopup(page) {
    const initial = await inspectPopup(page);
    if (!initial.hasAuthPopup) {
        return { dismissed: false, reason: "absent", action: "none" };
    }
    if (initial.authPopupName) console.log(`>> Auth popup detected (${initial.authPopupName}).`);
    else console.log(">> Auth popup detected.");

    let lastAction = "none";
    for (let attempt = 1; attempt <= 3; attempt++) {
        const found = await findDismissControl(page);
        if (found) {
            console.log(`>> Auth popup dismiss action found: ${found.description}.`);
            lastAction = found.description;
            const clicked = await safeClick(page, found.button);
            if (clicked) {
                await page.waitForTimeout(350);
                if (!(await hasAuthPopup(page))) {
                    console.log(">> Auth popup dismissed.");
                    return { dismissed: true, method: "click", action: lastAction };
                }
                console.log(">> Auth popup still present after click, waiting briefly...");
                await page.waitForTimeout(250);
            } else {
                console.log(">> Dismiss control not immediately clickable (covered/focused/animated), waiting...");
                await page.waitForTimeout(250);
            }
        } else {
            console.log(">> No dismiss control matched within the popup, pressing Escape...");
            await pressEscape(page);
            await page.waitForTimeout(350);
            if (!(await hasAuthPopup(page))) {
                console.log(">> Auth popup dismissed (Escape).");
                return { dismissed: true, method: "escape", action: "escape" };
            }
        }

        await pressEscape(page);
        await page.waitForTimeout(350);
        if (!(await hasAuthPopup(page))) {
            console.log(">> Auth popup dismissed (Escape).");
            return { dismissed: true, method: "escape", action: "escape" };
        }
    }

    console.log(`>> Auth popup could not be dismissed (last control: ${lastAction}).`);
    return { dismissed: false, reason: "failed-after-retries", action: lastAction };
}

async function dismissBlockingUI(page) {
    const initial = await inspectPopup(page);
    const upload = await isUploadOverlay(page);
    if (!initial.hasAuthPopup && !upload) {
        return false;
    }

    let cleared = true;

    if (initial.hasAuthPopup) {
        const result = await dismissAuthPopup(page);
        if (result.dismissed) {
            const state = await inspectPopup(page);
            if (state.composerUsable) console.log(">> Composer ready.");
        } else {
            console.log(`>> Auth popup could not be dismissed (${result.reason || "unknown"}).`);
            cleared = false;
        }
    }

    if (upload) {
        console.log(">> Upload overlay detected.");
        const wasAuth = initial.hasAuthPopup;
        await pressEscape(page);
        await page.waitForTimeout(300);
        if (!(await isUploadOverlay(page))) {
            console.log(">> Upload overlay dismissed.");
        } else if (!wasAuth) {
            cleared = false;
        }
    }

    const after = await inspectPopup(page);
    const stillUpload = await isUploadOverlay(page);
    if (!after.hasAuthPopup && !stillUpload && cleared) {
        return true;
    }
    console.log(">> Blocking UI still present after attempts.");
    return false;
}

async function dismissAndSettle(page, ms = 1000) {
    await dismissBlockingUI(page);
    await page.waitForTimeout(ms);
}

async function waitForEnabled(page, input) {
    await page.waitForFunction(
        ({ selector, finderSource, usableSource }) => {
            const el = eval(finderSource)(selector);
            return eval(usableSource)(el) && el.offsetParent !== null;
        },
        CHATGPT_DOM.promptPayload(),
        { timeout: 20000 }
    );
}

async function isPromptReady(page) {
    const state = await inspectPopup(page);
    return state.composerVisible && state.composerUsable && !state.hasAuthPopup;
}

function startPopupMonitor(page, { intervalMs = 1000 } = {}) {
    let active = true;
    let timer = null;
    let tickCount = 0;

    async function tick() {
        if (!active) return;
        try {
            await dismissBlockingUI(page);
        } catch (error) {
            // The page or browser context may be closing; never let the
            // safety monitor crash the running automation.
        }
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

module.exports = {
    SELECTORS,
    selector,
    CHATGPT_DOM,
    PAGE_DOM_SOURCE,
    firstVisibleElement,
    elementText,
    isUsableControl,
    POPUP_DISMISS_PATTERNS,
    UPLOAD_OVERLAY_TEXT,
    COMPOSER_SELECTORS,
    promptInput,
    sendButton,
    stopButton,
    attachButton,
    fileInput,
    assistantMessages,
    userMessages,
    inspectPopup,
    hasAuthPopup,
    locateAuthDialog,
    findDismissControl,
    dismissAuthPopup,
    dismissBlockingUI,
    dismissAndSettle,
    isPromptReady,
    waitForEnabled,
    startPopupMonitor,
    isUploadOverlay,
    uploadOverlayVisible: isUploadOverlay,
    modalVisible: hasAuthPopup,
};
