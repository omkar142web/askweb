#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const crypto = require("crypto");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

const URL = "https://chatgpt.com/?temporary-chat=true";
const LOGIN_URL = "https://chatgpt.com/auth/login";
const APP_DIR = __dirname;
const BROWSERS = [
    { name: "chrome", channel: "chrome", profileDir: path.join(APP_DIR, "user-data-chrome") },
    { name: "brave", executablePath: `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, profileDir: path.join(APP_DIR, "user-data-brave") },
    { name: "edge", channel: "msedge", profileDir: path.join(APP_DIR, "user-data-edge") },
];
const POLL_MS = 1000;
const STABLE_POLLS_REQUIRED = 3;
const MAX_FILE_CHARS = 400000;
const SINGLE_PASTE_MAX = 25000;
const ANON_MAX_PARTS = 6;
// Empirically validated: single anonymous-chat messages up to ~52 KB paste and land fine.
const ANON_PART_SIZE_CEILING = 50000;
const PART_TAG_OVERHEAD = 1000;
const DEFAULT_QUESTION = "What is JavaScript?";
const DEFAULT_OUTPUT_FILE = "./output.md";
const PREFS_FILE = path.join(__dirname, ".browser-prefs.json");
const CONVERSATIONS_FILE = path.join(__dirname, ".chatgpt-conversations.json");
const MAX_SAVED_CONVERSATIONS = 50;
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
const PROMPTS_FILE = path.join(__dirname, ".askweb-prompts.json");
const PROMPT_NAME_RE = /^[-a-z0-9_]+$/i;
const RESERVED_PROMPT_FLAGS = new Set([
    "o", "output", "login", "continue", "new", "browser", "browser-order", "browser-reset",
    "clear-session", "clear-conversations", "clear-conversation", "help", "h", "version", "v",
    "prompts", "prompt-create", "append", "prepend", "logout",
]);

const BUILTIN_PROMPTS = {
    "find-error":
        "You are a meticulous code reviewer. Find every bug, logic error, race condition, or edge-case failure in the attached code. For each issue give: file, location (function/line), severity (critical/major/minor), why it is wrong, and a minimal concrete fix as a diff-style snippet. End with a prioritized summary. Do not pad the report with non-issues.",
    review:
        "Review the attached code like a senior engineer: correctness, readability, naming, structure, error handling, and performance. Point out concrete improvements with short before/after snippets, and call out anything done well. Keep it actionable.",
    refactor:
        "Propose refactoring(s) for the attached code that improve clarity and maintainability WITHOUT changing behavior. Show each refactor as a focused before/after snippet with a one-line rationale. Rank by impact-to-risk ratio.",
    tests:
        "Write thorough unit tests for the attached code. Cover happy paths, edge cases, and failure modes. Use the language's standard/batteries-included test style already implied by the project, and note any behavior you found ambiguous while writing them.",
    summarize:
        "Summarize the attached material: purpose, key points, structure/outline, and anything surprising or noteworthy. Be concise but complete.",
    explain:
        "Explain {{input}} clearly, with concrete examples and a short mental model I can remember.",
    teach:
        "Teach me {{input}} from scratch: prerequisites, core concepts in a logical order, worked examples, common misconceptions, and a short exercise set with answers hidden at the end.",
    generate:
        "Write complete, production-quality code for this task:\n\n{{input}}\n\nRequirements: clean structure, meaningful names, inline error handling, and a brief usage example. Return only the code and the example.",
};

function isValidPromptName(name) {
    return PROMPT_NAME_RE.test(name);
}

function isConflictingPromptName(name) {
    return RESERVED_PROMPT_FLAGS.has(name);
}

function normalizePromptEntry(entry) {
    let prompt;
    let description = "";
    let declaredArguments = null;
    if (typeof entry === "string") {
        prompt = entry;
    } else if (entry && typeof entry === "object" && typeof entry.prompt === "string") {
        prompt = entry.prompt;
        description = String(entry.description || "").trim();
        declaredArguments = typeof entry.arguments === "boolean" ? entry.arguments : null;
    } else {
        return null;
    }
    prompt = prompt.trim();
    if (!prompt) return null;
    const detected = /\{\{\s*input\s*\}\}/.test(prompt);
    return {
        prompt,
        description,
        arguments: declaredArguments === null ? detected : declaredArguments,
    };
}

function readUserPrompts() {
    try {
        const data = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) return {};
        const cleaned = {};
        for (const [name, entry] of Object.entries(data)) {
            const key = name.toLowerCase();
            if (!isValidPromptName(key)) continue;
            const normalized = normalizePromptEntry(entry);
            if (normalized) cleaned[key] = normalized;
        }
        return cleaned;
    } catch {
        return {};
    }
}

function saveUserPrompts(entries) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function loadPromptRegistry() {
    const registry = new Map();
    for (const [name, template] of Object.entries(BUILTIN_PROMPTS)) {
        registry.set(name, { ...normalizePromptEntry(template), builtin: true });
    }
    for (const [name, entry] of Object.entries(readUserPrompts())) {
        registry.set(name, { ...entry, builtin: false });
    }
    return registry;
}

function promptPreview(entry, width = 64) {
    const base = entry.description || entry.prompt.replace(/\s+/g, " ");
    return base.length > width ? `${base.slice(0, width - 3)}...` : base;
}

function printPromptList(registry) {
    const customs = [...registry.values()].filter((p) => !p.builtin).length;
    console.log(`\nPrompt Manager (${registry.size} prompts, ${customs} custom)\n`);
    for (const [name, entry] of registry) {
        const tag = entry.builtin ? "" : "  *";
        console.log(`  ${name.padEnd(16)} ${promptPreview(entry)}${tag}`);
    }
    console.log("");
}

async function promptMultiline(label) {
    console.log(`${label} (finish with an empty line):`);
    const lines = [];
    while (true) {
        const line = await promptUser("> ");
        if (!line) break;
        lines.push(line);
    }
    return lines.join("\n");
}

async function askExistingPromptName(action) {
    const registry = loadPromptRegistry();
    const name = (await promptUser(`Prompt name to ${action}: `)).trim().toLowerCase();
    if (!registry.has(name)) {
        console.log(`>> No prompt named "${name}".`);
        return null;
    }
    return name;
}

async function createPromptFlow(nameArg = "") {
    console.log("\nCreate a prompt preset\n");

    let name = (nameArg || (await promptUser("Prompt name: "))).trim().toLowerCase();
    if (!isValidPromptName(name)) {
        console.log(`>> Invalid name "${name}". Use letters, digits, - or _ only.`);
        return;
    }
    if (isConflictingPromptName(name)) {
        console.log(`>> Error: "${name}" is reserved by the CLI and cannot be used as a prompt name.`);
        return;
    }

    const userEntries = readUserPrompts();
    const registry = loadPromptRegistry();
    const existing = registry.get(name);
    if (existing) {
        const msg = existing.builtin
            ? `"${name}" is a built-in preset. Overwrite it with a custom version? (y/N): `
            : `"${name}" already exists. Overwrite? (y/N): `;
        const overwrite = (await promptUser(msg)).toLowerCase();
        if (overwrite !== "y") {
            console.log(">> Cancelled.");
            return;
        }
    }

    const description = (await promptUser("Short description (optional): ")).trim();
    const prompt = await promptMultiline("Prompt");
    if (!prompt.trim()) {
        console.log(">> Empty prompt, cancelled.");
        return;
    }

    userEntries[name] = { prompt, description };
    saveUserPrompts(userEntries);

    const normalized = normalizePromptEntry(userEntries[name]);
    console.log(
        `\n\u2713 Saved "${name}"${normalized.arguments ? " (arguments enabled via {{input}})" : ""}.` +
            `\n  Run it:   node index.js --${name}${normalized.arguments ? ' "your input"' : ""}` +
            `\n  Manage:   node index.js --prompts`
    );
}

async function runPromptManager() {
    while (true) {
        const registry = loadPromptRegistry();
        printPromptList(registry);
        const choice = (await promptUser("[a] Add  [e] Edit  [r] Rename  [d] Delete  [v] View  [q] Quit > ")).toLowerCase();

        try {
            if (choice.startsWith("q")) break;

            if (choice.startsWith("a")) {
                await createPromptFlow();
                continue;
            }

            if (choice.startsWith("v")) {
                const name = await askExistingPromptName("view");
                if (name) {
                    const entry = loadPromptRegistry().get(name);
                    console.log(`\n--- ${name} ${entry.arguments ? "(takes {{input}})" : ""} ---\n${entry.prompt}\n`);
                }
                continue;
            }

            if (choice.startsWith("e")) {
                const name = await askExistingPromptName("edit");
                if (!name) continue;
                const current = loadPromptRegistry().get(name);
                console.log(`\nCurrent prompt for "${name}":\n${current.prompt}\n`);
                const replacement = await promptMultiline("New prompt (empty line cancels)");
                if (!replacement.trim()) {
                    console.log(">> Unchanged.");
                    continue;
                }
                const userEntries = readUserPrompts();
                userEntries[name] = { prompt: replacement, description: current.description };
                saveUserPrompts(userEntries);
                console.log(`\u2713 Updated "${name}".`);
                continue;
            }

            if (choice.startsWith("r")) {
                const name = await askExistingPromptName("rename");
                if (!name) continue;
                const newName = (await promptUser("New name: ")).trim().toLowerCase();
                if (!isValidPromptName(newName)) {
                    console.log(`>> Invalid name "${newName}". Use letters, digits, - or _ only.`);
                    continue;
                }
                if (isConflictingPromptName(newName)) {
                    console.log(`>> Error: "${newName}" is reserved by the CLI and cannot be used as a prompt name.`);
                    continue;
                }
                if (loadPromptRegistry().has(newName)) {
                    console.log(`>> "${newName}" already exists.`);
                    continue;
                }
                const userEntries = readUserPrompts();
                if (Object.prototype.hasOwnProperty.call(userEntries, name)) {
                    userEntries[newName] = userEntries[name];
                    delete userEntries[name];
                    saveUserPrompts(userEntries);
                    console.log(`\u2713 Renamed "${name}" to "${newName}".`);
                } else {
                    userEntries[newName] = { prompt: loadPromptRegistry().get(name).prompt };
                    saveUserPrompts(userEntries);
                    console.log(`\u2713 Copied built-in "${name}" to "${newName}" (built-ins stay available).`);
                }
                continue;
            }

            if (choice.startsWith("d")) {
                const name = await askExistingPromptName("delete");
                if (!name) continue;
                const userEntries = readUserPrompts();
                if (!Object.prototype.hasOwnProperty.call(userEntries, name)) {
                    console.log(`>> "${name}" is a built-in prompt and cannot be deleted. Override it with the same name instead.`);
                    continue;
                }
                const confirm = (await promptUser(`Delete "${name}"? (y/N): `)).toLowerCase();
                if (confirm !== "y") {
                    console.log(">> Cancelled.");
                    continue;
                }
                delete userEntries[name];
                saveUserPrompts(userEntries);
                console.log(`\u2713 Deleted "${name}".`);
                continue;
            }
        } catch (error) {
            console.log(`>> ${firstLine(error)}`);
        }
    }
    console.log(">> Prompt Manager closed.");
}

const SELECTORS = {
    promptInput: [
        "#mobile-composer-prompt",
        "#prompt-textarea",
        'textarea[aria-label="Chat with ChatGPT"]',
        'textarea[placeholder="Ask ChatGPT"]',
        '[contenteditable="true"][role="textbox"]',
    ],
    sendButton: [
        '[data-testid="send-button"]',
        'button[aria-label="Send message"]',
    ],
    stopButton: [
        '[data-testid="stop-button"]',
        'button[aria-label="Stop streaming"]',
    ],
    assistantMessage: [
        '[data-message-author-role="assistant"]',
        '[class*="_assistantMessage"]:not([class*="Actions"])',
    ],
    userMessage: [
        '[data-message-author-role="user"]',
        '[class*="_userMessageGroup"]',
        '[class*="_userMessage"]:not([class*="Actions"])',
    ],
    attachButton: [
        '[data-testid="composer-plus-btn"]',
        'button[aria-label="Add files and more"]',
    ],
    copyButton: [
        '[data-testid="copy-turn-action-button"]',
        'button[aria-label="Copy response"]',
    ],
    fileInput: ['input[type="file"]'],
    blockingDialog: [
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[data-testid*="modal"]',
        '[class*="modal"]',
        '[class*="popover"]',
    ],
    noAuthModal: ['[data-testid="modal-no-auth-login"]'],
    dismissButton: ['button', '[role="button"]', 'a'],
    fileMenuButton: ['[role="menuitem"]', '[role="menu"] button', '[role="dialog"] button'],
    uploadProgress: [
        '[role="progressbar"]',
        '.animate-spin',
    ],
    messageBoundary: ['[data-message-author-role]'],
};

const selector = (name) => SELECTORS[name].join(", ");
const promptInput = (page) => CHATGPT_DOM.visible(page, "promptInput");
const sendButton = (page) => CHATGPT_DOM.locator(page, "sendButton").first();
const assistantMessages = (page) => CHATGPT_DOM.visibleAll(page, "assistantMessage");
const userMessages = (page) => CHATGPT_DOM.locator(page, "userMessage");

function firstVisibleElement(selector) {
    const visible = (el) =>
        !!el &&
        (typeof el.checkVisibility === "function"
            ? el.checkVisibility()
            : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    return [...document.querySelectorAll(selector)].find((el) => visible(el)) || null;
}

function elementText(el) {
    if (!el) return "";
    return "value" in el ? el.value || "" : el.innerText || el.textContent || "";
}

function isUsableControl(el) {
    return !!el && !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true";
}

const PAGE_DOM_SOURCE = {
    firstVisibleElement: `(${firstVisibleElement.toString()})`,
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

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  askweb [options] [question] [files...]
  node index.js [options] [question] [files...]

Ask ChatGPT a question directly from your terminal. Files passed as arguments
(or referenced with @path) are attached to the prompt; text/code files are
pasted inline, other files are uploaded.

Arguments:
  question                Question text (default: "${DEFAULT_QUESTION}")
  files...                Files to attach; "@path" also references a file
  Use "--" before the question to treat leading dashes as literal text.
  Options can appear anywhere before "--".

Options:
  -o, --output <file>     Save the answer to a file (default: ${DEFAULT_OUTPUT_FILE})
      --append            Append the answer after existing content in the output file
      --prepend           Prepend the answer before existing content in the output file
      --login             Open ChatGPT to log in and save the session
      --logout            Open ChatGPT to log out (manual, 10 min)
      --continue [id]      Continue the most recent conversation, or a specific one by id prefix
      --new               Start a fresh conversation instead of continuing
      --prompts           Open the Prompt Manager (add/edit/rename/delete/view)
      --prompt-create [name]      Interactively create a new preset
      --<preset>          Run a prompt preset, e.g. --explain "closures"
      --browser           Configure default browser interactively
      --browser-order     Configure browser fallback order
      --browser-reset     Reset browser preferences to automatic
      --clear-session     Clear saved local storage on launch
      --clear-conversations Delete all saved conversation history
      --clear-conversation <id> Delete one saved conversation by id (prefix ok)
  -h, --help              Show this help
  -v, --version           Show version

Prompt presets:
  Named, reusable prompts that work like native commands:
    node index.js --astronaut
    node index.js --explain "JavaScript closures"
    node index.js --fix test.py
  Words after the flag fill the template's {{input}} slot; presets without
  one get the words appended as "Extra focus".
  Built-ins: ${Object.keys(BUILTIN_PROMPTS).map((name) => `--${name}`).join(", ")}
  Custom presets live in .askweb-prompts.json next to index.js - manage
  them with --prompts.

Conversations:
  Every run saves its Q&A history locally to .chatgpt-conversations.json.
  By default each run starts a fresh chat; pass --continue to replay the
  saved transcript into a new chat so full context carries over (works
  even when logged out).

Notes:
  Browser profiles and history live in the install directory, so you can
  run askweb from any working directory; only -o resolves relative to
  your current directory.
  Large contexts: payloads over ~25 KB are delivered automatically - as a
  single file attachment when logged in, otherwise as a numbered multipart
  transmission packed into the fewest, largest messages ChatGPT reliably
  accepts; it answers only after the final part arrives.
  Logged-out chats accept up to ~293 KB this way; beyond that, log in and
  payloads upload as one attachment instead. Upload attempts are skipped
  entirely while logged out to save time.
  Set ASKWEB_CHUNK_SIZE=<chars> to force a specific part size instead of
  automatic packing.
  Quoted "@paths with spaces" work: askweb "summarize" "@C:\\my notes\\doc.md"
  If the browser opens but you are not logged in, log in inside the window
  or run once with --login; the session persists for future runs.

Examples:
  askweb "Explain event loops"
  askweb -o result.md "Explain quantum computing"
  askweb --continue "Give me 3 examples"
  askweb --new "Start a fresh discussion about React"
  askweb "Review this code" src/index.js utils.js
  askweb -o summary.md "Summarize" @notes.md
  askweb --prompts
  askweb --prompt-create astronaut
  askweb --astronaut
  askweb --explain "JavaScript closures"
  askweb --find-error src/index.js utils.js
  askweb -o out.md -- "-explain this flag"`);
}

