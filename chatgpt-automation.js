// ============================================================
//  chatgpt-automation.js
//  A robust script to automate ChatGPT interactions using
//  Playwright Extra with Stealth.
// ============================================================

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

// ------------------------------------------------------------------
//  Configuration (can be overridden via environment variables)
// ------------------------------------------------------------------
const CONFIG = {
  url: process.env.CHATGPT_URL || "https://chatgpt.com/",
  loginUrl: process.env.CHATGPT_LOGIN_URL || "https://chatgpt.com/auth/login",
  pollMs: parseInt(process.env.POLL_MS, 10) || 1000,
  stablePollsRequired: parseInt(process.env.STABLE_POLLS, 10) || 3,
  maxFileChars: parseInt(process.env.MAX_FILE_CHARS, 10) || 150000,
  defaultQuestion: process.env.DEFAULT_QUESTION || "What is JavaScript?",
  outputFile: process.env.OUTPUT_FILE || "./output.md",
  loginTimeout: parseInt(process.env.LOGIN_TIMEOUT_SEC, 10) * 1000 || 10 * 60 * 1000,
  pageTimeout: parseInt(process.env.PAGE_TIMEOUT_SEC, 10) * 1000 || 60000,
  attachTimeout: parseInt(process.env.ATTACH_TIMEOUT_SEC, 10) * 1000 || 15000,
  answerTimeout: parseInt(process.env.ANSWER_TIMEOUT_SEC, 10) * 1000 || 120000,
};

// ------------------------------------------------------------------
//  Browser definitions (order matters – first available is used)
// ------------------------------------------------------------------
const BROWSERS = [
  {
    name: "brave",
    executablePath: process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
      : null,
    profileDir: "./user-data-brave",
  },
  {
    name: "chrome",
    channel: "chrome",
    profileDir: "./user-data-chrome",
  },
  {
    name: "edge",
    channel: "msedge",
    profileDir: "./user-data-edge",
  },
];

// ------------------------------------------------------------------
//  Selectors (kept as constants for easy maintenance)
// ------------------------------------------------------------------
const SELECTORS = {
  promptInput: "#prompt-textarea",
  sendButton: '[data-testid="send-button"]',
  stopButton: '[data-testid="stop-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  attachButton: '[data-testid="composer-plus-btn"]',
  noAuthModal: '[data-testid="modal-no-auth-login"]',
  roleDialog: '[role="dialog"]',
};

// Patterns to dismiss popups / modal overlays
const DISMISS_PATTERNS = [
  { text: /stay\s*logged\s*out/i, label: "Stay logged out" },
  { text: /use\s+without\s+signing\s*in/i, label: "Use without signing in" },
  { text: /use\s+chatgpt\s+without\s+an?\s+account/i, label: "Use without account" },
  { text: /^skip$/i, label: "Skip" },
  { text: /^close$/i, label: "Close" },
  { text: /^accept\s*all$/i, label: "Accept all cookies" },
  { text: /^got\s*it$/i, label: "Got it" },
  { text: /^dismiss$/i, label: "Dismiss" },
  { text: /^continue$/i, label: "Continue" },
];

// ------------------------------------------------------------------
//  Utility functions
// ------------------------------------------------------------------

/** Simple command-line argument parser (supports --login, --clear-session, --output, and question with @files) */
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    login: false,
    clearSession: false,
    output: CONFIG.outputFile,
    questionText: "",
    fileRefs: [],
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--login") {
      result.login = true;
      i++;
    } else if (arg === "--clear-session") {
      result.clearSession = true;
      i++;
    } else if (arg === "--output" && i + 1 < args.length) {
      result.output = args[i + 1];
      i += 2;
    } else if (arg === "--help") {
      console.log(`
Usage: node chatgpt-automation.js [options] [question with @file references]

Options:
  --login            Log in manually and save session (skip question)
  --clear-session    Clear saved session data before starting
  --output <file>    Save answer to <file> (default: ${CONFIG.outputFile})
  --help             Show this help

Question can include text and file references like: "Analyze @file1.txt @file2.js"
      `);
      process.exit(0);
    } else {
      // Everything else is part of the question (including @file references)
      // We join the rest and parse later
      const rest = args.slice(i).join(" ");
      const parsed = parseQuestionString(rest);
      result.questionText = parsed.text;
      result.fileRefs = parsed.files;
      break;
    }
  }
  return result;
}

