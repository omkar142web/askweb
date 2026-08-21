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
    attachButton: '[data-testid="composer-plus-btn"]',
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

        return { name: path.basename(fullPath), fullPath, content, truncated };
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
                for (const type of ["dragenter", "dragover", "drop"]) {
                    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
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

async function attachFiles(page, files) {
    try {
        await attachViaDrop(page, files);
        return "drop";
    } catch (dropError) {
        console.log(`>> Drop attach failed (${dropError.message.split("\n")[0]}), trying chooser...`);
        try {
            await attachViaChooser(page, files);
            return "chooser";
        } catch (chooserError) {
            throw new Error(`all attach strategies failed: ${chooserError.message.split("\n")[0]}`);
        }
    }
}

async function sendQuestion(page, question) {
    const input = await waitForPromptInput(page);
    await input.click();

    let attached = false;
    if (question.files.length > 0) {
        try {
            await attachFiles(page, question.files);
            attached = true;
            console.log(`>> Attached ${question.files.length} file(s) via upload.`);
            await page.waitForTimeout(3000);
        } catch (error) {
            console.log(`>> Upload failed (${error.message.split("\n")[0]}), falling back to paste.`);
        }
    }

    if (question.text) {
        await input.click();
        await input.focus();
        await page.evaluate(() => {
            const el = document.querySelector("#prompt-textarea");
            if (el) {
                el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
            }
        });
        await page.waitForTimeout(300);
        await page.keyboard.type(question.text, { delay: 25 });
    }

    if (!attached) {
        for (const file of question.files) {
            await page.keyboard.insertText(fileBlock(file));
        }
        if (question.files.length > 0) {
            await page.keyboard.insertText(DECODE_NOTE);
        }
    }
    await page.waitForTimeout(800);

    const promptInput = page.locator(SELECTORS.promptInput).first();
    await promptInput.click();
    await promptInput.focus();

    const sendButton = page.locator(SELECTORS.sendButton).first();
    if (await sendButton.count() > 0) {
        await sendButton.click();
    } else {
        await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(1500);

    const userMessages = page.locator('[data-message-author-role="user"]');
    const userCount = await userMessages.count();
    if (userCount === 0) {
        console.log(">> Send may have failed, retrying...");
        if (await sendButton.count() > 0) {
            await sendButton.click({ force: true });
        } else {
            await page.keyboard.press("Enter");
        }
        await page.waitForTimeout(2000);
    }
}

async function waitForAnswer(page) {
    const replies = page.locator(SELECTORS.assistantMessage);
    await replies.first().waitFor({ state: "visible", timeout: 60000 });

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
