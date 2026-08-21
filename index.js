require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

const URL = "https://chatgpt.com/";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const BROWSERS = [
    { name: "chrome", channel: "chrome", profileDir: "./user-data-chrome" },
    { name: "brave", executablePath: `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, profileDir: "./user-data-brave" },
    { name: "edge", channel: "msedge", profileDir: "./user-data-edge" },
];
const POLL_MS = 1000;
const STABLE_POLLS_REQUIRED = 3;
const MAX_FILE_CHARS = 150000;
const DEFAULT_QUESTION = "What is JavaScript?";
const DEFAULT_OUTPUT_FILE = "./output.md";
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
    attachButton: '[data-testid="composer-plus-btn"]',
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

function parseCliArgs(argv = process.argv.slice(2)) {
    const options = {
        login: false,
        clearSession: false,
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
            throw new Error(`Unknown option: ${arg}`);
        }

        options.questionArgs.push(arg);
    }

    return options;
}

const CLI = parseCliArgs();

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

function looksLikeExistingFile(value) {
    try {
        return fs.existsSync(path.resolve(value)) && fs.statSync(path.resolve(value)).isFile();
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

        let content = fs.readFileSync(fullPath, "utf8");
        const truncated = content.length > MAX_FILE_CHARS;
        if (truncated) content = content.slice(0, MAX_FILE_CHARS);

        return { name: path.basename(fullPath), fullPath, content, truncated };
    });
}

function shouldPasteFiles(files) {
    return files.some((file) => PASTE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase()));
}

function fileBlock(file) {
    const encoded = Buffer.from(file.content, "utf8").toString("base64");
    const truncationNote = file.truncated ? `\n(${file.name} was truncated to ${MAX_FILE_CHARS} chars)` : "";
    return `\n\n<file name="${file.name}" encoding="base64">\n${encoded}\n</file>${truncationNote}`;
}

const DECODE_NOTE = "\n\nThe file contents above are base64-encoded UTF-8. Decode each file before analyzing it.";

const NO_AUTH_MODAL = '[data-testid="modal-no-auth-login"]';
const UPLOAD_OVERLAY_TEXT = /add\s+anything/i;

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
    if (await modalVisible(page)) return true;
    if (await uploadOverlayVisible(page)) return true;
    const blockers = page.locator('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [class*="modal"], [class*="popover"]');
    const count = await blockers.count();
    for (let i = 0; i < count; i++) {
        if (await blockers.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
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

async function resetComposer(page) {
    await dismissBlockingUI(page);
    if (!(await uploadOverlayVisible(page))) return;

    console.log(">> Upload overlay still visible, reloading ChatGPT...");
    await gotoChatGPT(page);
    await page.waitForTimeout(2000);
    await waitForChatGPTReady(page);
}

async function gotoChatGPT(page) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            return;
        } catch (error) {
            lastError = error;
            const message = error.message.split("\n")[0];
            console.log(`>> ChatGPT navigation failed (${message}), retrying ${attempt}/3...`);
            await page.waitForTimeout(3000);
        }
    }
    throw lastError;
}

async function isPromptReady(page) {
    const input = page.locator(SELECTORS.promptInput).first();
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

async function waitForChatGPTReady(page) {
    await gotoChatGPT(page);
    await page.waitForTimeout(2000);

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
        await dismissBlockingUI(page);
        if (await isPromptReady(page)) break;
        await page.waitForTimeout(1000);
    }

    if (!(await isPromptReady(page))) {
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "");
        throw new Error(`Prompt input never became usable at ${page.url()}. Page text: ${pageText.replace(/\s+/g, " ").trim() || "(empty)"}. Run \`node index.js --login\` to log in manually.`);
    }

    const input = page.locator(SELECTORS.promptInput).first();
    try {
        await input.click({ timeout: 10000, force: true });
    } catch {
        await dismissBlockingUI(page);
        await page.waitForTimeout(1000);
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
    const input = page.locator(SELECTORS.promptInput).first();

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
    await page.locator(SELECTORS.promptInput).first().click();
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
        throw new Error(`attachment chip for "${files[0].name}" never appeared`);
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
                throw new Error(`attachment chip for "${files[0].name}" never appeared`);
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
        console.log(`>> File-input attach failed (${inputError.message.split("\n")[0]}), trying chooser...`);
        try {
            await attachViaChooser(page, files);
            return "chooser";
        } catch (chooserError) {
            if (await uploadOverlayVisible(page)) {
                await dismissBlockingUI(page);
                throw new Error(`upload overlay rejected "${files[0].name}"`);
            }
            console.log(`>> Chooser attach failed (${chooserError.message.split("\n")[0]}), trying drag/drop...`);
            try {
                await attachViaDrop(page, files);
                return "drop";
            } catch (dropError) {
                await dismissBlockingUI(page);
                throw new Error(`all attach strategies failed: ${dropError.message.split("\n")[0]}`);
            }
        }
    }
}