/** Parse a string containing text and @file references */
function parseQuestionString(str) {
  const tokens = str.match(/(?:[^\s"]+|"[^"]*"|'[^']*')+/g) || [];
  const textParts = [];
  const fileRefs = [];

  for (let token of tokens) {
    // Remove surrounding quotes
    token = token.replace(/^["']|["']$/g, "");
    if (token.startsWith("@") && token.length > 1) {
      fileRefs.push(token.slice(1));
    } else {
      textParts.push(token);
    }
  }

  return {
    text: textParts.join(" ").trim(),
    files: fileRefs,
  };
}

/** Load file contents, truncate if needed, and return as an array of file objects */
function loadFiles(fileRefs) {
  return fileRefs.map((ref) => {
    const fullPath = path.resolve(ref);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      throw new Error(`Not a file: ${fullPath}`);
    }

    let content = fs.readFileSync(fullPath, "utf8");
    const truncated = content.length > CONFIG.maxFileChars;
    if (truncated) content = content.slice(0, CONFIG.maxFileChars);

    return {
      name: path.basename(fullPath),
      fullPath,
      content,
      truncated,
    };
  });
}

/** Build a base64-encoded file block for pasting into the prompt */
function fileBlock(file) {
  const encoded = Buffer.from(file.content, "utf8").toString("base64");
  const truncNote = file.truncated
    ? `\n(${file.name} was truncated to ${CONFIG.maxFileChars} chars)`
    : "";
  return `\n\n<file name="${file.name}" encoding="base64">\n${encoded}\n</file>${truncNote}`;
}

const DECODE_NOTE =
  "\n\nThe file contents above are base64-encoded UTF-8. Decode each file before analyzing it.";

/** Wait for a selector to be visible and enabled (if it's an input) */
async function waitForVisibleAndEnabled(page, selector, timeout = CONFIG.pageTimeout) {
  const element = page.locator(selector).first();
  await element.waitFor({ state: "visible", timeout });
  // Check if it's an input/textarea and enabled
  const enabled = await page
    .evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          return !el.disabled && !el.readOnly && el.offsetParent !== null;
        }
        return true;
      },
      selector
    )
    .catch(() => false);
  if (!enabled) {
    throw new Error(`Element "${selector}" is not enabled or not interactive`);
  }
  return element;
}

// ------------------------------------------------------------------
//  Popup / Modal dismissal
// ------------------------------------------------------------------

async function isModalVisible(page) {
  const modal = page.locator(SELECTORS.noAuthModal).first();
  if ((await modal.count()) === 0) return false;
  return modal.isVisible().catch(() => false);
}

async function isDialogVisible(page) {
  if (await isModalVisible(page)) return true;
  const dialog = page.locator(SELECTORS.roleDialog).first();
  if ((await dialog.count()) === 0) return false;
  return dialog.isVisible().catch(() => false);
}

async function clickDismissButton(page) {
  for (const pattern of DISMISS_PATTERNS) {
    const candidates = page
      .locator('button, [role="button"], a')
      .filter({ hasText: pattern.text });
    const count = await candidates.count();
    for (let i = 0; i < count; i++) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      console.log(`[Dismiss] Clicking "${pattern.label}"...`);
      try {
        await candidate.click({ timeout: 3000 });
      } catch {
        await candidate.click({ timeout: 3000, force: true }).catch(() => {});
      }
      return true;
    }
  }
  return false;
}

async function dismissBlockingUI(page) {
  if (!(await isDialogVisible(page))) return;

  // Try up to 3 times to click a dismiss button
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await isDialogVisible(page))) break;
    const clicked = await clickDismissButton(page);
    if (!clicked) break;
    await page.waitForTimeout(500);
    // Wait for modal to disappear
    await page
      .locator(SELECTORS.noAuthModal)
      .first()
      .waitFor({ state: "hidden", timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(300);
  }

  // If still visible, press Escape
  if (await isDialogVisible(page)) {
    console.log("[Dismiss] Pressing Escape...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
}

// ------------------------------------------------------------------
//  ChatGPT page interactions
// ------------------------------------------------------------------

async function isPromptReady(page) {
  try {
    const input = page.locator(SELECTORS.promptInput).first();
    if ((await input.count()) === 0) return false;
    if (!(await input.isVisible())) return false;
    const enabled = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && !el.disabled && !el.readOnly && el.offsetParent !== null;
    }, SELECTORS.promptInput);
    if (!enabled) return false;
    // No modal blocking
    return !(await isModalVisible(page));
  } catch {
    return false;
  }
}

