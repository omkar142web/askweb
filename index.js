#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const crypto = require("crypto");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

const URL = "https://chatgpt.com/";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const APP_DIR = __dirname;
const BROWSERS = [
    { name: "chrome", channel: "chrome", profileDir: path.join(APP_DIR, "user-data-chrome") },
    { name: "brave", executablePath: `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, profileDir: path.join(APP_DIR, "user-data-brave") },
    { name: "edge", channel: "msedge", profileDir: path.join(APP_DIR, "user-data-edge") },
];
const POLL_MS = 1000;
const STABLE_POLLS_REQUIRED = 3;
const MAX_FILE_CHARS = 150000;
const DEFAULT_QUESTION = "What is JavaScript?";
const DEFAULT_OUTPUT_FILE = "./output.md";
const PREFS_FILE = path.join(__dirname, ".browser-prefs.json");
const CONVERSATIONS_FILE = path.join(__dirname, ".chatgpt-conversations.json");
const MAX_SAVED_CONVERSATIONS = 20;
const CONVERSATION_URL_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const PASTE_FILE_EXTENSIONS = new Set([
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
]);

const SELECTORS = {
    promptInput: "#prompt-textarea",
    sendButton: '[data-testid="send-button"]',
    stopButton: '[data-testid="stop-button"]',
    assistantMessage: '[data-message-author-role="assistant"]',
    userMessage: '[data-message-author-role="user"]',
    attachButton: '[data-testid="composer-plus-btn"]',
    copyButton: '[data-testid="copy-turn-action-button"]',
};

const promptInput = (page) => page.locator(SELECTORS.promptInput).first();

const T0 = Date.now();
const PHASES = [];
function markPhase(name) {
    PHASES.push([name, Date.now() - T0]);
}
function printTimings() {
    if (PHASES.length === 0) return;
    const parts = [];
    for (let i = 0; i < PHASES.length; i++) {
        const start = i === 0 ? 0 : PHASES[i - 1][1];
        parts.push(`${PHASES[i][0]}=${((PHASES[i][1] - start) / 1000).toFixed(1)}s`);
    }
    console.log(`>> [timing] ${parts.join(", ")} | total=${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

const isOnAuthPage = (page) => {
    const url = page.url();
    return url.includes("/auth/login") || url.includes("/auth/signin");
};

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
    { text: /^accept\s*all$/i, label: "Accept all cookies" },
    { text: /^got\s*it$/i, label: "Got it" },
    { text: /^dismiss$/i, label: "Dismiss" },
];

chromium.use(stealth);

const VERSION = require("./package.json").version;

function showHelp() {
    console.log(`ChatGPT CLI

Usage:
  node index.js [options] [question] [files...]

Ask ChatGPT a question directly from your terminal. Files passed as arguments
(or referenced with @path) are attached to the prompt; text/code files are
pasted inline, other files are uploaded.

Arguments:
  question                Question text (default: "${DEFAULT_QUESTION}")
  files...                Files to attach; "@path" also references a file
  Use "--" before the question to treat leading dashes as literal text.

Options:
  -o, --output <file>     Save the answer to a file (default: ${DEFAULT_OUTPUT_FILE})
      --login             Open ChatGPT to log in and save the session
      --continue          Continue the most recent conversation
      --new               Start a fresh conversation instead of continuing
      --browser           Configure default browser interactively
      --browser-order     Configure browser fallback order
      --browser-reset     Reset browser preferences to automatic
      --clear-session     Clear saved local storage on launch
      --clear-conversations Delete all saved conversation history
      --clear-conversation <id> Delete one saved conversation by id (prefix ok)
  -h, --help              Show this help
  -v, --version           Show version

Conversations:
  Every run saves its Q&A history locally to .chatgpt-conversations.json.
  By default each run starts a fresh chat; pass --continue to replay the
  saved transcript into a new chat so full context carries over (works
  even when logged out).

Examples:
  node index.js "Explain event loops"
  node index.js --continue "Give me 3 examples"
  node index.js --new "Start a fresh discussion about React"
  node index.js "Review this code" src/index.js utils.js
  node index.js "Summarize" @notes.md -o summary.md`);
}

function parseCliArgs(argv = process.argv.slice(2)) {
    const options = {
        login: false,
        clearSession: false,
        clearConversations: false,
        clearConversationId: null,
        configureBrowser: false,
        configureBrowserOrder: false,
        resetBrowserPrefs: false,
        continueLast: false,
        newConversation: false,
        showHelp: false,
        showVersion: false,
        outputFile: DEFAULT_OUTPUT_FILE,
        questionArgs: [],
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = stripShellQuotes(argv[i]);

        if (arg === "--") {
            options.questionArgs.push(...argv.slice(i + 1).map(stripShellQuotes));
            break;
        }

        if (arg === "--login") {
            options.login = true;
            continue;
        }

        if (arg === "--clear-session") {
            options.clearSession = true;
            continue;
        }

        if (arg === "--clear-conversations") {
            options.clearConversations = true;
            continue;
        }

        if (arg === "--clear-conversation") {
            const value = argv[i + 1];
            if (!value) throw new Error(`${arg} requires a conversation id`);
            options.clearConversationId = stripShellQuotes(value);
            i++;
            continue;
        }

        if (arg.startsWith("--clear-conversation=")) {
            const value = arg.slice("--clear-conversation=".length);
            if (!value) throw new Error("--clear-conversation requires a conversation id");
            options.clearConversationId = stripShellQuotes(value);
            continue;
        }

        if (arg === "--continue") {
            options.continueLast = true;
            continue;
        }

        if (arg === "--new") {
            options.newConversation = true;
            continue;
        }

        if (arg === "--browser") {
            options.configureBrowser = true;
            continue;
        }

        if (arg === "--browser-order") {
            options.configureBrowserOrder = true;
            continue;
        }

        if (arg === "--browser-reset") {
            options.resetBrowserPrefs = true;
            continue;
        }

        if (arg === "--help" || arg === "-h") {
            options.showHelp = true;
            continue;
        }

        if (arg === "--version" || arg === "-v") {
            options.showVersion = true;
            continue;
        }

        if (arg === "--output" || arg === "-o") {
            const value = argv[i + 1];
            if (!value) throw new Error(`${arg} requires a file path`);
            options.outputFile = stripShellQuotes(value);
            i++;
            continue;
        }

        if (arg.startsWith("--output=")) {
            const value = arg.slice("--output=".length);
            if (!value) throw new Error("--output requires a file path");
            options.outputFile = stripShellQuotes(value);
            continue;
        }

        if (arg.startsWith("-")) {
            throw new Error(`Unknown option: ${arg}\nRun \`node index.js --help\` for usage.`);
        }

        options.questionArgs.push(arg);
    }

    if (options.continueLast && options.newConversation) {
        throw new Error("Use either --continue or --new, not both.");
    }

    return options;
}

const CLI = (() => {
    try {
        return parseCliArgs();
    } catch (error) {
        console.error(`Error: ${firstLine(error)}`);
        process.exit(1);
    }
})();

function wantsLogin() {
    return CLI.login;
}

function parseQuestion(args = CLI.questionArgs) {
    const textParts = [];
    const fileRefs = [];

    for (const rawArg of args) {
        const arg = stripShellQuotes(rawArg);
        if (!arg) continue;

        if (looksLikeExistingFile(arg)) {
            fileRefs.push(arg);
            continue;
        }

        for (const rawToken of arg.split(/\s+/)) {
            const token = stripShellQuotes(rawToken);
            if (!token) continue;

            if (token.startsWith("@") && token.length > 1) {
                fileRefs.push(stripShellQuotes(token.slice(1)));
            } else if (looksLikeExistingFile(token)) {
                fileRefs.push(token);
            } else {
                textParts.push(token);
            }
        }
    }

    const text = textParts.join(" ").trim();
    return { text: text || DEFAULT_QUESTION, files: fileRefs };
}

function stripShellQuotes(value) {
    return value.trim().replace(/^["']+|["']+$/g, "");
}

function firstLine(error) {
    return error.message.split("\n")[0];
}

function looksLikeExistingFile(value) {
    try {
        const fullPath = path.resolve(value);
        return fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
    } catch {
        return false;
    }
}

function loadFiles(fileRefs) {
    return fileRefs.map((ref) => {
        const fullPath = path.resolve(ref);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${fullPath}`);
        }

        const isText = PASTE_FILE_EXTENSIONS.has(path.extname(fullPath).toLowerCase());
        const buffer = fs.readFileSync(fullPath);
        let content = isText ? buffer.toString("utf8") : buffer.toString("base64");
        const truncated = content.length > MAX_FILE_CHARS;
        if (truncated) content = content.slice(0, MAX_FILE_CHARS);

        return { name: path.basename(fullPath), fullPath, isText, content, truncated };
    });
}

function shouldPasteFiles(files) {
    return files.some((file) => PASTE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase()));
}

function codeFenceFor(content) {
    let longest = 0;
    for (const match of content.match(/`+/g) || []) {
        longest = Math.max(longest, match.length);
    }
    return "`".repeat(Math.max(3, longest + 1));
}

function fileBlock(file) {
    const truncationNote = file.truncated ? `\n(${file.name} was truncated to ${MAX_FILE_CHARS} chars)` : "";
    if (!file.isText) {
        return `\n\n<file name="${file.name}" encoding="base64">\n${file.content}\n</file>${truncationNote}`;
    }
    const lang = path.extname(file.name).slice(1);
    const fence = codeFenceFor(file.content);
    return `\n\n<file name="${file.name}" lang="${lang}">\n${fence}${lang}\n${file.content}\n${fence}\n</file>${truncationNote}`;
}

const DECODE_NOTE = '\n\nAny <file> block with encoding="base64" contains base64-encoded bytes. Decode those blocks before analyzing them.';

const NO_AUTH_MODAL = '[data-testid="modal-no-auth-login"]';
const BLOCKER_SELECTOR = '[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [class*="modal"], [class*="popover"]';
const UPLOAD_OVERLAY_TEXT = /add\s+anything/i;
const chipError = (name) => new Error(`attachment chip for "${name}" never appeared`);

async function modalVisible(page) {
    const modal = page.locator(NO_AUTH_MODAL).first();
    if ((await modal.count()) === 0) return false;
    return modal.isVisible().catch(() => false);
}

async function uploadOverlayVisible(page) {
    const overlayText = page.getByText(UPLOAD_OVERLAY_TEXT).first();
    if ((await overlayText.count()) === 0) return false;
    return overlayText.isVisible().catch(() => false);
}

async function blockingDialogVisible(page) {
    return page
        .evaluate(
            ({ modalSelector, blockerSelector, overlaySource }) => {
                const visible = (el) =>
                    !!el &&
                    (typeof el.checkVisibility === "function"
                        ? el.checkVisibility()
                        : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));

                if (visible(document.querySelector(modalSelector))) return true;
                if (overlaySource && new RegExp(overlaySource, "i").test(document.body ? document.body.innerText : "")) {
                    return true;
                }
                for (const el of document.querySelectorAll(blockerSelector)) {
                    if (visible(el)) return true;
                }
                return false;
            },
            {
                modalSelector: NO_AUTH_MODAL,
                blockerSelector: BLOCKER_SELECTOR,
                overlaySource: UPLOAD_OVERLAY_TEXT.source,
            }
        )
        .catch(() => false);
}

async function clickDismissiveButton(page) {
    for (const pattern of POPUP_DISMISS_PATTERNS) {
        const candidates = page
            .locator('button, [role="button"], a')
            .filter({ hasText: pattern.text });
        const total = await candidates.count();
        for (let i = 0; i < total; i++) {
            const candidate = candidates.nth(i);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            console.log(`>> Clicking "${pattern.label}"...`);
            try {
                await candidate.click({ timeout: 5000 });
            } catch {
                await candidate.click({ timeout: 5000, force: true }).catch(() => {});
            }
            return true;
        }
    }
    return false;
}

async function dismissBlockingUI(page) {
    if (!(await blockingDialogVisible(page))) return false;

    const sawNoAuthModal = await modalVisible(page);
    const sawUploadOverlay = await uploadOverlayVisible(page);
    if (sawNoAuthModal) console.log(">> No-auth popup detected.");
    if (sawUploadOverlay) console.log(">> Upload overlay detected.");
    let dismissed = false;

    for (let attempt = 0; attempt < 5; attempt++) {
        if (!(await blockingDialogVisible(page))) break;

        const clicked = await clickDismissiveButton(page);
        if (!clicked) break;
        dismissed = true;

        await page
            .locator(NO_AUTH_MODAL)
            .first()
            .waitFor({ state: "hidden", timeout: 8000 })
            .catch(() => {});
        await page.waitForTimeout(500);
    }

    if (await blockingDialogVisible(page)) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(1000);
        dismissed = true;
    }

    if (sawNoAuthModal && !(await modalVisible(page))) {
        console.log(">> No-auth popup dismissed.");
    }
    if (sawUploadOverlay && !(await uploadOverlayVisible(page))) {
        console.log(">> Upload overlay dismissed.");
    }

    return dismissed;
}

async function dismissAndSettle(page, ms = 1000) {
    await dismissBlockingUI(page);
    await page.waitForTimeout(ms);
}

async function focusComposer(input) {
    await input.click();
    await input.focus();
}

async function trySend(page, sendButton, { requireVisible = false, force = false } = {}) {
    if (
        (await sendButton.count()) > 0 &&
        (!requireVisible || (await sendButton.isVisible().catch(() => false)))
    ) {
        try {
            await sendButton.click({ force });
        } catch {
            await page.keyboard.press("Enter");
        }
    } else {
        await page.keyboard.press("Enter");
    }
}

async function resetComposer(page, targetUrl = URL) {
    await dismissBlockingUI(page);
    if (!(await uploadOverlayVisible(page))) return;

    console.log(">> Upload overlay still visible, reloading ChatGPT...");
    await gotoChatGPT(page, targetUrl);
    await page.waitForTimeout(2000);
    await waitForChatGPTReady(page, targetUrl);
}

async function gotoChatGPT(page, targetUrl = URL) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            return;
        } catch (error) {
            lastError = error;
            const message = firstLine(error);
            console.log(`>> ChatGPT navigation failed (${message}), retrying ${attempt}/3...`);
            await page.waitForTimeout(3000);
        }
    }
    throw lastError;
}