function parseCliArgs(argv = process.argv.slice(2)) {
    const options = {
        login: false,
        logout: false,
        clearSession: false,
        clearConversations: false,
        clearConversationId: null,
        configureBrowser: false,
        configureBrowserOrder: false,
        resetBrowserPrefs: false,
        continueLast: false,
        continueConversationId: null,
        newConversation: false,
        showHelp: false,
        showVersion: false,
        promptPreset: null,
        promptCreate: null,
        promptsAction: null,
        outputFile: DEFAULT_OUTPUT_FILE,
        outputMode: "overwrite",
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

        if (arg === "--logout") {
            options.logout = true;
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
            const next = argv[i + 1];
            if (next && !next.startsWith("-")) {
                options.continueConversationId = stripShellQuotes(next);
                i++;
            }
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

        if (arg === "--prompts") {
            options.promptsAction = "manager";
            continue;
        }

        if (arg === "--prompt-create") {
            const next = argv[i + 1];
            if (next && !next.startsWith("-")) {
                options.promptCreate = stripShellQuotes(next);
                i++;
            } else {
                options.promptCreate = "";
            }
            continue;
        }

        if (arg === "--output" || arg === "-o") {
            const value = argv[i + 1];
            if (!value) throw new Error(`${arg} requires a file path`);
            options.outputFile = stripShellQuotes(value);
            i++;
            continue;
        }

        if (arg === "--append") {
            if (options.outputMode !== "overwrite") {
                throw new Error("Use either --append or --prepend, not both.");
            }
            options.outputMode = "append";
            continue;
        }

        if (arg === "--prepend") {
            if (options.outputMode !== "overwrite") {
                throw new Error("Use either --append or --prepend, not both.");
            }
            options.outputMode = "prepend";
            continue;
        }

        if (arg.startsWith("--output=")) {
            const value = arg.slice("--output=".length);
            if (!value) throw new Error("--output requires a file path");
            options.outputFile = stripShellQuotes(value);
            continue;
        }

        if (arg.startsWith("-")) {
            if (arg.startsWith("--")) {
                const presetName = arg.slice(2).toLowerCase();
                if (loadPromptRegistry().has(presetName)) {
                    if (options.promptPreset) {
                        throw new Error(
                            `Multiple prompt presets cannot be combined: --${options.promptPreset} and --${presetName}`
                        );
                    }
                    options.promptPreset = presetName;
                    continue;
                }
            }
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
    const seenFiles = new Set();
    const addFileRef = (ref) => {
        const resolved = path.resolve(ref);
        if (!seenFiles.has(resolved)) {
            seenFiles.add(resolved);
            fileRefs.push(ref);
        }
    };

    for (const rawArg of args) {
        const arg = stripShellQuotes(rawArg);
        if (!arg) continue;

        if (looksLikeExistingFile(arg)) {
            addFileRef(arg);
            continue;
        }

        // Each arg is a single shell token - never whitespace-split it, or "@path with spaces" breaks apart.
        if (arg.startsWith("@") && arg.length > 1) {
            addFileRef(stripShellQuotes(arg.slice(1)));
        } else {
            textParts.push(arg);
        }
    }

    const extra = textParts.join(" ").trim();
    const presetName = CLI.promptPreset;
    let text;
    if (presetName) {
        const preset = loadPromptRegistry().get(presetName);
        if (preset.arguments) {
            if (!extra) {
                throw new Error(
                    `Preset --${presetName} takes an argument, e.g.: node index.js --${presetName} "your input"`
                );
            }
            text = preset.prompt.split(/\{\{\s*input\s*\}\}/).join(extra);
            console.log(
                `>> Using prompt preset "--${presetName}"${preset.description ? ` (${preset.description})` : ""}. Substituted {{input}} with user text (${extra.length} chars).`
            );
        } else {
            text = extra ? `${preset.prompt}\n\nExtra focus: ${extra}` : preset.prompt;
            console.log(
                `>> Using prompt preset "--${presetName}"${preset.description ? ` (${preset.description})` : ""}.${extra ? ` Appended extra focus text (${extra.length} chars).` : ""}`
            );
        }
    } else {
        text = extra || DEFAULT_QUESTION;
    }

    return { text, files: fileRefs };
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
    if (fileRefs.length > 0) {
        console.log(`>> Loading ${fileRefs.length} file(s) from disk...`);
    }
    const results = fileRefs.map((ref) => {
        const fullPath = path.resolve(ref);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${fullPath}`);
        }

        const isText = PASTE_FILE_EXTENSIONS.has(path.extname(fullPath).toLowerCase());
        const buffer = fs.readFileSync(fullPath);
        let content = isText ? buffer.toString("utf8") : buffer.toString("base64");
        const truncated = content.length > MAX_FILE_CHARS;
        if (truncated) {
            content = content.slice(0, MAX_FILE_CHARS);
        }
        const sizeKB = (buffer.length / 1024).toFixed(1);
        console.log(
            `>> Loaded "${path.basename(fullPath)}" (${isText ? "text" : "binary"}, ${sizeKB} KB` +
                (truncated ? `, truncated to ${MAX_FILE_CHARS} chars` : "") +
                `).`
        );

        return { name: path.basename(fullPath), fullPath, isText, content, truncated };
    });
    if (fileRefs.length > 1) {
        const totalKB = (results.reduce((sum, file) => sum + file.content.length, 0) / 1024).toFixed(1);
        console.log(`>> Total: ${results.length} file(s), ${totalKB} KB.`);
    }
    return results;
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

const ACTIVE_TEMP_FILES = [];

function stageTempPayload(payload) {
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askweb-payload-"));
        const file = path.join(dir, "payload.md");
        fs.writeFileSync(file, payload, "utf8");
        ACTIVE_TEMP_FILES.push(dir);
        console.log(`>> Temp payload staged: ${file} (${(payload.length / 1024).toFixed(1)} KB).`);
        return { name: "payload.md", fullPath: file, isText: true, content: payload, truncated: false };
    } catch (error) {
        console.log(`>> Failed to stage temp payload: ${error.message}`);
        return null;
    }
}

function cleanupTempPayloads() {
    const count = ACTIVE_TEMP_FILES.length;
    for (const dir of ACTIVE_TEMP_FILES.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (count > 0) {
        console.log(`>> Cleaned up ${count} temp payload dir(s).`);
    }
}

const UPLOAD_OVERLAY_TEXT = /add\s+anything/i;
const chipError = (name) => new Error(`attachment chip for "${name}" never appeared`);

async function modalVisible(page) {
    const modal = CHATGPT_DOM.locator(page, "noAuthModal").first();
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
                modalSelector: selector("noAuthModal"),
                blockerSelector: selector("blockingDialog"),
                overlaySource: UPLOAD_OVERLAY_TEXT.source,
            }
        )
        .catch(() => false);
}

async function clickDismissiveButton(page) {
    for (const pattern of POPUP_DISMISS_PATTERNS) {
        const candidates = page
            .locator(selector("dismissButton"))
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
    if (!(await blockingDialogVisible(page))) {
        console.log(">> No blocking UI detected.");
        return false;
    }

    const sawNoAuthModal = await modalVisible(page);
    const sawUploadOverlay = await uploadOverlayVisible(page);
    if (sawNoAuthModal) console.log(">> No-auth popup detected.");
    if (sawUploadOverlay) console.log(">> Upload overlay detected.");
    let dismissed = false;

    for (let attempt = 0; attempt < 5; attempt++) {
        if (!(await blockingDialogVisible(page))) {
            console.log(">> Blocking UI cleared after dismiss attempts.");
            break;
        }

        const clicked = await clickDismissiveButton(page);
        if (!clicked) {
            console.log(">> No matching dismissive button found, stopping button attempts.");
            break;
        }
        dismissed = true;

        await page
            .locator(selector("noAuthModal"))
            .first()
            .waitFor({ state: "hidden", timeout: 8000 })
            .catch(() => {});
        await page.waitForTimeout(500);
    }

    if (await blockingDialogVisible(page)) {
        console.log(">> Blocking UI still present, pressing Escape as fallback...");
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

async function waitForSendAccepted(page, countBefore, timeoutMs) {
    return page
        .waitForFunction(
            ({ userSelector, stopSelector, promptSelector, finderSource, textSource, usableSource, before }) => {
                if (document.querySelectorAll(userSelector).length > before) return true;
                const stopButton = document.querySelector(stopSelector);
                if (eval(usableSource)(stopButton)) return true;
                const input = eval(finderSource)(promptSelector);
                const text = eval(textSource)(input);
                return text.trim().length === 0;
            },
            {
                userSelector: selector("userMessage"),
                stopSelector: selector("stopButton"),
                promptSelector: selector("promptInput"),
                ...CHATGPT_DOM.pageHelpers(),
                before: countBefore,
            },
            { timeout: timeoutMs }
        )
        .then(() => true)
        .catch(() => false);
}

async function pressSendAndConfirm(page, timeoutMs = 8000) {
    const button = sendButton(page);
    const countBefore = await userMessages(page).count();
    console.log(">> Clicking send button...");
    await trySend(page, button, { requireVisible: true });

    const sentDetected = await waitForSendAccepted(page, countBefore, timeoutMs);

    if (!sentDetected) {
        console.log(">> Send may have failed, retrying...");
        await dismissAndSettle(page);
        const retryInput = promptInput(page);
        if ((await retryInput.count()) > 0) {
            await focusComposer(retryInput);
        }
        await trySend(page, button);
        const retryResult = await waitForSendAccepted(page, countBefore, timeoutMs);
        if (retryResult) console.log(">> Send confirmed on retry.");
        return retryResult;
    }
    console.log(">> Send confirmed.");
    return sentDetected;
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
            console.log(`>> Navigating to ${targetUrl} (attempt ${attempt}/3)...`);
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
            console.log(`>> Navigation complete (${page.url()}).`);
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
        .evaluate(({ selector, finderSource, usableSource }) => {
            const el = eval(finderSource)(selector);
            return eval(usableSource)(el) && el.offsetParent !== null;
        }, CHATGPT_DOM.promptPayload())
        .catch(() => false);
    if (!enabled) return false;

    return !(await modalVisible(page));
}

async function waitForChatGPTReady(page, targetUrl = URL) {
    console.log(">> Opening ChatGPT...");
    await gotoChatGPT(page, targetUrl);
    await page.waitForTimeout(2000);

    const deadline = Date.now() + 5 * 60 * 1000;
    let lastNotice = 0;
    while (Date.now() < deadline) {
        if (await isPromptReady(page)) break;
        await dismissBlockingUI(page);
        if (await isPromptReady(page)) break;

        if (Date.now() - lastNotice > 15000) {
            lastNotice = Date.now();
            const elapsed = Math.round((Date.now() - (deadline - 5 * 60 * 1000)) / 1000);
            if (isOnAuthPage(page)) {
                console.log(`>> Waiting for login... (${elapsed}s) Not logged in in this browser profile. Log in inside the window, or run \`askweb --login\`.`);
            } else {
                const pageText = await page.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => "");
                const summary = pageText.replace(/\s+/g, " ").trim() || "(empty page)";
                console.log(`>> Waiting for ChatGPT prompt... (${elapsed}s) url=${page.url()} text="${summary}"`);
            }
        }
        await page.waitForTimeout(1000);
    }

    if (!(await isPromptReady(page))) {
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "");
        throw new Error(`Prompt input never became usable at ${page.url()}. Page text: ${pageText.replace(/\s+/g, " ").trim() || "(empty)"}. Run \`node index.js --login\` to log in manually.`);
    }

    console.log(">> Prompt input detected, focusing...");
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
        ({ selector, finderSource, usableSource }) => {
            const el = eval(finderSource)(selector);
            return eval(usableSource)(el) && el.offsetParent !== null;
        },
        CHATGPT_DOM.promptPayload(),
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