async function waitForChatGPTReady(page) {
  console.log("Waiting for ChatGPT to be ready...");
  await page.goto(CONFIG.url, { waitUntil: "domcontentloaded", timeout: CONFIG.pageTimeout });
  await page.waitForTimeout(2000);

  const deadline = Date.now() + CONFIG.loginTimeout;
  while (Date.now() < deadline) {
    if (await isModalVisible(page)) await dismissBlockingUI(page);
    if (await isPromptReady(page)) {
      console.log("ChatGPT is ready.");
      return;
    }
    await page.waitForTimeout(CONFIG.pollMs);
  }
  throw new Error("ChatGPT did not become ready within timeout. Run with --login to log in manually.");
}

async function waitForPromptInput(page) {
  try {
    await waitForVisibleAndEnabled(page, SELECTORS.promptInput, CONFIG.pageTimeout);
    const input = page.locator(SELECTORS.promptInput).first();
    await input.click({ force: true });
    await page.waitForTimeout(500);
    return input;
  } catch {
    console.log("Prompt input not found. Waiting for manual login...");
    const start = Date.now();
    while (Date.now() - start < CONFIG.loginTimeout) {
      await page.waitForTimeout(2000);
      await dismissBlockingUI(page);
      try {
        await waitForVisibleAndEnabled(page, SELECTORS.promptInput, 5000);
        const input = page.locator(SELECTORS.promptInput).first();
        await input.click({ force: true });
        await page.waitForTimeout(500);
        return input;
      } catch {}
    }
    throw new Error("Prompt input not found after waiting. Please log in manually.");
  }
}

// ------------------------------------------------------------------
//  File attachment strategies
// ------------------------------------------------------------------

async function waitForAttachmentChip(page, fileName) {
  try {
    await page.waitForFunction(
      (name) => {
        const text = document.body.innerText;
        if (text.includes(name)) return true;
        const stem = name.replace(/\.[^.]+$/, "");
        return stem.length > 3 && text.includes(stem);
      },
      fileName,
      { timeout: CONFIG.attachTimeout }
    );
    return true;
  } catch {
    return false;
  }
}

async function attachViaDrop(page, files) {
  const input = page.locator(SELECTORS.promptInput).first();
  await input.click();
  for (const file of files) {
    const b64 = fs.readFileSync(file.fullPath).toString("base64");
    await page.evaluate(
      ({ b64, name }) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const ext = name.split(".").pop() || "";
        const mimeMap = {
          js: "text/javascript",
          txt: "text/plain",
          md: "text/markdown",
          json: "application/json",
          py: "text/x-python",
          csv: "text/csv",
        };
        const file = new File([bytes], name, { type: mimeMap[ext] || "text/plain" });
        const dt = new DataTransfer();
        dt.items.add(file);
        const target = document.querySelector("#prompt-textarea");
        if (target) {
          for (const type of ["dragenter", "dragover", "drop"]) {
            target.dispatchEvent(
              new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
            );
          }
        }
      },
      { b64, name: file.name }
    );
    const attached = await waitForAttachmentChip(page, file.name);
    if (!attached) throw new Error(`Drop attach failed for "${file.name}"`);
  }
  return "drop";
}