async function isPromptReady(page) {
    const input = promptInput(page);
    if ((await input.count()) === 0) return false;
    if (!(await input.isVisible().catch(() => false))) return false;

    const enabled = await page
        .evaluate(() => {
            const el = document.querySelector("#prompt-textarea");
            return !!el && !el.disabled && !el.readOnly && el.offsetParent !== null;
        })
        .catch(() => false);
    if (!enabled) return false;

    return !(await modalVisible(page));
}

async function waitForChatGPTReady(page, targetUrl = URL) {
    await gotoChatGPT(page, targetUrl);
    await page.waitForTimeout(2000);

    const deadline = Date.now() + 5 * 60 * 1000;
    let lastNotice = 0;
    while (Date.now() < deadline) {
        await dismissBlockingUI(page);
        if (await isPromptReady(page)) break;

        if (isOnAuthPage(page) && Date.now() - lastNotice > 15000) {
            lastNotice = Date.now();
            const elapsed = Math.round((Date.now() - (deadline - 5 * 60 * 1000)) / 1000);
            console.log(`>> Waiting for login... (${elapsed}s) Not logged in in this browser profile. Log in inside the window, or run \`askweb --login\`.`);
        }
        await page.waitForTimeout(1000);
    }

    if (!(await isPromptReady(page))) {
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "");
        throw new Error(`Prompt input never became usable at ${page.url()}. Page text: ${pageText.replace(/\s+/g, " ").trim() || "(empty)"}. Run \`node index.js --login\` to log in manually.`);
    }

    const input = promptInput(page);
    try {
        await input.click({ timeout: 10000, force: true });
    } catch {
        await dismissAndSettle(page);
        await input.waitFor({ state: "visible", timeout: 15000 });
        await waitForEnabled(page, input);
        await input.click({ timeout: 10000, force: true });
    }

    await page.waitForTimeout(500);
    console.log(">> Prompt input ready.");
    return input;
}