async function attachmentChipProbe(page, fileName) {
    return page
        .evaluate(
            ({ composerSelector, progressSelector, finderSource, name }) => {
                const composer = eval(finderSource)(composerSelector);
                const region =
                    (composer && composer.closest("form")) ||
                    (composer && composer.parentElement && composer.parentElement.parentElement) ||
                    document.body;
                const stem = name.replace(/\.[^.]+$/, "");
                let present = false;
                for (const el of region.querySelectorAll("*")) {
                    if (el.closest(composerSelector)) continue;
                    const text = (el.textContent || "").trim();
                    if (text.length > 300) continue;
                    const lower = text.toLowerCase();
                    if (lower.includes(name.toLowerCase()) || (stem.length > 3 && lower.includes(stem.toLowerCase()))) {
                        present = true;
                        break;
                    }
                }
                const uploading = !!region.querySelector(progressSelector);
                return { present, uploading };
            },
            {
                composerSelector: selector("promptInput"),
                progressSelector: selector("uploadProgress"),
                finderSource: CHATGPT_DOM.pageHelpers().firstVisibleElement,
                name: fileName,
            }
        )
        .catch(() => ({ present: false, uploading: true }));
}

async function waitForAttachmentChip(page, firstName) {
    const deadline = Date.now() + 25000;
    let cleanWithUpload = 0;
    let presentStreak = 0;
    while (Date.now() < deadline) {
        const state = await attachmentChipProbe(page, firstName);
        if (state.present) {
            presentStreak += 1;
            if (!state.uploading) {
                cleanWithUpload += 1;
                if (cleanWithUpload >= 2) return true;
            } else if (presentStreak >= 8) {
                return true;
            }
        } else {
            presentStreak = 0;
            cleanWithUpload = 0;
        }
        await page.waitForTimeout(700);
    }
    return false;
}

