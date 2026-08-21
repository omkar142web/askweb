require("dotenv").config();

const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

const URL = "https://chatgpt.com/";
const PROFILE_DIR = "./user-data";
const POLL_MS = 1000;
const STABLE_POLLS_REQUIRED = 3;

const SELECTORS = {
    promptInput: "#prompt-textarea",
    sendButton: '[data-testid="send-button"]',
    stopButton: '[data-testid="stop-button"]',
    assistantMessage: '[data-message-author-role="assistant"]',
};

chromium.use(stealth);

function getQuestion() {
    const fromArgs = process.argv.slice(2).join(" ").trim();
    return fromArgs || "What is JavaScript?";
}

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
    await page.keyboard.type(question, { delay: 25 });
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

    const count = await replies.count();
    return replies.nth(count - 1).innerText();
}

async function main() {
    const question = getQuestion();

    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        viewport: null,
        args: ["--disable-blink-features=AutomationControlled"],
    });

    const page = context.pages()[0] || await context.newPage();

    try {
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