async function waitForEnabled(page, input) {
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel);
            return el && !el.disabled && !el.readOnly && el.offsetParent !== null;
        },
        SELECTORS.promptInput,
        { timeout: 20000 }
    );
}

async function waitForPromptInput(page) {
    const input = promptInput(page);

    try {
        await input.waitFor({ state: "visible", timeout: 20000 });
        await waitForEnabled(page, input);

        try {
            await input.click({ timeout: 5000, force: true });
        } catch {
            await dismissBlockingUI(page);
            await input.waitFor({ state: "visible", timeout: 15000 });
            await waitForEnabled(page, input);
            await input.click({ timeout: 10000 });
        }

        await page.waitForTimeout(500);
        return input;
    } catch {
        console.log(">> No prompt box found. Log in to ChatGPT in the opened browser window...");
        const startTime = Date.now();
        const maxWait = 10 * 60 * 1000;

        while (Date.now() - startTime < maxWait) {
            await page.waitForTimeout(2000);
            await dismissBlockingUI(page);
            try {
                await input.waitFor({ state: "visible", timeout: 5000 });
                await waitForEnabled(page, input);
                await input.click({ timeout: 5000, force: true });
                await page.waitForTimeout(500);
                return input;
            } catch {}
        }

        throw new Error("Prompt input not found within timeout. Please log in manually.");
    }
}