async function attachViaDrop(page, files) {
    console.log(`>> Attempting drag-and-drop attach for ${files.length} file(s)...`);
    await promptInput(page).click();
    for (const file of files) {
        const b64 = fs.readFileSync(file.fullPath).toString("base64");
        await page.evaluate(
            ({ b64, name, promptSelector, finderSource }) => {
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const ext = name.split(".").pop() || "";
                const mimeMap = { js: "text/javascript", txt: "text/plain", md: "text/markdown", json: "application/json", py: "text/x-python", csv: "text/csv" };
                const file = new File([bytes], name, { type: mimeMap[ext] || "text/plain" });
                const dt = new DataTransfer();
                dt.items.add(file);
                const target = eval(finderSource)(promptSelector);
                if (target) {
                    for (const type of ["dragenter", "dragover", "drop"]) {
                        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
                    }
                }
            },
            {
                b64,
                name: file.name,
                promptSelector: selector("promptInput"),
                finderSource: CHATGPT_DOM.pageHelpers().firstVisibleElement,
            }
        );
        const attached = await waitForAttachmentChip(page, file.name);
        if (!attached) throw new Error(`drop did not create attachment chip for "${file.name}"`);
        console.log(`>> Drag-and-drop attach succeeded for "${file.name}".`);
    }
}