function buildFullPrompt(question) {
    const blocks = question.files.map(fileBlock).join("") + DECODE_NOTE;
    return question.text ? `${question.text}\n${blocks}` : blocks;
}

async function typePrompt(page, input, question, attached) {
    await dismissBlockingUI(page);

    await input.click();
    await input.focus();
    await input.fill("");

    const pasteFiles = !attached && question.files.length > 0;
    if (pasteFiles) {
        await page.keyboard.insertText(buildFullPrompt(question));
    } else if (question.text) {
        await input.fill(question.text);
    }

    await page.waitForTimeout(pasteFiles ? 1500 : 800);
}

async function promptHasExpectedText(page, expectedParts) {
    if (expectedParts.length === 0) return true;
    const typed = await page
        .locator(SELECTORS.promptInput)
        .first()
        .evaluate((el) => ("value" in el ? el.value : el.innerText || el.textContent || ""))
        .catch(() => "");
    return expectedParts.every((part) => typed.includes(part));
}

async function sendQuestion(page, question) {
    const input = await waitForChatGPTReady(page);
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
                console.log(`>> Upload failed (${error.message.split("\n")[0]}), falling back to paste.`);
                await resetComposer(page);
            }
        }
    }

    if (!(await isPromptReady(page))) {
        await dismissBlockingUI(page);
        await page.waitForTimeout(1000);
    }

    const finalInput = page.locator(SELECTORS.promptInput).first();
    const expectedParts = [];
    if (question.text) expectedParts.push(question.text.trim().slice(0, 60));
    if (!attached && question.files.length > 0) expectedParts.push("</file>");

    console.log(">> Writing prompt...");
    for (let attempt = 1; attempt <= 3; attempt++) {
        await typePrompt(page, finalInput, question, attached);
        if (await promptHasExpectedText(page, expectedParts)) break;

        console.log(`>> Prompt text did not stick (attempt ${attempt}/3), retyping...`);
        await dismissBlockingUI(page);
        await page.waitForTimeout(500);
    }

    await finalInput.click();
    await finalInput.focus();
    await dismissBlockingUI(page);

    console.log(">> Sending prompt...");
    const sendButton = page.locator(SELECTORS.sendButton).first();
    if (await sendButton.count() > 0 && await sendButton.isVisible().catch(() => false)) {
        try {
            await sendButton.click();
        } catch {
            await page.keyboard.press("Enter");
        }
    } else {
        await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(1500);

    const userMessages = page.locator('[data-message-author-role="user"]');
    const userCount = await userMessages.count();
    if (userCount === 0) {
        console.log(">> Send may have failed, retrying...");
        await dismissBlockingUI(page);
        await page.waitForTimeout(1000);
        const retryInput = page.locator(SELECTORS.promptInput).first();
        if (await retryInput.count() > 0) {
            await retryInput.click();
            await retryInput.focus();
        }
        if (await sendButton.count() > 0) {
            try {
                await sendButton.click({ force: true });
            } catch {
                await page.keyboard.press("Enter");
            }
        } else {
            await page.keyboard.press("Enter");
        }
        await page.waitForTimeout(2000);
    }

    return assistantCountBefore;
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
    const answerIndex = assistantCountBefore;
    const answer = replies.nth(answerIndex);
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

    return answer.innerText();
}

async function runLoginFlow(page) {
    console.log(">> Starting login flow. Please log in with your account (up to 10 min)...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    const startTime = Date.now();
    const maxWait = 10 * 60 * 1000;

    while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(2000);

        if (!page.url().includes("/auth/login") && !page.url().includes("/auth/signin")) {
            await dismissBlockingUI(page);

            const input = page.locator(SELECTORS.promptInput).first();
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

        const currentUrl = page.url();
        if (currentUrl.includes("/auth/login") || currentUrl.includes("/auth/signin")) {
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

async function launchBrowser() {
    let lastError;
    for (const browser of BROWSERS) {
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
            lastError = error;
        }
    }
    throw new Error(`No browser could be launched (tried: ${BROWSERS.map((b) => b.name).join(", ")}). ${lastError?.message || ""}`);
}

function loadQuestion() {
    const question = parseQuestion();
    question.files = loadFiles(question.files);
    return question;
}

async function main() {
    const loginOnly = wantsLogin();
    const question = loginOnly ? null : loadQuestion();

    const context = await launchBrowser();
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
        const assistantCountBefore = await sendQuestion(page, question);
        const answer = await waitForAnswer(page, assistantCountBefore);
        console.log("\n--- ANSWER ---\n");
        console.log(answer.trim());
        fs.writeFileSync(CLI.outputFile, answer.trim() + "\n", "utf8");
        console.log(`\n>> Answer saved to ${CLI.outputFile}`);
    } finally {
        await context.close();
    }
}

main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
});