async function waitForAttachmentChip(page, firstName) {
    try {
        await page.waitForFunction(
            (name) => {
                const text = document.body.innerText;
                if (text.includes(name)) return true;
                const stem = name.replace(/\.[^.]+$/, "");
                return stem.length > 3 && text.includes(stem);
            },
            firstName,
            { timeout: 15000 }
        );
        return true;
    } catch {
        return false;
    }
}

async function attachViaDrop(page, files) {
    await promptInput(page).click();
    for (const file of files) {
        const b64 = fs.readFileSync(file.fullPath).toString("base64");
        await page.evaluate(
            ({ b64, name }) => {
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const ext = name.split(".").pop() || "";
                const mimeMap = { js: "text/javascript", txt: "text/plain", md: "text/markdown", json: "application/json", py: "text/x-python", csv: "text/csv" };
                const file = new File([bytes], name, { type: mimeMap[ext] || "text/plain" });
                const dt = new DataTransfer();
                dt.items.add(file);
                const target = document.querySelector("#prompt-textarea");
                if (target) {
                    for (const type of ["dragenter", "dragover", "drop"]) {
                        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
                    }
                }
            },
            { b64, name: file.name }
        );
        const attached = await waitForAttachmentChip(page, file.name);
        if (!attached) throw new Error(`drop did not create attachment chip for "${file.name}"`);
    }
}

async function attachViaChooser(page, files) {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 6000 });
    await page.locator(SELECTORS.attachButton).first().click();

    let chooser;
    try {
        chooser = await chooserPromise;
    } catch {
        const menuItem = page
            .locator('[role="menuitem"], [role="menu"] button, [role="dialog"] button')
            .filter({ hasText: /file|upload|computer|photos/i })
            .first();
        await menuItem.click({ timeout: 4000 });
        chooser = await page.waitForEvent("filechooser", { timeout: 6000 });
    }

    await chooser.setFiles(files.map((file) => file.fullPath));

    if (!(await waitForAttachmentChip(page, files[0].name))) {
        throw chipError(files[0].name);
    }
}

async function attachViaFileInput(page, files) {
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count();
    if (count === 0) throw new Error("no input[type=file] in DOM");

    let lastError;
    for (let i = count - 1; i >= 0; i--) {
        try {
            await inputs.nth(i).setInputFiles(files.map((f) => f.fullPath), { timeout: 5000 });
            if (!(await waitForAttachmentChip(page, files[0].name))) {
                throw chipError(files[0].name);
            }
            return;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("input[type=file] attach failed");
}

async function attachFiles(page, files) {
    await dismissBlockingUI(page);
    try {
        await attachViaFileInput(page, files);
        return "file-input";
    } catch (inputError) {
        if (await uploadOverlayVisible(page)) {
            await dismissBlockingUI(page);
            throw new Error(`upload overlay rejected "${files[0].name}"`);
        }
        console.log(`>> File-input attach failed (${firstLine(inputError)}), trying chooser...`);
        try {
            await attachViaChooser(page, files);
            return "chooser";
        } catch (chooserError) {
            if (await uploadOverlayVisible(page)) {
                await dismissBlockingUI(page);
                throw new Error(`upload overlay rejected "${files[0].name}"`);
            }
            console.log(`>> Chooser attach failed (${firstLine(chooserError)}), trying drag/drop...`);
            try {
                await attachViaDrop(page, files);
                return "drop";
            } catch (dropError) {
                await dismissBlockingUI(page);
                throw new Error(`all attach strategies failed: ${firstLine(dropError)}`);
            }
        }
    }
}

function buildFullPrompt(question) {
    const blocks = question.files.map(fileBlock).join("");
    const hasBinary = question.files.some((file) => !file.isText);
    const body = hasBinary ? blocks + DECODE_NOTE : blocks;
    return question.text ? `${question.text}\n${body}` : body;
}

const COMPOSER_CHUNK = 6000;
let composerKindLogged = false;

async function prepareComposerProbe(page) {
    return page
        .evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return { ok: false, kind: null };

            if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
                return { ok: true, kind: `<${el.tagName.toLowerCase()}>` };
            }

            el.focus();
            const selection = window.getSelection();
            selection.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.addRange(range);
            return { ok: true, kind: `<${el.tagName.toLowerCase()} contenteditable>` };
        }, SELECTORS.promptInput)
        .catch(() => ({ ok: false, kind: null }));
}