async function attachViaChooser(page, files) {
    console.log(">> Attempting file chooser attach...");
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 6000 });
    await CHATGPT_DOM.locator(page, "attachButton").first().click();

    let chooser;
    try {
        chooser = await chooserPromise;
    } catch {
        console.log(">> No file chooser appeared, looking for menu item...");
        const menuItem = page
            .locator(selector("fileMenuButton"))
            .filter({ hasText: /file|upload|computer|photos/i })
            .first();

        const chooserPromise = page.waitForEvent("filechooser", { timeout: 6000 });
        await menuItem.click({ timeout: 4000 });
        chooser = await chooserPromise;
    }

    console.log(`>> Setting ${files.length} file(s) via chooser...`);
    await chooser.setFiles(files.map((file) => file.fullPath));

    if (!(await waitForAttachmentChip(page, files[0].name))) {
        throw chipError(files[0].name);
    }
    console.log(`>> Chooser attach succeeded for "${files[0].name}".`);
}

async function attachViaFileInput(page, files) {
    const inputs = CHATGPT_DOM.locator(page, "fileInput");
    const count = await inputs.count();
    if (count === 0) throw new Error("no input[type=file] in DOM");
    console.log(`>> Found ${count} file input(s), attempting file-input attach...`);

    let lastError;
    for (let i = count - 1; i >= 0; i--) {
        try {
            await inputs.nth(i).setInputFiles(files.map((f) => f.fullPath), { timeout: 5000 });
            if (!(await waitForAttachmentChip(page, files[0].name))) {
                throw chipError(files[0].name);
            }
            console.log(`>> File-input attach succeeded for "${files[0].name}".`);
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

const COMPOSER_CHUNK = 16000;
let composerKindLogged = false;

async function prepareComposerProbe(page) {
    return page
        .evaluate(({ selector, finderSource }) => {
            const el = eval(finderSource)(selector);
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
        }, CHATGPT_DOM.promptPayload())
        .catch(() => ({ ok: false, kind: null }));
}

async function injectTextareaValue(page, text) {
    return page
        .evaluate(
            ({ selector, finderSource, text }) => {
                const el = eval(finderSource)(selector);
                if (!el || (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT")) return false;
                const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                return true;
            },
            { ...CHATGPT_DOM.promptPayload(), text }
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
        .evaluate(({ selector, finderSource, textSource }) => {
            const el = eval(finderSource)(selector);
            if (!el) return 0;
            return eval(textSource)(el).length;
        }, CHATGPT_DOM.promptPayload())
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
        injected = await input.fill(text).then(() => true).catch(() => injectTextareaValue(page, text));
        if (injected) console.log(`>> Pasted ${(text.length / 1024).toFixed(1)} KB via textarea fill.`);
    } else if (probe.ok) {
        injected = await pasteViaClipboardKeys(page, input, text);
        if (injected) {
            console.log(`>> Pasted ${(text.length / 1024).toFixed(1)} KB via clipboard (Ctrl+V).`);
        }
    }

    if (!injected && probe.ok) {
        // Fallback: a single execCommand with large text blocks the page, so feed it slices.
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

async function typePrompt(page, input, text) {
    await dismissBlockingUI(page);

    await focusComposer(input);
    await input.fill("");

    if (text) {
        await pasteIntoComposer(page, input, text);
    }

    await page.waitForTimeout(400);
}

function splitPayloadChunks(text, size) {
    const chunks = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(offset + size, text.length);
        const lastCode = text.charCodeAt(end - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff && end < text.length) end += 1;
        chunks.push(text.slice(offset, end));
        offset = end;
    }
    return chunks;
}

function buildTransmissionPlan(payload, chunkSize) {
    const chunks = splitPayloadChunks(payload, chunkSize);
    const total = chunks.length;
    const header = [
        `[TRANSMISSION HEADER] I am sending a document in ${total} numbered part(s).`,
        "Each part is delimited by [PAYLOAD PART i/N] ... [/PAYLOAD PART i/N].",
        'After each part, reply with ONLY "OK". Do not analyze or answer anything yet.',
        "When I send TRANSMISSION COMPLETE, then answer my question.",
    ].join("\n");

    const parts = chunks.map((chunk, i) => {
        const open = `[PAYLOAD PART ${i + 1}/${total} chars=${chunk.length}]`;
        const close = `[/PAYLOAD PART ${i + 1}/${total}]`;
        const body = `${open}\n${chunk}\n${close}`;
        return i === 0 ? `${header}\n\n${body}` : body;
    });
    return { parts, totalParts: total, totalChars: payload.length };
}

function planTransmissionParts(payloadLength) {
    const usablePerPart = ANON_PART_SIZE_CEILING - PART_TAG_OVERHEAD;
    return Math.max(1, Math.ceil(payloadLength / usablePerPart));
}

function buildMinimalTransmissionPlan(payload) {
    const totalParts = planTransmissionParts(payload.length);
    return buildTransmissionPlan(payload, Math.ceil(payload.length / totalParts));
}

function resolveChunkSizeOverride() {
    const manual = Number(process.env.ASKWEB_CHUNK_SIZE);
    return Number.isFinite(manual) && manual > 0 ? Math.floor(manual) : null;
}

function buildDeliveryPlan(payload) {
    const manualChunkSize = resolveChunkSizeOverride();
    if (manualChunkSize) {
        console.log(`>> Using manual chunk size override: ${manualChunkSize} chars (${(manualChunkSize / 1024).toFixed(1)} KB).`);
    }
    return {
        plan: manualChunkSize ? buildTransmissionPlan(payload, manualChunkSize) : buildMinimalTransmissionPlan(payload),
        manualChunkSize,
    };
}

function buildTransmissionFinale(total, finalQuestion) {
    const confirm = `TRANSMISSION COMPLETE - all ${total} part(s) sent (1..${total}). Now answer my question below.`;
    return finalQuestion ? `${confirm}\n\nMy question: ${finalQuestion}` : confirm;
}

async function waitForGenerationEnd(page, timeoutMs = 10 * 60 * 1000) {
    const stopButton = CHATGPT_DOM.locator(page, "stopButton").first();
    const deadline = Date.now() + timeoutMs;
    let noticed = false;
    while (Date.now() < deadline) {
        if (!(await stopButton.isVisible().catch(() => false))) return true;
        if (!noticed) {
            console.log(">> Waiting for in-flight generation to settle...");
            noticed = true;
        }
        await page.waitForTimeout(750);
    }
    return false;
}

async function composerHasContent(page, needle, minLength) {
    return promptInput(page)
        .evaluate(
            (el, { needle, minLength }) => {
                const text = "value" in el ? el.value : el.innerText || el.textContent || "";
                return text.includes(needle) && text.length >= minLength;
            },
            { needle, minLength }
        )
        .catch(() => false);
}

async function sendButtonUsable(page) {
    return page
        .evaluate((selector) => {
            const btn = document.querySelector(selector);
            return !!btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true";
        }, selector("sendButton"))
        .catch(() => false);
}

async function transcriptContainsCloseTag(page, closeTag) {
    return page
        .evaluate(
            ({ selector, needle }) => {
                const msgs = document.querySelectorAll(selector);
                for (const msg of msgs) {
                    if ((msg.innerText || "").includes(needle)) return true;
                }
                return false;
            },
            { selector: selector("userMessage"), needle: closeTag }
        )
        .catch(() => false);
}

async function waitForPartLanding(page, closeTag, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastSnippet = "";
    while (Date.now() < deadline) {
        if (await transcriptContainsCloseTag(page, closeTag)) return { ok: true, snippet: "" };
        lastSnippet = await page
            .evaluate(
                (selector) => {
                    const msgs = document.querySelectorAll(selector);
                    const last = msgs[msgs.length - 1];
                    return (((last && (last.innerText || "")) || "") + "").trim().slice(0, 120);
                },
                selector("userMessage")
            )
            .catch(() => "");
        await page.waitForTimeout(600);
    }
    return { ok: false, snippet: lastSnippet };
}

async function looksLikeUsageLimit(page) {
    return page
        .evaluate(() => {
            const clone = document.body.cloneNode(true);
            clone.querySelectorAll("[data-message-author-role]").forEach((node) => node.remove());
            const text = clone.textContent || "";
            return (
                /\busage\s+(limit|cap)\b/i.test(text) ||
                /\b(hit|hitting|reached|reach)\b[^\n]{0,40}\b(limit|cap)\b/i.test(text) ||
                /\banonymous\b[^\n]{0,80}\blimit\b/i.test(text)
            );
        })
        .catch(() => false);
}

async function collectFailureDiagnostics(page) {
    try {
        const ready = await isPromptReady(page);
        const text = await page
            .evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 300))
            .catch(() => "");
        return `(promptReady=${ready}, page: ${text || "(empty)"})`;
    } catch {
        return "";
    }
}

async function transcriptContainsText(page, needle) {
    return page
        .evaluate(
            ({ selector, needle }) => {
                const msgs = document.querySelectorAll(selector);
                for (const msg of msgs) {
                    if ((msg.innerText || "").includes(needle)) return true;
                }
                return false;
            },
            { selector: selector("userMessage"), needle }
        )
        .catch(() => false);
}

async function transmitPart(page, input, part, index, total) {
    const openTag = `[PAYLOAD PART ${index}/${total} chars=${part.length}]`;
    const closeTag = `[/PAYLOAD PART ${index}/${total}]`;

    for (let attempt = 1; attempt <= 2; attempt++) {
        // A prior attempt may have landed without being confirmed (virtualized transcript
        // hid it from the old count-based check) - never resend a part already in the chat.
        if (attempt > 1 && (await transcriptContainsCloseTag(page, closeTag))) {
            console.log(`>> Part ${index}/${total} is already in the transcript, treating as landed.`);
            return true;
        }

        process.stdout.write(`>> Sending part ${index}/${total} (${(part.length / 1024).toFixed(1)} KB)...`);
        await typePrompt(page, input, part);

        if (!(await composerHasContent(page, closeTag, Math.floor(part.length * 0.9)))) {
            console.log(" composer incomplete, repasting...");
            await typePrompt(page, input, part);
            if (!(await composerHasContent(page, closeTag, Math.floor(part.length * 0.9)))) {
                console.log(` still incomplete (attempt ${attempt}/2).`);
                continue;
            }
        }

        if (!(await sendButtonUsable(page))) {
            console.log(" send button not enabled yet, waiting...");
            await waitForGenerationEnd(page);
            const sendReadyDeadline = Date.now() + 5000;
            while (!(await sendButtonUsable(page))) {
                if (Date.now() > sendReadyDeadline) break;
                await page.waitForTimeout(300);
            }
        }

        await trySend(page, sendButton(page), { requireVisible: true });

        const landing = await waitForPartLanding(page, closeTag);
        if (landing.ok) {
            console.log(" landed.");
            await waitForGenerationEnd(page);
            return true;
        }

        console.log(` not confirmed (attempt ${attempt}/2)${landing.snippet ? `, last message starts: "${landing.snippet}"` : ""}.`);

        if (await looksLikeUsageLimit(page)) {
            const diag = await collectFailureDiagnostics(page);
            throw new Error(
                `Chunked transmission aborted: part ${index}/${total} was refused - this anonymous session hit ChatGPT's usage/context limit. Log in (askweb --login) to lift it.${diag}`
            );
        }

        if (attempt < 2) {
            await page.waitForTimeout(8000);
            await dismissAndSettle(page, 500);
        }
    }

    const diag = await collectFailureDiagnostics(page);
    const ceilingHint =
        index >= 2
            ? " If early parts landed but a later one persistently fails, the session likely hit the anonymous usage/context limit - log in (askweb --login) to lift it."
            : "";
    throw new Error(`Chunked transmission aborted: part ${index}/${total} could not be delivered after retries. ${ceilingHint}${diag}`);
}

async function composerEmpty(page) {
    return promptInput(page)
        .evaluate((el) => {
            const text = "value" in el ? el.value : el.innerText || el.textContent || "";
            return text.trim().length < 5;
        })
        .catch(() => false);
}

async function sendFinaleConfirmed(page, input, text, attempts = 3) {
    const marker = `TRANSMISSION COMPLETE - all`;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        // Sending while a reply is still generating is a guaranteed no-op (button is a stop button),
        // which used to burn the whole confirmation timeout on attempt 1 every single time.
        console.log(`>> Sending TRANSMISSION COMPLETE (attempt ${attempt}/${attempts})...`);
        await waitForGenerationEnd(page);
        await typePrompt(page, input, text);

        if (!(await composerHasContent(page, marker, marker.length))) {
            console.log(`>> Composer missing TRANSMISSION COMPLETE text, repasting...`);
            await typePrompt(page, input, text);
            if (!(await composerHasContent(page, marker, marker.length))) {
                console.log(`>> Still missing after repaste (attempt ${attempt}/${attempts}).`);
                if (attempt < attempts) await page.waitForTimeout(3000);
                continue;
            }
        }

        const sendReadyDeadline = Date.now() + 5000;
        while (!(await sendButtonUsable(page))) {
            if (Date.now() > sendReadyDeadline) break;
            await page.waitForTimeout(300);
        }

        await trySend(page, sendButton(page), { requireVisible: true });

        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (await transcriptContainsText(page, text)) return true;
            if (await transcriptContainsText(page, marker)) return true;
            await page.waitForTimeout(600);
        }

        console.log(`>> TRANSMISSION COMPLETE not confirmed (attempt ${attempt}/${attempts}).`);
        if (attempt < attempts) await waitForGenerationEnd(page);
    }
    return false;
}

async function sendChunkedPayload(page, input, plan, finalQuestion) {
    console.log(`>> Starting chunked transmission of ${plan.totalParts} part(s)...`);
    for (let i = 0; i < plan.totalParts; i++) {
        await transmitPart(page, input, plan.parts[i], i + 1, plan.totalParts);
    }

    console.log(">> All parts delivered, sending TRANSMISSION COMPLETE + question...");
    const baseline = await assistantMessages(page).count();
    const sent = await sendFinaleConfirmed(page, input, buildTransmissionFinale(plan.totalParts, finalQuestion));
    if (!sent) {
        throw new Error(
            "TRANSMISSION COMPLETE could not be delivered after retries - the session likely stopped accepting messages. Check the browser window."
        );
    }
    console.log(">> TRANSMISSION COMPLETE confirmed.");
    return baseline;
}

async function promptHasExpectedText(page, expectedParts) {
    if (expectedParts.length === 0) return true;
    const typed = await promptInput(page)
        .evaluate((el) => ("value" in el ? el.value : el.innerText || el.textContent || ""))
        .catch(() => "");
    return expectedParts.every((part) => typed.includes(part));
}

async function looksLoggedOut(page) {
    return page
        .evaluate(() => {
            const text = document.body ? document.body.innerText : "";
            const hasSignUp = /\bsign\s*up\b/i.test(text);
            const hasLogIn = /\blog\s*in\b/i.test(text);
            return hasSignUp && hasLogIn;
        })
        .catch(() => false);
}

async function sendQuestion(page, question, targetUrl = URL) {
    const input = await waitForChatGPTReady(page, targetUrl);
    markPhase("ready");
    const assistantCountBefore = await assistantMessages(page).count();

    let attached = false;
    const loggedOut = await looksLoggedOut(page);
    if (loggedOut) {
        console.log(">> Detected: not logged in. Upload features will be limited.");
    }
    if (question.files.length > 0) {
        console.log(`>> Loaded ${question.files.length} file(s): ${question.files.map((file) => file.name).join(", ")}`);
        if (shouldPasteFiles(question.files)) {
            console.log(">> Text/code file detected, using paste mode.");
        } else if (loggedOut) {
            console.log(">> Not logged in - file upload is unavailable, falling back to paste mode.");
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

    const payload = attached ? question.text : buildFullPrompt(question);
    let deliveryPlan = null;
    let stagedAttachmentName = null;

    if (!attached && payload.length > SINGLE_PASTE_MAX) {
        console.log(
            `>> Payload is ${(payload.length / 1024).toFixed(1)} KB, above the ${Math.round(SINGLE_PASTE_MAX / 1024)} KB single-message budget.`
        );
        let staged = null;
        if (loggedOut) {
            console.log(">> Not logged in - skipping upload attempts, going straight to chunked transmission.");
        } else {
            staged = stageTempPayload(payload);
        }
        if (staged) {
            try {
                await attachFiles(page, [staged]);
                attached = true;
                stagedAttachmentName = staged.name;
                question.deliveryMeta = { mode: "attachment", chars: payload.length };
                console.log(`>> Payload uploaded as a single attachment (${staged.name}).`);
                await page.waitForTimeout(3000);
            } catch (error) {
                console.log(`>> Single-file attachment failed (${firstLine(error)}), switching to chunked transmission.`);
                await resetComposer(page, targetUrl);
            }
        }
        if (!attached) {
            const { plan, manualChunkSize } = buildDeliveryPlan(payload);
            deliveryPlan = plan;
            if (loggedOut && deliveryPlan.totalParts > ANON_MAX_PARTS) {
                throw new Error(
                    `Payload is ${(payload.length / 1024).toFixed(1)} KB - an anonymous chat can only receive about ${Math.round(
                        (ANON_MAX_PARTS * ANON_PART_SIZE_CEILING) / 1024
                    )} KB in ${ANON_MAX_PARTS} part(s). Run \`node index.js --login\` once - the session persists - or trim the input.`
                );
            }
            question.deliveryMeta = { mode: "chunked", parts: deliveryPlan.totalParts, chars: deliveryPlan.totalChars };
            console.log(
                `>> Chunked transmission planned: ${deliveryPlan.totalParts} part(s), ${(deliveryPlan.totalChars / 1024).toFixed(1)} KB total` +
                    (manualChunkSize ? ` (ASKWEB_CHUNK_SIZE=${manualChunkSize}).` : ", packed to the fewest messages possible.")
            );
        }
    }

    if (deliveryPlan) {
        const finalInput = promptInput(page);
        const baseline = await sendChunkedPayload(page, finalInput, deliveryPlan, question.originalText ?? question.text);
        markPhase("write");
        markPhase("send");
        return baseline;
    }

    const finalInput = promptInput(page);
    const composerText = stagedAttachmentName
        ? `${question.text}\n\n(The complete document context was attached as "${stagedAttachmentName}".)`.trim()
        : payload;
    const expectedParts = [];
    if (question.text) expectedParts.push(question.text.trim().slice(0, 60));
    if (!attached && question.files.length > 0) expectedParts.push("</file>");

    console.log(">> Writing prompt...");
    let verified = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await typePrompt(page, finalInput, composerText);
        if (await promptHasExpectedText(page, expectedParts)) {
            verified = true;
            break;
        }

        console.log(`>> Prompt text did not stick (attempt ${attempt}/3), retyping...`);
        await dismissAndSettle(page, 500);
    }
    if (!verified) await focusComposer(finalInput);
    markPhase("write");

    if (stagedAttachmentName) {
        const chip = await attachmentChipProbe(page, stagedAttachmentName);
        if (!chip.present) {
            console.log(">> Attachment chip missing before send - falling back to chunked transmission.");
            const { plan } = buildDeliveryPlan(buildFullPrompt(question));
            deliveryPlan = plan;
            question.deliveryMeta = { mode: "chunked-fallback", parts: deliveryPlan.totalParts, chars: deliveryPlan.totalChars };
            const baseline = await sendChunkedPayload(page, finalInput, deliveryPlan, question.originalText ?? question.text);
            markPhase("write");
            markPhase("send");
            return baseline;
        }
        if (chip.uploading) {
            console.log(">> Attachment still uploading, waiting for it to finish...");
            await waitForAttachmentChip(page, stagedAttachmentName);
        }
    }

    console.log(">> Sending prompt...");
    await pressSendAndConfirm(page);
    markPhase("send");

    if (stagedAttachmentName) {
        const sentWithFile = await page
            .evaluate(
                ({ selector, name }) => {
                    const msgs = document.querySelectorAll(selector);
                    const last = msgs[msgs.length - 1];
                    return !!last && (last.innerText || "").toLowerCase().includes(name.toLowerCase());
                },
                { selector: selector("userMessage"), name: stagedAttachmentName }
            )
            .catch(() => true);
        if (!sentWithFile) {
            console.log(">> Warning: sent message does not appear to carry the attachment.");
        }
    }

    return assistantCountBefore;
}

async function findCopyButton(page, answer) {
    const parent = answer.locator("xpath=..");
    const tiers = [
        selector("copyButton"),
        'button[aria-label*="copy" i]:not([aria-label*="code" i]):not([aria-label*="image" i])',
    ];
    for (const selector of tiers) {
        for (const scope of [answer, parent, page]) {
            const button = scope.locator(selector).last();
            if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
                console.log(`>> Copy button found (scope: ${scope === answer ? "answer" : scope === parent ? "parent" : "page"}).`);
                return button;
            }
        }
    }
    console.log(">> No visible copy button found in any tier.");
    return null;
}

async function extractAnswerMarkdown(page, answer) {
    console.log(">> Clearing clipboard for answer extraction...");
    await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});

    const copyButton = await findCopyButton(page, answer);
    if (!copyButton) {
        console.log(">> Copy button not found in answer block.");
        return null;
    }
    console.log(">> Copy button found, clicking...");

    await answer.hover({ timeout: 2000 }).catch(() => {});
    try {
        await copyButton.click({ timeout: 5000 });
    } catch {
        console.log(">> Copy button click failed, retrying with force...");
        try {
            await copyButton.click({ timeout: 3000, force: true });
        } catch {
            console.log(">> Copy button force-click failed, retrying with DOM click...");
            try {
                await copyButton.evaluate((button) => button.click());
            } catch {
                console.log(">> Copy button DOM click also failed.");
                return null;
            }
        }
    }

    await page.waitForTimeout(400);
    const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    if (typeof text === "string" && text.trim()) {
        console.log(`>> Clipboard read successful (${text.length} chars).`);
    } else {
        console.log(">> Clipboard read returned empty content.");
    }
    return typeof text === "string" && text.trim() ? text : null;
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
        const stopVisible = await CHATGPT_DOM.locator(page, "stopButton").first().isVisible().catch(() => false);
        if (stopVisible && !sawGeneration) {
            sawGeneration = true;
            console.log(">> Generation started (stop button visible).");
        }

        const count = await replies.count();
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
    let stableCount = 0;
    let prevLength = -1;
    const answer = replies.last();
    await answer.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});

    let totalPolls = 0;
    while (stableCount < STABLE_POLLS_REQUIRED) {
        await page.waitForTimeout(POLL_MS);
        totalPolls += 1;

        const stopButton = CHATGPT_DOM.locator(page, "stopButton").first();
        const stopVisible = await stopButton.isVisible().catch(() => false);

        const text = await answer.innerText().catch(() => "");
        const lastLength = text.trim().length;

        const unchanged = lastLength === prevLength && lastLength > 0 && !stopVisible;
        stableCount = unchanged ? stableCount + 1 : 0;
        prevLength = lastLength;

        if (!unchanged && totalPolls > 0 && totalPolls % 5 === 0) {
            console.log(`>> Still generating... (poll ${totalPolls}, current length: ${lastLength} chars, stop visible: ${stopVisible}).`);
        }
    }

    console.log(`>> Generation stable (${totalPolls} polls, final length: ${prevLength} chars).`);
    markPhase("generate");
    let markdown = await extractAnswerMarkdown(page, answer);
    if (markdown) {
        console.log(`>> Raw Markdown captured via copy button (${markdown.length} chars).`);
    } else {
        console.log(">> Copy button unavailable, falling back to rendered text.");
        markdown = await answer.innerText();
        await page.evaluate((text) => navigator.clipboard.writeText(text), markdown).catch(() => {});
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
            const hasPrompt = (await promptInput(page).count()) > 0;
            if (/welcome back|sign.in|log.in/i.test(bodyText) && !hasPrompt) {
                continue;
            }
        }
    }

    throw new Error("Login timed out after 10 minutes. Please try again.");
}