async function attachViaFileInput(page, files) {
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count();
  if (count === 0) throw new Error("No file input found");
  let lastError;
  for (let i = count - 1; i >= 0; i--) {
    try {
      await inputs.nth(i).setInputFiles(files.map((f) => f.fullPath), { timeout: 5000 });
      // Check first file
      if (!(await waitForAttachmentChip(page, files[0].name))) {
        throw new Error("Chip not visible");
      }
      return "file-input";
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("File input attach failed");
}

async function attachViaChooser(page, files) {
  const chooserPromise = page.waitForEvent("filechooser", { timeout: CONFIG.attachTimeout });
  await page.locator(SELECTORS.attachButton).first().click();
  let chooser;
  try {
    chooser = await chooserPromise;
  } catch {
    // Try clicking a menu item that says "Upload" or similar
    const menuItem = page
      .locator('[role="menuitem"], [role="menu"] button, [role="dialog"] button')
      .filter({ hasText: /file|upload|computer|photos/i })
      .first();
    await menuItem.click({ timeout: 4000 });
    chooser = await page.waitForEvent("filechooser", { timeout: CONFIG.attachTimeout });
  }
  await chooser.setFiles(files.map((f) => f.fullPath));
  if (!(await waitForAttachmentChip(page, files[0].name))) {
    throw new Error("Chip not visible after chooser attach");
  }
  return "chooser";
}

async function attachFiles(page, files) {
  const strategies = [attachViaDrop, attachViaFileInput, attachViaChooser];
  let lastError;
  for (const strategy of strategies) {
    try {
      const method = await strategy(page, files);
      console.log(`[Attach] Success using "${method}" strategy.`);
      await page.waitForTimeout(1500);
      return;
    } catch (err) {
      lastError = err;
      console.log(`[Attach] ${strategy.name} failed: ${err.message}`);
    }
  }
  throw new Error(`All attachment strategies failed. Last error: ${lastError?.message}`);
}

// ------------------------------------------------------------------
//  Sending the question
// ------------------------------------------------------------------

async function typePrompt(page, input, question, filesAttached) {
  if (await isDialogVisible(page)) await dismissBlockingUI(page);

  await input.click({ force: true });
  await input.focus();

  // Clear existing text
  await input.fill("");

  // Type the question text
  if (question.text) {
    await input.fill(question.text);
  }

  // If files were not attached via UI, paste their contents as base64 blocks
  if (!filesAttached && question.files.length > 0) {
    for (const file of question.files) {
      await page.keyboard.insertText(fileBlock(file));
    }
    await page.keyboard.insertText(DECODE_NOTE);
  }

  await page.waitForTimeout(800);
}

async function sendQuestion(page, question) {
  // Ensure ChatGPT is ready
  await waitForChatGPTReady(page);
  const input = await waitForPromptInput(page);

  // Attempt to attach files via UI
  let filesAttached = false;
  if (question.files.length > 0) {
    try {
      await attachFiles(page, question.files);
      filesAttached = true;
      console.log(`[Attach] ${question.files.length} file(s) attached.`);
    } catch (err) {
      console.log(`[Attach] UI attach failed, falling back to pasting content. Reason: ${err.message}`);
    }
  }

  // Type the prompt
  console.log("Typing prompt...");
  await typePrompt(page, input, question, filesAttached);

  // Click send button
  console.log("Sending...");
  const sendButton = page.locator(SELECTORS.sendButton).first();
  if ((await sendButton.count()) > 0 && (await sendButton.isVisible().catch(() => false))) {
    try {
      await sendButton.click({ timeout: 5000 });
    } catch {
      await page.keyboard.press("Enter");
    }
  } else {
    await page.keyboard.press("Enter");
  }

  // Wait for the user message to appear (confirms send)
  await page.waitForTimeout(2000);
  const userMessages = page.locator('[data-message-author-role="user"]');
  const count = await userMessages.count();
  if (count === 0) {
    console.log("Send may have failed, retrying with Enter...");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
  }
}

// ------------------------------------------------------------------
//  Waiting for the assistant's answer
// ------------------------------------------------------------------

async function waitForAnswer(page) {
  console.log("Waiting for answer...");
  const replies = page.locator(SELECTORS.assistantMessage);
  await replies.first().waitFor({ state: "visible", timeout: CONFIG.answerTimeout });

  let stableCount = 0;
  let prevCount = -1;
  let prevLength = -1;

  while (stableCount < CONFIG.stablePollsRequired) {
    await page.waitForTimeout(CONFIG.pollMs);

    const count = await replies.count();
    const stopButton = page.locator(SELECTORS.stopButton).first();
    const stopVisible = await stopButton.isVisible().catch(() => false);

    let lastLength = 0;
    if (count > 0) {
      const text = await replies.nth(count - 1).innerText().catch(() => "");
      lastLength = text.trim().length;
    }

    // Stable if: same count, same length, length > 0, and no stop button
    const unchanged = count === prevCount && lastLength === prevLength && lastLength > 0 && !stopVisible;
    stableCount = unchanged ? stableCount + 1 : 0;
    prevCount = count;
    prevLength = lastLength;
  }

  const finalCount = await replies.count();
  if (finalCount === 0) throw new Error("No assistant reply found.");
  const answer = await replies.nth(finalCount - 1).innerText();
  console.log("Answer received.");
  return answer.trim();
}

// ------------------------------------------------------------------
//  Login flow (manual)
// ------------------------------------------------------------------

async function runLoginFlow(page) {
  console.log("Starting manual login. Please log in within 10 minutes...");
  await page.goto(CONFIG.loginUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.pageTimeout });
  await page.waitForTimeout(2000);

  const start = Date.now();
  while (Date.now() - start < CONFIG.loginTimeout) {
    await page.waitForTimeout(2000);
    // If we are no longer on a login page, check if prompt is visible
    const url = page.url();
    if (!url.includes("/auth/login") && !url.includes("/auth/signin")) {
      await dismissBlockingUI(page);
      if (await isPromptReady(page)) {
        console.log("Login successful. Session saved.");
        return;
      }
    }
    // Check if the page shows a login form (continue waiting)
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/welcome back|sign in|log in/i.test(bodyText)) {
      continue;
    }
  }
  throw new Error("Login timed out after 10 minutes.");
}