async function injectTextareaValue(page, text) {
    return page
        .evaluate(
            ({ selector, text }) => {
                const el = document.querySelector(selector);
                if (!el || (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT")) return false;
                const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                return true;
            },
            { selector: SELECTORS.promptInput, text }
        )
        .then((ok) => !!ok)
        .catch(() => false);
}

async function insertContenteditableChunk(page, chunk) {
    return page
        .evaluate((t) => document.execCommand("insertText", false, t), chunk)
        .then((ok) => !!ok)
        .catch(() => false);
}

async function composerTextLength(page) {
    return page
        .evaluate((sel) => {
            const el = document.querySelector(sel);
            return (el && el.innerText ? el.innerText : "").length;
        }, SELECTORS.promptInput)
        .catch(() => 0);
}

async function pasteViaClipboardKeys(page, input, text) {
    const copied = await page
        .evaluate((t) => navigator.clipboard.writeText(t), text)
        .then(() => true)
        .catch(() => false);
    if (!copied) return false;

    await focusComposer(input);
    await page.waitForTimeout(250);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.waitForTimeout(80);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");

    for (let check = 0; check < 5; check++) {
        await page.waitForTimeout(300);
        if ((await composerTextLength(page)) >= text.length * 0.7) return true;
    }
    return false;
}

async function pasteIntoComposer(page, input, text) {
    const probe = await prepareComposerProbe(page);

    if (probe.ok && !composerKindLogged) {
        console.log(`>> Composer element is ${probe.kind}`);
        composerKindLogged = true;
    }

    let injected = false;
    let partialOffset = 0;

    if (probe.ok && (probe.kind === "<textarea>" || probe.kind === "<input>")) {
        injected = await injectTextareaValue(page, text);
        if (injected) console.log(`>> Pasted ${(text.length / 1024).toFixed(1)} KB via native value setter.`);
    } else if (probe.ok) {
        injected = await pasteViaClipboardKeys(page, input, text);
        if (injected) {
            console.log(`>> Pasted ${(text.length / 1024).toFixed(1)} KB via clipboard (Ctrl+V).`);
        }
    }

    if (!injected && probe.ok) {
        // Fallback: a single execCommand with tens of KB blocks the page for minutes, so feed it slices.
        const totalChunks = Math.ceil(text.length / COMPOSER_CHUNK);
        const milestones = new Set([1, Math.ceil(totalChunks / 4), Math.ceil(totalChunks / 2), totalChunks]);

        let offset = 0;
        let chunkIndex = 0;
        while (offset < text.length) {
            let end = Math.min(offset + COMPOSER_CHUNK, text.length);
            const lastCode = text.charCodeAt(end - 1);
            if (lastCode >= 0xd800 && lastCode <= 0xdbff && end < text.length) end += 1;

            if (!(await insertContenteditableChunk(page, text.slice(offset, end)))) break;

            offset = end;
            partialOffset = offset;
            chunkIndex += 1;
            if (milestones.has(chunkIndex)) {
                console.log(`>> Injected ${Math.round((offset / text.length) * 100)}% (${(offset / 1024).toFixed(1)} KB)...`);
            }
            if (offset < text.length) await page.waitForTimeout(25);
        }
        injected = partialOffset >= text.length;

        if (injected) {
            console.log(`>> Pasted ${(text.length / 1024).toFixed(1)} KB into composer in ${totalChunks} slice(s).`);
        }
    }

    if (!injected) {
        if (partialOffset > 0) await input.fill("").catch(() => {});
        console.log(`>> DOM injection unavailable, pasting ${(text.length / 1024).toFixed(1)} KB in chunks via insertText...`);
        for (let offset = 0; offset < text.length; offset += 2000) {
            await page.keyboard.insertText(text.slice(offset, offset + 2000));
            await page.waitForTimeout(40);
        }
    }
}

async function typePrompt(page, input, question, attached) {
    await dismissBlockingUI(page);

    const pasteFiles = !attached && question.files.length > 0;
    await focusComposer(input);
    await input.fill("");

    const payload = pasteFiles ? buildFullPrompt(question) : question.text;
    if (payload) {
        await pasteIntoComposer(page, input, payload);
    }

    await page.waitForTimeout(pasteFiles ? 500 : 400);
}

async function promptHasExpectedText(page, expectedParts) {
    if (expectedParts.length === 0) return true;
    const typed = await promptInput(page)
        .evaluate((el) => ("value" in el ? el.value : el.innerText || el.textContent || ""))
        .catch(() => "");
    return expectedParts.every((part) => typed.includes(part));
}

async function sendQuestion(page, question, targetUrl = URL) {
    const input = await waitForChatGPTReady(page, targetUrl);
    markPhase("ready");
    const assistantCountBefore = await page.locator(SELECTORS.assistantMessage).count();

    let attached = false;
    if (question.files.length > 0) {
        console.log(`>> Loaded ${question.files.length} file(s): ${question.files.map((file) => file.name).join(", ")}`);
        if (shouldPasteFiles(question.files)) {
            console.log(">> Text/code file detected, using paste mode.");
        } else {
            try {
                await attachFiles(page, question.files);
                attached = true;
                console.log(`>> Attached ${question.files.length} file(s) via upload.`);
                await page.waitForTimeout(3000);
            } catch (error) {
                console.log(`>> Upload failed (${firstLine(error)}), falling back to paste.`);
                await resetComposer(page, targetUrl);
            }
        }
    }

    if (!(await isPromptReady(page))) {
        await dismissAndSettle(page);
    }

    const finalInput = promptInput(page);
    const expectedParts = [];
    if (question.text) expectedParts.push(question.text.trim().slice(0, 60));
    if (!attached && question.files.length > 0) expectedParts.push("</file>");

    console.log(">> Writing prompt...");
    let verified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await typePrompt(page, finalInput, question, attached);
        if (await promptHasExpectedText(page, expectedParts)) {
            verified = true;
            break;
        }

        console.log(`>> Prompt text did not stick (attempt ${attempt}/3), retyping...`);
        await dismissAndSettle(page, 500);
    }
    if (!verified) await focusComposer(finalInput);
    markPhase("write");

    console.log(">> Sending prompt...");
    const sendButton = page.locator(SELECTORS.sendButton).first();
    const userMessages = page.locator(SELECTORS.userMessage);
    const userCountBefore = await userMessages.count();

    await trySend(page, sendButton, { requireVisible: true });

    const sentDetected = await page
        .waitForFunction(
            ({ selector, before }) => document.querySelectorAll(selector).length > before,
            { selector: SELECTORS.userMessage, before: userCountBefore },
            { timeout: 5000 }
        )
        .then(() => true)
        .catch(() => false);

    if (!sentDetected) {
        console.log(">> Send may have failed, retrying...");
        await dismissAndSettle(page);
        const retryInput = promptInput(page);
        if ((await retryInput.count()) > 0) {
            await focusComposer(retryInput);
        }
        await trySend(page, sendButton);
        await page.waitForTimeout(2000);
    }
    markPhase("send");

    return assistantCountBefore;
}

async function findCopyButton(page, answer) {
    const parent = answer.locator("xpath=..");
    const tiers = [
        SELECTORS.copyButton,
        'button[aria-label*="copy" i]:not([aria-label*="code" i]):not([aria-label*="image" i])',
    ];
    for (const selector of tiers) {
        for (const scope of [answer, parent, page]) {
            const button = scope.locator(selector).last();
            if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
                return button;
            }
        }
    }
    return null;
}