async function runLogoutFlow(page) {
    console.log(">> Opening ChatGPT. You have up to 10 min to log out or do anything else...");
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(10 * 60 * 1000);
    console.log(">> Time's up. Closing browser.");
}

function markProfileClean(profileDir) {
    try {
        const prefsPath = path.join(profileDir, "Default", "Preferences");
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
        prefs.profile = prefs.profile || {};
        prefs.profile.exit_type = "Normal";
        prefs.profile.exited_cleanly = true;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs));
        console.log(`>> Browser profile marked clean: ${profileDir}`);
    } catch {
        console.log(`>> Could not mark profile clean (may not exist yet): ${profileDir}`);
    }
}

function clearSessionData(profileDir) {
    try {
        const localStoragePath = path.join(profileDir, "Default", "Local Storage", "leveldb");
        if (fs.existsSync(localStoragePath)) {
            const files = fs.readdirSync(localStoragePath).filter((f) => f.endsWith(".log") || f.endsWith(".ldb"));
            let deleted = 0;
            for (const file of files) {
                try {
                    fs.unlinkSync(path.join(localStoragePath, file));
                    deleted += 1;
                } catch {}
            }
            console.log(`>> Cleared ${deleted} session file(s) from ${localStoragePath}.`);
        } else {
            console.log(`>> No local storage found at ${localStoragePath}, nothing to clear.`);
        }
    } catch (error) {
        console.log(`>> Could not clear session data: ${error.message}`);
    }
}

