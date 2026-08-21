require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

const URL = "https://chatgpt.com/";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const BROWSER_CHANNEL = "chrome";
const PROFILE_DIRS = { chrome: "./user-data-chrome", chromium: "./user-data" };
const POLL_MS = 1000;
const STABLE_POLLS_REQUIRED = 3;
const MAX_FILE_CHARS = 150000;
const DEFAULT_QUESTION = "What is JavaScript?";

const SELECTORS = {
    promptInput: "#prompt-textarea",
    sendButton: '[data-testid="send-button"]',
    stopButton: '[data-testid="stop-button"]',
    assistantMessage: '[data-message-author-role="assistant"]',
};

chromium.use(stealth);

function wantsLogin() {
    return process.argv.slice(2).includes("--login");
}

function parseQuestion() {
    const raw = process.argv.slice(2).join(" ").trim();
    if (!raw) return { text: DEFAULT_QUESTION, files: [] };

    const textParts = [];
    const fileRefs = [];

    for (const token of raw.split(/\s+/)) {
        if (token.startsWith("@") && token.length > 1) {
            fileRefs.push(token.slice(1).replace(/^"+|"+$/g, ""));
        } else {
            textParts.push(token);
        }
    }

    return { text: textParts.join(" "), files: fileRefs };
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

        return { name: path.basename(fullPath), content, truncated };
    });
}

function fileBlock(file) {
    const encoded = Buffer.from(file.content, "utf8").toString("base64");
    const truncationNote = file.truncated ? `\n(${file.name} was truncated to ${MAX_FILE_CHARS} chars)` : "";
    return `\n\n<file name="${file.name}" encoding="base64">\n${encoded}\n</file>${truncationNote}`;
}

const DECODE_NOTE = "\n\nThe file contents above are base64-encoded UTF-8. Decode each file before analyzing it.";

async function waitForPromptInput(page) {
    const input = page.locator(SELECTORS.promptInput).first();
    try {
        await input.waitFor({ state: "visible", timeout: 20000 });
    } catch {
        console.log(">> No prompt box found. Log in to ChatGPT in the opened browser window...");
        await input.waitFor({ state: "visible", timeout: 300000 });
        console.log(">> Login detected, continuing.");
    }
    return input;
}

async function sendQuestion(page, question) {
    const input = await waitForPromptInput(page);
    await input.click();

    if (question.text) {
        await page.keyboard.type(question.text, { delay: 25 });
    }
    for (const file of question.files) {
        await page.keyboard.insertText(fileBlock(file));
    }
    if (question.files.length > 0) {
        await page.keyboard.insertText(DECODE_NOTE);
    }
    await page.waitForTimeout(300);

    const sendButton = page.locator(SELECTORS.sendButton).first();
    if (await sendButton.count() > 0 && await sendButton.isEnabled()) {
        await sendButton.click();
    } else {
        await page.keyboard.press("Enter");
    }
}

async function waitForAnswer(page) {
    const replies = page.locator(SELECTORS.assistantMessage);
    await replies.first().waitFor({ state: "attached", timeout: 60000 });

    let stableCount = 0;
    let prevCount = -1;
    let prevLength = -1;

    while (stableCount < STABLE_POLLS_REQUIRED) {
        await page.waitForTimeout(POLL_MS);

        const count = await replies.count();
        const stopVisible = await page.locator(SELECTORS.stopButton).count() > 0;

        let lastLength = 0;
        if (count > 0) {
            const text = await replies.nth(count - 1).innerText().catch(() => "");
            lastLength = text.trim().length;
        }

        const unchanged = count === prevCount && lastLength === prevLength && lastLength > 0 && !stopVisible;
        stableCount = unchanged ? stableCount + 1 : 0;
        prevCount = count;
        prevLength = lastLength;
    }

    const finalCount = await replies.count();
    return replies.nth(finalCount - 1).innerText();
}

async function launchBrowser() {
    const attempts = [
        { channel: BROWSER_CHANNEL, profileDir: PROFILE_DIRS[BROWSER_CHANNEL] },
        { channel: undefined, profileDir: PROFILE_DIRS.chromium },
    ];

    let lastError;
    for (const attempt of attempts) {
        try {
            const context = await chromium.launchPersistentContext(attempt.profileDir, {
                channel: attempt.channel,
                headless: false,
                viewport: null,
                args: ["--disable-blink-features=AutomationControlled"],
            });
            console.log(`>> Browser: ${attempt.channel || "bundled chromium"} (profile: ${attempt.profileDir})`);
            return context;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

async function runLoginFlow(page) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log(">> Log in with your premium account in the opened window (up to 10 min)...");
    const input = page.locator(SELECTORS.promptInput).first();
    await input.waitFor({ state: "visible", timeout: 600000 });
    console.log(">> Login detected. Session saved in the browser profile for future runs.");
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
    const page = context.pages()[0] || await context.newPage();

    try {
        if (loginOnly) {
            await runLoginFlow(page);
            return;
        }
        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sendQuestion(page, question);
        const answer = await waitForAnswer(page);
        console.log("\n--- ANSWER ---\n");
        console.log(answer.trim());
    } finally {
        await context.close();
    }
}

main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
});