async function extractAnswerMarkdown(page, answer) {
    await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});

    const copyButton = await findCopyButton(page, answer);
    if (!copyButton) return null;

    await answer.hover({ timeout: 2000 }).catch(() => {});
    try {
        await copyButton.click({ timeout: 5000 });
    } catch {
        try {
            await copyButton.click({ timeout: 3000, force: true });
        } catch {
            return null;
        }
    }

    await page.waitForTimeout(400);
    const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    return typeof text === "string" && text.trim() ? text : null;
}

async function waitForAnswer(page, assistantCountBefore = 0) {
    const replies = page.locator(SELECTORS.assistantMessage);
    await page.waitForFunction(
        ({ selector, countBefore }) => document.querySelectorAll(selector).length > countBefore,
        { selector: SELECTORS.assistantMessage, countBefore: assistantCountBefore },
        { timeout: 60000 }
    );

    let stableCount = 0;
    let prevLength = -1;
    const answer = replies.last();
    await answer.waitFor({ state: "visible", timeout: 60000 });

    while (stableCount < STABLE_POLLS_REQUIRED) {
        await page.waitForTimeout(POLL_MS);

        const count = await replies.count();
        const stopButton = page.locator(SELECTORS.stopButton).first();
        const stopVisible = await stopButton.isVisible().catch(() => false);

        let lastLength = 0;
        if (count > assistantCountBefore) {
            const text = await answer.innerText().catch(() => "");
            lastLength = text.trim().length;
        }

        const unchanged = count > assistantCountBefore && lastLength === prevLength && lastLength > 0 && !stopVisible;
        stableCount = unchanged ? stableCount + 1 : 0;
        prevLength = lastLength;
    }

    markPhase("generate");
    let markdown = await extractAnswerMarkdown(page, answer);
    if (markdown) {
        console.log(">> Raw Markdown captured via copy button.");
    } else {
        console.log(">> Copy button unavailable, falling back to rendered text.");
        markdown = await answer.innerText();
    }
    markPhase("extract");
    return markdown;
}

async function runLoginFlow(page) {
    console.log(">> Starting login flow. Please log in with your account (up to 10 min)...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    const startTime = Date.now();
    const maxWait = 10 * 60 * 1000;

    while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(2000);

        if (!isOnAuthPage(page)) {
            await dismissBlockingUI(page);

            const input = promptInput(page);
            if (await input.count() > 0) {
                try {
                    await input.waitFor({ state: "visible", timeout: 5000 });
                    await waitForEnabled(page, input);
                    await input.click({ timeout: 5000 });
                    console.log(">> Login detected. Session saved in the browser profile for future runs.");
                    return;
                } catch {}
            }
        }

        if (isOnAuthPage(page)) {
            const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
            if (/welcome back|sign.in|log.in/i.test(bodyText) && !bodyText.includes("#prompt-textarea")) {
                continue;
            }
        }
    }

    throw new Error("Login timed out after 10 minutes. Please try again.");
}