function wantsClearSession() {
    return CLI.clearSession;
}

function loadConversations() {
    try {
        const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, "utf8"));
        const count = Array.isArray(data.conversations) ? data.conversations.length : 0;
        console.log(`>> Loaded ${count} saved conversation(s) from ${CONVERSATIONS_FILE}.`);
        return Array.isArray(data.conversations) ? data : { conversations: [] };
    } catch {
        console.log(">> No saved conversation history found, starting fresh.");
        return { conversations: [] };
    }
}

function saveConversations(data) {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2), "utf8");
    console.log(`>> Saved ${data.conversations.length} conversation(s) to ${CONVERSATIONS_FILE}.`);
}

function clearAllConversations() {
    try {
        fs.unlinkSync(CONVERSATIONS_FILE);
        console.log(`>> Cleared all saved conversation history (${CONVERSATIONS_FILE}).`);
    } catch {
        console.log(`>> No conversation history file to clear (${CONVERSATIONS_FILE}).`);
    }
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
    console.log(`>> Removed ${matches.length} saved conversation(s) (${data.conversations.length} remaining):`);
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

function findConversationById(idPrefix) {
    const needle = idPrefix.toLowerCase();
    const conversations = loadConversations().conversations;
    const matches = conversations.filter(
        (conversation) =>
            Array.isArray(conversation.messages) &&
            conversation.messages.length > 0 &&
            String(conversation.id || "").toLowerCase().startsWith(needle)
    );

    if (matches.length === 0) {
        return null;
    }

    if (matches.length > 1) {
        console.log(`>> Multiple conversations match id prefix "${idPrefix}":`);
        for (const conversation of matches) {
            console.log(`   ${conversation.id}  "${conversation.title || "(untitled)"}" (${conversation.messages.length} messages)`);
        }
        console.log(`>> Using the first match. Use a longer prefix to be specific.`);
    }

    return matches[0];
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
        console.log(">> Recording conversation to local history...");
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
            ...(run.meta ? { delivery: run.meta } : {}),
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
        console.log(`>> Conversation recorded (id: ${entry.id}, title: "${entry.title}", ${entry.messages.length} messages).`);
        return entry;
    } catch (error) {
        console.warn(`>> Failed to save conversation history locally: ${firstLine(error)}`);
        return null;
    }
}