// ------------------------------------------------------------------
//  Browser management
// ------------------------------------------------------------------

function markProfileClean(profileDir) {
  try {
    const prefsPath = path.join(profileDir, "Default", "Preferences");
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
      prefs.profile = prefs.profile || {};
      prefs.profile.exit_type = "Normal";
      prefs.profile.exited_cleanly = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch {}
}

function clearSessionData(profileDir) {
  try {
    const leveldbPath = path.join(profileDir, "Default", "Local Storage", "leveldb");
    if (fs.existsSync(leveldbPath)) {
      const files = fs.readdirSync(leveldbPath).filter((f) => f.endsWith(".log") || f.endsWith(".ldb"));
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(leveldbPath, file));
        } catch {}
      }
      console.log("[Session] Local storage cleared.");
    }
  } catch {}
}

async function launchBrowser(options = { clearSession: false }) {
  let lastError;
  for (const browserDef of BROWSERS) {
    // Skip if executablePath is set but does not exist (e.g., Brave on non-Windows)
    if (browserDef.executablePath && !fs.existsSync(browserDef.executablePath)) {
      continue;
    }

    const profileDir = browserDef.profileDir;
    // Ensure profile directory exists
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    markProfileClean(profileDir);
    if (options.clearSession) {
      clearSessionData(profileDir);
    }

    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        channel: browserDef.channel,
        executablePath: browserDef.executablePath,
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
      console.log(`[Browser] Launched ${browserDef.name} with profile "${profileDir}"`);
      return context;
    } catch (err) {
      lastError = err;
      console.log(`[Browser] Failed to launch ${browserDef.name}: ${err.message}`);
    }
  }
  throw new Error(`No browser could be launched. Tried: ${BROWSERS.map((b) => b.name).join(", ")}. ${lastError?.message || ""}`);
}

// ------------------------------------------------------------------
//  Main entry point
// ------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  // Build question object only if not in login-only mode
  let question = null;
  if (!args.login) {
    question = {
      text: args.questionText || CONFIG.defaultQuestion,
      files: loadFiles(args.fileRefs),
    };
  }

  // Launch browser
  const context = await launchBrowser({ clearSession: args.clearSession });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down...");
    await context.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const page = context.pages()[0] || (await context.newPage());
  // Close any extra pages
  for (const p of context.pages()) {
    if (p !== page) await p.close().catch(() => {});
  }

  try {
    if (args.login) {
      await runLoginFlow(page);
    } else {
      await sendQuestion(page, question);
      const answer = await waitForAnswer(page);
      console.log("\n--- ANSWER ---\n");
      console.log(answer);
      // Save to output file
      const outFile = args.output || CONFIG.outputFile;
      fs.writeFileSync(outFile, answer + "\n", "utf8");
      console.log(`\nAnswer saved to ${outFile}`);
    }
  } catch (err) {
    console.error("Error:", err.message);
    // Optionally take a screenshot for debugging
    try {
      await page.screenshot({ path: "error-screenshot.png" });
      console.log("Screenshot saved as error-screenshot.png");
    } catch {}
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});