function markProfileClean(profileDir) {
    try {
        const prefsPath = path.join(profileDir, "Default", "Preferences");
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
        prefs.profile = prefs.profile || {};
        prefs.profile.exit_type = "Normal";
        prefs.profile.exited_cleanly = true;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch {}
}

function clearSessionData(profileDir) {
    try {
        const localStoragePath = path.join(profileDir, "Default", "Local Storage", "leveldb");
        if (fs.existsSync(localStoragePath)) {
            const files = fs.readdirSync(localStoragePath).filter((f) => f.endsWith(".log") || f.endsWith(".ldb"));
            for (const file of files) {
                try {
                    fs.unlinkSync(path.join(localStoragePath, file));
                } catch {}
            }
        }
    } catch {}
}

function wantsClearSession() {
    return CLI.clearSession;
}

function loadConversations() {
    try {
        const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, "utf8"));
        return Array.isArray(data.conversations) ? data : { conversations: [] };
    } catch {
        return { conversations: [] };
    }
}

function saveConversations(data) {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function clearAllConversations() {
    try {
        fs.unlinkSync(CONVERSATIONS_FILE);
    } catch {}
    console.log(`>> Cleared all saved conversation history (${CONVERSATIONS_FILE}).`);
}

function clearConversationById(idPrefix) {
    const data = loadConversations();
    const needle = idPrefix.toLowerCase();
    const matches = data.conversations.filter((conversation) =>
        String(conversation.id || "").toLowerCase().startsWith(needle)
    );
    if (matches.length === 0) {
        console.log(`>> No saved conversation matches id "${idPrefix}".`);
        return;
    }
    const matchedIds = new Set(matches.map((conversation) => conversation.id));
    data.conversations = data.conversations.filter((conversation) => !matchedIds.has(conversation.id));
    saveConversations(data);
    console.log(`>> Removed ${matches.length} saved conversation(s):`);
    for (const conversation of matches) {
        console.log(`   - ${conversation.id}${conversation.title ? ` ("${conversation.title}")` : ""}`);
    }
}

function latestConversation() {
    return (
        loadConversations().conversations.find(
            (conversation) => Array.isArray(conversation.messages) && conversation.messages.length > 0
        ) || null
    );
}

function buildContinuationPrompt(history, newQuestion) {
    const transcript = history
        .map((message) => `${message.role === "assistant" ? "[Assistant]" : "[User]"}: ${message.content}`)
        .join("\n\n");
    return [
        "I am resuming an earlier conversation we had. Here is that conversation verbatim:",
        "",
        "--- PREVIOUS CONVERSATION START ---",
        transcript,
        "--- PREVIOUS CONVERSATION END ---",
        "",
        "Treat everything above as our shared context and remember it.",
        "",
        `My new message: ${newQuestion}`,
    ].join("\n");
}

async function recordConversation(page, run) {
    try {
        let match = page.url().match(CONVERSATION_URL_RE);
        const deadline = Date.now() + 2000;
        while (!match && Date.now() < deadline) {
            await page.waitForTimeout(250);
            match = page.url().match(CONVERSATION_URL_RE);
        }

        const title = (await page.title().catch(() => "")).replace(/\s*-\s*ChatGPT\s*$/i, "").trim();
        const seedMessages = Array.isArray(run.seedMessages) ? run.seedMessages : [];
        const entry = {
            id: match ? match[1] : crypto.randomUUID(),
            url: match ? `${URL}c/${match[1]}` : null,
            title: title || run.questionText.slice(0, 60),
            updatedAt: new Date().toISOString(),
            messages: [
                ...seedMessages,
                { role: "user", content: run.questionText },
                { role: "assistant", content: run.answer },
            ],
        };

        const data = loadConversations();
        data.conversations = [
            entry,
            ...data.conversations.filter((conversation) => conversation.id !== entry.id),
        ].slice(0, MAX_SAVED_CONVERSATIONS);
        saveConversations(data);
        return entry;
    } catch (error) {
        console.warn(`>> Failed to save conversation history locally: ${firstLine(error)}`);
        return null;
    }
}

function loadBrowserPrefs() {
    try {
        return JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
    } catch {
        return {};
    }
}

function saveBrowserPrefs(prefs) {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), "utf8");
}

function browserLabel(browser) {
    return browser.name.charAt(0).toUpperCase() + browser.name.slice(1);
}

function browserByName(name) {
    return BROWSERS.find((browser) => browser.name === name);
}

function availabilityHint(browser) {
    return browser.executablePath && !fs.existsSync(browser.executablePath) ? " (not found on this machine)" : "";
}

function orderedBrowsers() {
    const prefs = loadBrowserPrefs();
    const savedOrder = Array.isArray(prefs.browserOrder)
        ? prefs.browserOrder.map(browserByName).filter(Boolean)
        : [];
    const seen = new Set(savedOrder.map((browser) => browser.name));
    const list = [...savedOrder, ...BROWSERS.filter((browser) => !seen.has(browser.name))];

    const preferred = prefs.defaultBrowser ? browserByName(prefs.defaultBrowser) : null;
    if (preferred) {
        return [preferred, ...list.filter((browser) => browser !== preferred)];
    }
    return list;
}