function loadBrowserPrefs() {
    try {
        const prefs = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
        console.log(`>> Loaded browser preferences (default: ${prefs.defaultBrowser || "auto"}).`);
        return prefs;
    } catch {
        console.log(">> No browser preferences file found, using defaults.");
        return {};
    }
}

function saveBrowserPrefs(prefs) {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), "utf8");
    console.log(`>> Browser preferences saved to ${PREFS_FILE}.`);
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
        const ordered = [preferred, ...list.filter((browser) => browser !== preferred)];
        console.log(`>> Browser order resolved: ${ordered.map((b) => browserLabel(b)).join(", ")} (preferred: ${browserLabel(preferred)}).`);
        return ordered;
    }
    console.log(`>> Browser order resolved: ${list.map((b) => browserLabel(b)).join(", ")}.`);
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
        console.log(`>> Deleted browser preferences file: ${PREFS_FILE}`);
    } catch {
        console.log(`>> No browser preferences file to delete (${PREFS_FILE}).`);
    }
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

    if (CLI.promptCreate !== null) return createPromptFlow(CLI.promptCreate);
    if (CLI.promptsAction === "manager") return runPromptManager();

    if (CLI.configureBrowser) return configureDefaultBrowser();
    if (CLI.configureBrowserOrder) return configureBrowserOrder();
    if (CLI.resetBrowserPrefs) return resetBrowserPreferences();

    if (CLI.clearConversations) return clearAllConversations();
    if (CLI.clearConversationId) return clearConversationById(CLI.clearConversationId);

    if (CLI.logout) {
        const context = await launchBrowser();
        const page = context.pages()[0] || await context.newPage();
        try {
            await runLogoutFlow(page);
        } finally {
            await context.close();
        }
        return;
    }

    let targetUrl = URL;
    let continuing = null;
    if (!CLI.login && CLI.continueLast) {
        continuing = CLI.continueConversationId
            ? findConversationById(CLI.continueConversationId)
            : latestConversation();
        if (!continuing) {
            const hint = CLI.continueConversationId
                ? ` No saved conversation matches id "${CLI.continueConversationId}".`
                : "";
            throw new Error(`No saved conversation found.${hint} Run a question first, then use --continue.`);
        }
        console.log(`>> Resuming conversation: "${continuing.title || continuing.id}" (${continuing.messages?.length || 0} messages).`);
    }

    const loginOnly = wantsLogin();
    if (loginOnly) {
        console.log(">> Login mode: launching browser for manual login...");
    }
    const question = loginOnly ? null : loadQuestion();
    if (question && continuing) {
        question.originalText = question.text;
        question.text = buildContinuationPrompt(continuing.messages || [], question.text);
    }

    const context = await launchBrowser();
    markPhase("browser");
    console.log(">> Granting clipboard permissions...");
    await withTimeout(
        context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {}),
        10000,
        "Browser permission setup"
    ).catch((error) => console.log(`>> ${firstLine(error)}; continuing without clipboard permissions.`));
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("\n>> Closing browser...");
        cleanupTempPayloads();
        await context.close().catch(() => {});
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    const page = context.pages()[0] || await context.newPage();
    console.log(`>> Page ready (${page.url()}).`);
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
        const trimmed = answer.trim();
        console.log(`>> Writing answer to ${CLI.outputFile} (${trimmed.length} chars, mode: ${CLI.outputMode})...`);
        if (CLI.outputMode !== "overwrite") {
            const existing = fs.existsSync(CLI.outputFile)
                ? fs.readFileSync(CLI.outputFile, "utf8").replace(/\n+$/, "")
                : "";
            fs.writeFileSync(
                CLI.outputFile,
                CLI.outputMode === "prepend"
                    ? trimmed + "\n\n\n" + existing
                    : existing + "\n\n\n" + trimmed,
                "utf8"
            );
        } else {
            fs.writeFileSync(CLI.outputFile, trimmed + "\n", "utf8");
        }
        const conversation = await recordConversation(page, {
            questionText: question.originalText ?? question.text,
            answer: answer.trim(),
            seedMessages: continuing?.messages || [],
            meta: question.deliveryMeta || null,
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
        cleanupTempPayloads();
        await context.close();
    }
}

main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
});