function promptUser(promptText) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(promptText, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function configureDefaultBrowser() {
    const prefs = loadBrowserPrefs();

    console.log("\nBrowser configuration\n");
    console.log(
        `Current default: ${
            prefs.defaultBrowser && browserByName(prefs.defaultBrowser)
                ? browserLabel(browserByName(prefs.defaultBrowser))
                : `${browserLabel(BROWSERS[0])} (automatic)`
        }\n`
    );
    BROWSERS.forEach((browser, index) => {
        console.log(`${index + 1}. ${browserLabel(browser)}${availabilityHint(browser)}`);
    });

    const answer = await promptUser("\nEnter number to change default (Enter keeps current): ");
    if (!answer) {
        console.log(">> Default unchanged.");
        return;
    }

    if (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > BROWSERS.length) {
        console.log(">> Invalid selection, default unchanged.");
        return;
    }

    const chosen = BROWSERS[Number(answer) - 1];
    prefs.defaultBrowser = chosen.name;
    saveBrowserPrefs(prefs);
    console.log(`\n✓ Default browser changed to ${browserLabel(chosen)}.`);
}

async function configureBrowserOrder() {
    const prefs = loadBrowserPrefs();
    const current = orderedBrowsers();

    console.log("\nCurrent order:");
    current.forEach((browser, index) => {
        console.log(`${index + 1}. ${browserLabel(browser)}${availabilityHint(browser)}`);
    });

    const answer = await promptUser("\nEnter new order (e.g. 2,1,3): ");
    const indices = answer
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n));

    const isValid =
        indices.length === BROWSERS.length &&
        new Set(indices).size === BROWSERS.length &&
        indices.every((n) => n >= 1 && n <= BROWSERS.length);

    if (!isValid) {
        console.log(`>> Invalid order (need a permutation of 1-${BROWSERS.length}), unchanged.`);
        return;
    }

    prefs.browserOrder = indices.map((n) => BROWSERS[n - 1].name);
    saveBrowserPrefs(prefs);
    console.log(
        `\n✓ Browser order updated: ${prefs.browserOrder.map((name) => browserLabel(browserByName(name))).join(", ")}.`
    );
}

function resetBrowserPreferences() {
    try {
        fs.unlinkSync(PREFS_FILE);
    } catch {}
    console.log("✓ Browser preferences reset to automatic (Chrome first).");
}

async function launchBrowser() {
    const browsersToTry = orderedBrowsers();
    let lastError;
    for (const browser of browsersToTry) {
        if (browser.executablePath && !fs.existsSync(browser.executablePath)) continue;
        markProfileClean(browser.profileDir);
        if (wantsClearSession()) {
            console.log(`>> --clear-session: wiping saved local storage for ${browser.name}`);
            clearSessionData(browser.profileDir);
        }
        try {
            const context = await chromium.launchPersistentContext(browser.profileDir, {
                channel: browser.channel,
                executablePath: browser.executablePath,
                headless: false,
                viewport: null,
                args: [
                    "--disable-blink-features=AutomationControlled",
                    "--hide-crash-restore-bubble",
                    "--disable-session-crashed-bubble",
                    "--no-first-run",
                    "--no-default-browser-check",
                ],
            });
            console.log(`>> Browser: ${browser.name} (profile: ${browser.profileDir})`);
            return context;
        } catch (error) {
            console.log(`>> ${browser.name} failed to launch (${firstLine(error)}), trying next browser...`);
            lastError = error;
        }
    }
    throw new Error(`No browser could be launched (tried: ${browsersToTry.map((b) => b.name).join(", ")}). ${lastError?.message || ""}`);
}

function loadQuestion() {
    const question = parseQuestion();
    question.files = loadFiles(question.files);
    return question;
}

async function main() {
    if (CLI.showHelp) return showHelp();
    if (CLI.showVersion) return console.log(`ChatGPT CLI v${VERSION}`);

    if (CLI.configureBrowser) return configureDefaultBrowser();
    if (CLI.configureBrowserOrder) return configureBrowserOrder();
    if (CLI.resetBrowserPrefs) return resetBrowserPreferences();

    if (CLI.clearConversations) return clearAllConversations();
    if (CLI.clearConversationId) return clearConversationById(CLI.clearConversationId);

    let targetUrl = URL;
    let continuing = null;
    if (!CLI.login && CLI.continueLast) {
        continuing = latestConversation();
        if (!continuing) {
            throw new Error("No saved conversation found. Run a question first, then use --continue.");
        }
    }

    const loginOnly = wantsLogin();
    const question = loginOnly ? null : loadQuestion();
    if (question && continuing) {
        question.originalText = question.text;
        question.text = buildContinuationPrompt(continuing.messages || [], question.text);
    }

    const context = await launchBrowser();
    markPhase("browser");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("\n>> Closing browser...");
        await context.close().catch(() => {});
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages()) {
        if (extra !== page) await extra.close().catch(() => {});
    }

    try {
        if (loginOnly) {
            await runLoginFlow(page);
            return;
        }
        if (continuing) {
            console.log(
                `>> Replaying ${continuing.messages.length} saved message(s) into a fresh chat${continuing.title ? ` ("${continuing.title}")` : ""}`
            );
        }
        const assistantCountBefore = await sendQuestion(page, question, targetUrl);
        const answer = await waitForAnswer(page, assistantCountBefore);
        console.log("\n--- ANSWER ---\n");
        console.log(answer.trim());
        fs.writeFileSync(CLI.outputFile, answer.trim() + "\n", "utf8");
        const conversation = await recordConversation(page, {
            questionText: question.originalText ?? question.text,
            answer: answer.trim(),
            seedMessages: continuing?.messages || [],
        });
        markPhase("save");
        printTimings();
        console.log(`\n>> Answer saved to ${CLI.outputFile}`);
        if (conversation) {
            console.log(
                `>> Conversation history saved locally (${conversation.id}, ${conversation.messages.length} messages). Continue with \`node index.js --continue\`.`
            );
        }
    } finally {
        await context.close();
    }
}

main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
});
