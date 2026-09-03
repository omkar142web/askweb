#!/usr/bin/env node

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
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
// Reduced from 500 to 400ms for slightly faster stabilization polling.
const POLL_MS = 400;
// Reduced from 3 to 2 polls: the stop button disappearing already strongly
// signals completion, and 2 polls (0.8s) gives enough time for text to settle.
const STABLE_POLLS_REQUIRED = 2;
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
const AI_PREFS_FILE = path.join(__dirname, ".ai-prefs.json");
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
    "prompts", "prompt-create", "append", "prepend", "logout", "dry-run", "cmd",
    "provider", "ai", "ai-order", "ai-reset",
]);

const CMD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CMD_OUTPUT = 100_000;
const DESTRUCTIVE_CMD_RE = /(?:rm\s+-rf\s+\/|rm\s+-rf\s+~|mkfs\b|dd\s+if=\/dev\/zero|:\(\)\s*\{\s*:\|:&\s*\}|chmod\s+-R\s+777\s+\/)/;

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

// All ChatGPT DOM knowledge (selectors, browser helpers, and the semantic
// popup/composer-detection layer) lives in ./chatgpt-ui so that DOM changes
// only need to be updated in one place. Higher-level code here depends on the
// resilient semantic API (e.g. dismissBlockingUI, isPromptReady), never on raw
// ChatGPT CSS classes.
const {
    selector,
    CHATGPT_DOM,
    PAGE_DOM_SOURCE,
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
    uploadOverlayVisible,
    dismissBlockingUI,
    dismissAndSettle,
    isPromptReady,
    waitForEnabled,
    startPopupMonitor,
} = require("./chatgpt-ui");

const { registerProvider, getProvider, getAllProviders } = require("./providers");
const { createChatGptProvider } = require("./providers/chatgpt");

let CHATGPT_PROVIDER = null;

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

const AUTH_COOKIE_PREFIXES = [
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "authjs.session-token",
];

async function readChatGptCookies(context) {
    const cookies = await context.cookies("https://chatgpt.com").catch(() => []);
    const present = AUTH_COOKIE_PREFIXES.filter((prefix) =>
        cookies.some((c) => c.name === prefix || c.name.startsWith(prefix + "."))
    );
    return { cookies, present, authed: present.length > 0 };
}

async function isLoggedInViaCookies(context) {
    const { authed } = await readChatGptCookies(context).catch(() => ({ authed: false }));
    return authed;
}

chromium.use(stealth);

const VERSION = require("./package.json").version;

function escapeXml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function resolveMaxCmdOutput() {
    const env = process.env.ASKWEB_MAX_CMD_OUTPUT;
    const parsed = Number(env);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_CMD_OUTPUT;
}

function isDestructiveCommand(command) {
    return DESTRUCTIVE_CMD_RE.test(command);
}

function runLocalCommand(command) {
    const maxOutput = resolveMaxCmdOutput();
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let timedOut = false;

    const result = spawnSync(command, {
        timeout: CMD_TIMEOUT_MS,
        encoding: "utf8",
        shell: true,
        maxBuffer: 10 * 1024 * 1024,
    });

    stdout = result.stdout || "";
    stderr = result.stderr || "";
    exitCode = result.status ?? 0;

    if (result.error) {
        stderr = (stderr ? stderr + "\n" : "") + result.error.message;
        exitCode = result.status ?? 1;
    }
    if (result.signal === "SIGTERM" || result.signal === "SIGKILL" || result.error?.code === "ETIMEDOUT") {
        timedOut = true;
        exitCode = -1;
    }

    return {
        command,
        stdout,
        stderr,
        exitCode,
        timedOut,
        success: exitCode === 0 && !timedOut,
        durationMs: Date.now() - start,
        maxOutput,
        blocked: false,
    };
}

function formatCommandResult(result) {
    const truncatedStdout = result.stdout.length > result.maxOutput;
    const truncatedStderr = result.stderr.length > result.maxOutput;
    const displayStdout = truncatedStdout ? result.stdout.slice(0, result.maxOutput) : result.stdout;
    const displayStderr = truncatedStderr ? result.stderr.slice(0, result.maxOutput) : result.stderr;

    let block = `<command name="${escapeXml(result.command)}">\n`;
    block += `<exit_code>${result.exitCode}</exit_code>\n`;
    if (result.timedOut) {
        block += `<timed_out>true</timed_out>\n`;
    }
    block += `<status>${result.success ? "success" : "failed"}</status>\n`;
    if (truncatedStdout || truncatedStderr) {
        block += `<truncated>true</truncated>\n`;
        block += `<truncation_note>Output was truncated to ${result.maxOutput.toLocaleString()} characters per stream. Set ASKWEB_MAX_CMD_OUTPUT to override.</truncation_note>\n`;
    }
    if (result.blocked) {
        block += `<blocked>true</blocked>\n`;
    }
    block += `<stdout>\n${escapeXml(displayStdout)}</stdout>\n`;
    if (displayStderr) {
        block += `<stderr>\n${escapeXml(displayStderr)}</stderr>\n`;
    }
    block += `</command>`;
    return block;
}

async function executeCommands(commands) {
    if (!commands || commands.length === 0) return [];

    const results = [];
    for (const command of commands) {
        console.log(`>> Executing command: ${command}`);

        if (isDestructiveCommand(command)) {
            console.log(`>> WARNING: Skipping potentially destructive command: ${command}`);
            results.push({
                command,
                stdout: "",
                stderr: "Blocked: command matches a known destructive pattern and was not executed.",
                exitCode: -1,
                timedOut: false,
                success: false,
                durationMs: 0,
                maxOutput: resolveMaxCmdOutput(),
                blocked: true,
            });
            continue;
        }

        try {
            const result = runLocalCommand(command);
            const totalChars = result.stdout.length + result.stderr.length;
            if (result.success) {
                console.log(`>> Command finished (exit=${result.exitCode}, ${totalChars} chars, ${result.durationMs}ms).`);
            } else {
                console.log(`>> Command exited with code ${result.exitCode}${result.timedOut ? " (timed out)" : ""} (${totalChars} chars, ${result.durationMs}ms).`);
                if (result.stderr) {
                    console.log(`>> stderr: ${result.stderr.slice(0, 200)}${result.stderr.length > 200 ? "..." : ""}`);
                }
            }
            results.push(result);
        } catch (error) {
            console.log(`>> Command execution error: ${firstLine(error)}`);
            results.push({
                command,
                stdout: "",
                stderr: error.message,
                exitCode: -1,
                timedOut: false,
                success: false,
                durationMs: 0,
                maxOutput: resolveMaxCmdOutput(),
                blocked: false,
            });
        }
    }
    return results;
}

function buildTextPayload(question) {
    const commandBlocks = (question.commandResults || [])
        .map(formatCommandResult)
        .join("\n\n");
    const parts = [];
    if (commandBlocks) parts.push(commandBlocks);
    if (question.text) parts.push(question.text);
    return parts.join("\n\n");
}

const OPTION_DEFINITIONS = [
    {
        flags: ["-o", "--output"],
        arg: "<file>",
        argRequired: true,
        desc: "Write the answer to <file> instead of printing it. The path is resolved relative to your current directory.",
        note: `Default: ${DEFAULT_OUTPUT_FILE}; also accepts --output=<file>.`,
        example: 'askweb -o answer.md "Explain closures"',
    },
    {
        flags: ["--append"],
        desc: "Append the answer to the end of an existing output file.",
        note: "Requires --output. Mutually exclusive with --prepend.",
        example: 'askweb --append --output notes.md "Add a section"',
    },
    {
        flags: ["--prepend"],
        desc: "Prepend the answer to the beginning of an existing output file.",
        note: "Requires --output. Mutually exclusive with --append.",
        example: 'askweb --prepend --output notes.md "New intro at top"',
    },
    {
        flags: ["--login"],
        desc: "Open the ChatGPT login page and wait for you to sign in so the session cookie is saved.",
        note: "Standalone action: ignores the question, files, --continue, and --new.",
        example: "askweb --login",
    },
    {
        flags: ["--logout"],
        desc: "Open ChatGPT and wait for you to log out manually; the session cookie is then cleared.",
        note: "Standalone action (manual, up to 10 minutes).",
        example: "askweb --logout",
    },
    {
        flags: ["--continue"],
        arg: "[id]",
        argOptional: true,
        desc: "Resume a saved conversation. With no id, resumes the most recent one; with a full or prefix id, resumes that one. The saved transcript is replayed into a fresh chat and your new text is appended.",
        note: "Mutually exclusive with --new. The id takes a separate token, not --continue=<id>.",
        example: 'askweb --continue "Give me one more example"',
    },
    {
        flags: ["--new"],
        desc: "Start a fresh conversation. A fresh chat is also the default for every run.",
        note: "Mutually exclusive with --continue.",
        example: "askweb --new \"Let's discuss React\"",
    },
    {
        flags: ["--prompts"],
        desc: "Open the Prompt Manager to add, edit, rename, delete, or view presets.",
        note: "Standalone action (interactive).",
        example: "askweb --prompts",
    },
    {
        flags: ["--prompt-create"],
        arg: "[name]",
        argOptional: true,
        desc: "Interactively create a new prompt preset. If <name> is omitted you are prompted for one.",
        note: "Standalone action (interactive). <name> must match [-a-z0-9_]+ and must not start with '-'.",
        example: "askweb --prompt-create fix",
    },
    {
        flags: ["--<preset>"],
        arg: "[text]",
        argOptional: true,
        desc: "Run a prompt preset like a native command (e.g. --explain, --find-error). Presets accept files and a question.",
        note: `Only one preset per run. Built-ins: ${Object.keys(BUILTIN_PROMPTS).join(", ")}. Custom presets are listed in PROMPT PRESETS below.`,
        example: 'askweb --explain "JavaScript closures"',
    },
    {
        flags: ["--browser"],
        desc: "Open a menu to choose the default browser (Chrome, Brave, Edge).",
        note: "Standalone action (interactive).",
        example: "askweb --browser",
    },
    {
        flags: ["--browser-order"],
        desc: "Open a menu to reorder the browser fallback list used when the default is missing.",
        note: "Standalone action (interactive).",
        example: "askweb --browser-order",
    },
    {
        flags: ["--browser-reset"],
        desc: "Delete saved browser preferences and return to automatic selection (Chrome first).",
        note: "Standalone action.",
        example: "askweb --browser-reset",
    },
    {
        flags: ["--provider"],
        arg: "<name>",
        argRequired: true,
        desc: "Choose AI provider for this run (e.g. chatgpt, gemini). Overrides the default from the --ai menu.",
        note: "Available providers are listed by `askweb --help`. If omitted, the default from --ai (or ChatGPT) is used.",
        example: 'askweb --provider gemini "Explain React"',
    },
    {
        flags: ["--ai"],
        desc: "Open a menu to choose the default AI website (ChatGPT, Gemini).",
        note: "Standalone action (interactive).",
        example: "askweb --ai",
    },
    {
        flags: ["--ai-order"],
        desc: "Open a menu to reorder the AI website fallback list interactively.",
        note: "Standalone action (interactive).",
        example: "askweb --ai-order",
    },
    {
        flags: ["--ai-reset"],
        desc: "Delete saved AI website preferences and return to automatic selection (ChatGPT first).",
        note: "Standalone action.",
        example: "askweb --ai-reset",
    },
    {
        flags: ["--clear-session"],
        desc: "Wipe the browser profile's local/session storage before launching, so the AI website starts fresh (logged out) for this run.",
        note: "Modifier: combine with a question or with --login.",
        example: 'askweb --clear-session "What is today\'s date?"',
    },
    {
        flags: ["--clear-conversations"],
        desc: "Delete the local conversation history file (.chatgpt-conversations.json).",
        note: "Standalone action. To remove one conversation, use --clear-conversation <id>.",
        example: "askweb --clear-conversations",
    },
    {
        flags: ["--clear-conversation"],
        arg: "<id>",
        argRequired: true,
        desc: "Delete a single saved conversation whose id starts with <id> (full id or a unique prefix).",
        note: "Standalone action. Also accepts --clear-conversation=<id>.",
        example: "askweb --clear-conversation <id>",
    },
    {
        flags: ["-h", "--help"],
        desc: "Show this help.",
        example: "askweb --help",
    },
    {
        flags: ["-v", "--version"],
        desc: "Show the version and exit.",
        example: "askweb --version",
    },
    {
        flags: ["--dry-run"],
        desc: "Print the exact prompt payload that would be sent to ChatGPT, then exit. No browser is launched and nothing is sent.",
        note: "Cannot be combined with standalone actions: --login, --logout, --browser, --browser-order, --browser-reset, --prompts, --prompt-create, --ai, --ai-order, --ai-reset, --clear-conversations, or --clear-conversation.",
        example: 'askweb --dry-run "Explain closures"',
    },
    {
        flags: ["--cmd"],
        arg: "<command>",
        argRequired: true,
        desc: "Execute a local shell command and include its stdout/stderr output in the prompt sent to ChatGPT.",
        note: "Can be repeated for multiple commands. Each command runs with a 30s timeout and is capped at ASKWEB_MAX_CMD_OUTPUT characters per stream (default 100 KB). Obvious destructive patterns are blocked.",
        example: 'askweb --cmd "git status" "Explain the current repository state."',
    },
];

function renderOption(def) {
    const head = def.arg ? def.flags.join(", ") + " " + def.arg : def.flags.join(", ");
    const notes = [];
    if (def.argRequired) notes.push("Requires an argument.");
    if (def.argOptional) notes.push("Argument is optional.");
    notes.push(def.desc);
    if (def.note) notes.push(def.note);
    return "  " + head + "\n" + notes.map((n) => "      " + n).join("\n") + "\n      Example: " + def.example;
}

const HELP_TEMPLATE_PATH = path.join(__dirname, "help-template.txt");

function loadHelpTemplate() {
    try {
        return fs.readFileSync(HELP_TEMPLATE_PATH, "utf8");
    } catch (error) {
        throw new Error(
            `Failed to read help template at ${HELP_TEMPLATE_PATH}: ${error.message}`
        );
    }
}

function buildHelpText() {
    const registry = loadPromptRegistry();
    const builtins = Object.entries(BUILTIN_PROMPTS);
    const noInput = builtins.filter(([, e]) => !normalizePromptEntry(e).arguments).map(([n]) => `--${n}`);
    const withInput = builtins.filter(([, e]) => normalizePromptEntry(e).arguments).map(([n]) => `--${n}`);
    const custom = [...registry.entries()].filter(([, e]) => !e.builtin);
    const customNote = custom.length
        ? "Custom presets: " +
          custom.map(([n, e]) => `--${n}` + (e.arguments ? " (takes {{input}})" : "")).join(", ") +
          "."
        : "No custom presets yet (create one with --prompt-create <name>).";

    const values = {
        DEFAULT_QUESTION,
        DEFAULT_OUTPUT_FILE,
        OPTION_DEFINITIONS: OPTION_DEFINITIONS.map(renderOption).join("\n\n"),
        NO_INPUT: noInput.join(", "),
        WITH_INPUT: withInput.join(", "),
        CUSTOM_NOTE: customNote,
    };

    const template = loadHelpTemplate();
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            return values[key];
        }
        return match;
    });
}

function showHelp() {
    console.log(buildHelpText());
}

function parseCliArgs(argv = process.argv.slice(2)) {
    const options = {
        login: false,
        logout: false,
        dryRun: false,
        clearSession: false,
        clearConversations: false,
        clearConversationId: null,
        configureBrowser: false,
        configureBrowserOrder: false,
        resetBrowserPrefs: false,
        configureAI: false,
        configureAIOrder: false,
        resetAIPrefs: false,
        provider: null,
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
        commands: [],
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
            if (!value || value.startsWith("-")) {
                throw new Error(`${arg} requires a conversation id (use ${arg}=<id> to pass a value starting with "-")`);
            }
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
            if (next && looksLikeConversationId(stripShellQuotes(next))) {
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

        if (arg === "--ai") {
            options.configureAI = true;
            continue;
        }

        if (arg === "--ai-order") {
            options.configureAIOrder = true;
            continue;
        }

        if (arg === "--ai-reset") {
            options.resetAIPrefs = true;
            continue;
        }

        if (arg === "--provider") {
            const value = argv[i + 1];
            if (!value || value.startsWith("-")) {
                throw new Error(`${arg} requires a provider name (use ${arg}=<name> to pass a value starting with "-")`);
            }
            options.provider = stripShellQuotes(value);
            i++;
            continue;
        }

        if (arg.startsWith("--provider=")) {
            const value = arg.slice("--provider=".length);
            if (!value) throw new Error("--provider requires a provider name");
            options.provider = stripShellQuotes(value);
            continue;
        }

        if (arg === "--dry-run") {
            options.dryRun = true;
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

        if (arg === "--cmd") {
            const value = argv[i + 1];
            if (!value || value.startsWith("-")) {
                throw new Error(`${arg} requires a command string (use ${arg}=<command> to pass a value starting with "-")`);
            }
            options.commands.push(stripShellQuotes(value));
            i++;
            continue;
        }

        if (arg.startsWith("--cmd=")) {
            const value = arg.slice("--cmd=".length);
            if (!value) throw new Error("--cmd requires a command string");
            options.commands.push(stripShellQuotes(value));
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
            if (!value || value.startsWith("-")) {
                throw new Error(`${arg} requires a file path (use ${arg}=<path> to pass a value starting with "-")`);
            }
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
        text = extra || (CLI.commands.length > 0 ? "Analyze and summarize the following command output." : DEFAULT_QUESTION);
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
    const stageStart = Date.now();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askweb-payload-"));
        const file = path.join(dir, "payload.md");
        fs.writeFileSync(file, payload, "utf8");
        ACTIVE_TEMP_FILES.push(dir);
        const stageMs = Date.now() - stageStart;
        console.log(`>> Temp payload staged: ${file} (${(payload.length / 1024).toFixed(1)} KB).`);
        if (stageMs >= 50) console.log(`>> [timing] stageTempPayload=${(stageMs/1000).toFixed(1)}s`);
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

const chipError = (name) => new Error(`attachment chip for "${name}" never appeared`);

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
            ({ userSelector, stopSelector, promptSelector, firstVisibleElement, elementText, isUsableControl, before }) => {
                if (document.querySelectorAll(userSelector).length > before) return true;
                const stopButton = document.querySelector(stopSelector);
                if (eval(isUsableControl)(stopButton)) return true;
                const input = eval(firstVisibleElement)(promptSelector);
                const text = eval(elementText)(input);
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
        // Before re-clicking, check whether the first click silently succeeded.
        // The send may have been accepted but the DOM signals (user-message
        // count, stop button, composer empty) can take a moment to register
        // — a delayed detection should still be treated as success, avoiding
        // a duplicate prompt submission.
        const alreadyAccepted = await waitForSendAccepted(page, countBefore, 3000);
        if (alreadyAccepted) {
            console.log(">> Send confirmed (initial click succeeded, detection was delayed).");
            return true;
        }
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

async function resetComposer(page, targetUrl = URL, context = null) {
    await dismissBlockingUI(page);
    if (!(await uploadOverlayVisible(page))) return;

    console.log(">> Upload overlay still visible, reloading ChatGPT...");
    await gotoChatGPT(page, targetUrl);
    await page.waitForTimeout(2000);
    await waitForChatGPTReady(page, targetUrl, context);
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

async function waitForChatGPTReady(page, targetUrl = URL, context = null) {
    console.log(">> Opening ChatGPT...");
    let loggedIn = context ? await isLoggedInViaCookies(context) : null;
    if (loggedIn) console.log(">> Login detected via session cookie.");
    else if (loggedIn === false) console.log(">> Not logged in (no ChatGPT session cookie). Use --login to sign in for uploads.");
    await gotoChatGPT(page, targetUrl);
    await page.waitForTimeout(2000);

    const deadline = Date.now() + 5 * 60 * 1000;
    let lastNotice = 0;
    while (Date.now() < deadline) {
        if (context) {
            loggedIn = await isLoggedInViaCookies(context);
        }

        await dismissBlockingUI(page);

        if (await isPromptReady(page)) break;

        if (Date.now() - lastNotice > 15000) {
            lastNotice = Date.now();
            const elapsed = Math.round((Date.now() - (deadline - 5 * 60 * 1000)) / 1000);
            if (loggedIn) {
                console.log(`>> Logged in (session cookie present), waiting for the prompt to become ready... (${elapsed}s) url=${page.url()}`);
            } else if (isOnAuthPage(page)) {
                console.log(`>> Waiting for login... (${elapsed}s) Not logged in in this browser profile. Log in inside the window, or run \`askweb --login\`.`);
            } else {
                const pageText = await page.evaluate(() => document.body.innerText.slice(0, 120)).catch(() => "");
                const summary = pageText.replace(/\s+/g, " ").trim() || "(empty page)";
                console.log(`>> Not logged in, running anonymously; waiting for ChatGPT prompt... (${elapsed}s) url=${page.url()} text="${summary}"`);
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

async function attachmentChipProbe(page, fileName) {
    return page
        .evaluate(
            ({ composerSelector, progressSelector, finderSource, name }) => {
                const composer = eval(finderSource)(composerSelector);
                const region =
                    (composer && composer.closest("form")) ||
                    (composer && composer.parentElement && composer.parentElement.parentElement) ||
                    null;
                const stem = name.replace(/\.[^.]+$/, "");
                const fileNameLower = name.toLowerCase();
                const stemLower = stem.length > 3 ? stem.toLowerCase() : null;
                const matches = (el) => {
                    if (el.closest(composerSelector)) return false;
                    const text = (el.textContent || "").trim();
                    if (text.length > 300) return false;
                    const lower = text.toLowerCase();
                    return lower.includes(fileNameLower) || (stemLower && lower.includes(stemLower));
                };
                let present = false;
                if (region) {
                    // Faster path: check the composer's attachment/preview strip first (a small
                    // high-signal subtree). Only fall back to the full form walk if no chip classes
                    // are present, so a successful upload is confirmed without walking every
                    // descendant of the whole form on each 700ms poll.
                    const scopes = [];
                    let cur = composer;
                    while (cur && scopes.length < 4) {
                        for (const node of cur.querySelectorAll("[class*='attach'], [class*='chip']")) {
                            scopes.push(node);
                        }
                        cur = cur.parentElement;
                    }
                    for (const scope of scopes.length ? scopes : [region]) {
                        for (const el of scope.querySelectorAll("*")) {
                            if (matches(el)) {
                                present = true;
                                break;
                            }
                        }
                        if (present) break;
                    }
                }
                return { present, uploading: !!region && !!region.querySelector(progressSelector) };
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
    console.log(`>> [timing] waitForAttachmentChip: TIMEOUT after 25.0s`);
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
    await attachButton(page).click();

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
    const inputs = fileInput(page);
    const count = await inputs.count();
    if (count === 0) throw new Error("no input[type=file] in DOM");
    console.log(`>> Found ${count} file input(s), attempting file-input attach...`);

    let skipped = 0;
    let totalSetInputMs = 0;
    let totalChipMs = 0;
    let lastError;
    // Try from index 0 upward. ChatGPT's live upload input is consistently
    // the first input[type=file] in the DOM; dead inputs (hidden/legacy)
    // are appended later. Starting at 0 hits the working input on the first
    // try, skipping the ~1.5s probe cycle on every dead input.
    for (let i = 0; i < count; i++) {
        try {
            const setInputStart = Date.now();
            await inputs.nth(i).setInputFiles(files.map((f) => f.fullPath), { timeout: 5000 });
            totalSetInputMs += Date.now() - setInputStart;

            // Give ChatGPT a brief moment to react to the file input being set.
            // Wrong inputs (not wired to ChatGPT's real upload UI) accept files
            // silently without triggering any attachment chip or upload progress.
            // Detecting this quickly avoids wasting the full 25s waitForAttachmentChip
            // timeout on each wrong input.
            await page.waitForTimeout(1500);
            const quickProbe = await attachmentChipProbe(page, files[0].name);

            if (!quickProbe.present && !quickProbe.uploading) {
                console.log(`>> Input ${i} produced no upload activity, skipping...`);
                skipped += 1;
                continue;
            }

            // This input triggered an upload - wait for the full chip appearance
            const chipStart = Date.now();
            if (!(await waitForAttachmentChip(page, files[0].name))) {
                throw chipError(files[0].name);
            }
            totalChipMs += Date.now() - chipStart;
            console.log(`>> File-input attach succeeded for "${files[0].name}".`);
            console.log(`>> [timing] file-input: setInputFiles=${(totalSetInputMs/1000).toFixed(1)}s, attachment-detection=${(totalChipMs/1000).toFixed(1)}s, skipped=${skipped} input(s)`);
            return;
        } catch (error) {
            lastError = error;
            skipped += 1;
        }
    }
    throw lastError || new Error("input[type=file] attach failed");
}

async function rejectIfUploadOverlay(page, fileName) {
    if (await uploadOverlayVisible(page)) {
        await dismissBlockingUI(page);
        throw new Error(`upload overlay rejected "${fileName}"`);
    }
}

async function attachFiles(page, files) {
    const attachStart = Date.now();
    await dismissBlockingUI(page);
    try {
        await attachViaFileInput(page, files);
        const ms = Date.now() - attachStart;
        console.log(`>> [timing] attachFiles (file-input) total=${(ms/1000).toFixed(1)}s`);
        return "file-input";
    } catch (inputError) {
        await rejectIfUploadOverlay(page, files[0].name);
        console.log(`>> File-input attach failed (${firstLine(inputError)}), trying chooser...`);
        try {
            await attachViaChooser(page, files);
            const ms = Date.now() - attachStart;
            console.log(`>> [timing] attachFiles (chooser) total=${(ms/1000).toFixed(1)}s`);
            return "chooser";
        } catch (chooserError) {
            await rejectIfUploadOverlay(page, files[0].name);
            console.log(`>> Chooser attach failed (${firstLine(chooserError)}), trying drag/drop...`);
            try {
                await attachViaDrop(page, files);
                const ms = Date.now() - attachStart;
                console.log(`>> [timing] attachFiles (drop) total=${(ms/1000).toFixed(1)}s`);
                return "drop";
            } catch (dropError) {
                await dismissBlockingUI(page);
                throw new Error(`all attach strategies failed: ${firstLine(dropError)}`);
            }
        }
    }
}

function buildFullPrompt(question, options = {}) {
    const { includeFiles = true } = options;
    const commandBlocks = (question.commandResults || [])
        .map(formatCommandResult)
        .join("\n\n");
    const parts = [];
    if (commandBlocks) parts.push(commandBlocks);
    if (question.text) parts.push(question.text);
    if (includeFiles) {
        const filesBlocks = question.files.map(fileBlock).join("");
        const hasBinary = question.files.some((file) => !file.isText);
        if (filesBlocks) parts.push(filesBlocks);
        if (hasBinary) parts.push(DECODE_NOTE);
    }
    return parts.join("\n\n");
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
    const deadline = Date.now() + timeoutMs;
    let noticed = false;
    while (Date.now() < deadline) {
        if (!(await isStopVisible(page))) return true;
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

async function isStopVisible(page) {
    return stopButton(page).isVisible().catch(() => false);
}

async function waitForSendReady(page) {
    const deadline = Date.now() + 5000;
    while (!(await sendButtonUsable(page))) {
        if (Date.now() > deadline) break;
        await page.waitForTimeout(300);
    }
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
            await waitForSendReady(page);
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

        await waitForSendReady(page);

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

async function sendQuestion(page, question, targetUrl = URL, context = null) {
    const input = await waitForChatGPTReady(page, targetUrl, context);
    markPhase("ready");
    const assistantCountBefore = await assistantMessages(page).count();

    let attached = false;
    const loggedIn = context ? await isLoggedInViaCookies(context) : !(await looksLoggedOut(page));
    if (!loggedIn) {
        console.log(">> Detected: not logged in (no session cookie). Upload features will be limited.");
    } else {
        console.log(">> Logged in (session cookie present).");
    }
    if (question.files.length > 0) {
        console.log(`>> Loaded ${question.files.length} file(s): ${question.files.map((file) => file.name).join(", ")}`);
        if (shouldPasteFiles(question.files)) {
            console.log(">> Text/code file detected, using paste mode.");
        } else if (!loggedIn) {
            console.log(">> Not logged in - file upload is unavailable, falling back to paste mode.");
        } else {
            try {
                await attachFiles(page, question.files);
                attached = true;
                console.log(`>> Attached ${question.files.length} file(s) via upload.`);
                await page.waitForTimeout(3000);
            } catch (error) {
                console.log(`>> Upload failed (${firstLine(error)}), falling back to paste.`);
                await resetComposer(page, targetUrl, context);
            }
        }
    }

    if (!(await isPromptReady(page))) {
        await dismissAndSettle(page);
    }

    const payload = attached ? buildTextPayload(question) : buildFullPrompt(question);
    let deliveryPlan = null;
    let stagedAttachmentName = null;

    if (!attached && payload.length > SINGLE_PASTE_MAX) {
        console.log(
            `>> Payload is ${(payload.length / 1024).toFixed(1)} KB, above the ${Math.round(SINGLE_PASTE_MAX / 1024)} KB single-message budget.`
        );
        let staged = null;
        if (!loggedIn) {
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
                await resetComposer(page, targetUrl, context);
            }
        }
        if (!attached) {
            const { plan, manualChunkSize } = buildDeliveryPlan(payload);
            deliveryPlan = plan;
            if (!loggedIn && deliveryPlan.totalParts > ANON_MAX_PARTS) {
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
        console.log(`>> Chunked transmission complete (baseline: ${baseline} replies).`);
        markPhase("write");
        markPhase("send");
        return baseline;
    }

    const finalInput = promptInput(page);
    const composerText = stagedAttachmentName
        ? `${buildTextPayload(question)}\n\n(The complete document context was attached as "${stagedAttachmentName}").`.trim()
        : payload;
    const expectedParts = [];
    if (question.text) expectedParts.push(question.text.trim().slice(0, 60));
    if (!attached && question.files.length > 0) expectedParts.push("</file>");
    if (question.commandResults && question.commandResults.length > 0) {
        expectedParts.push('<command name="');
    }

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
        const stopVisible = await isStopVisible(page);
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
    const stabStart = Date.now();
    let stableCount = 0;
    let textStableCount = 0;
    const answer = replies.last();
    await answer.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
    let prevLength = (await answer.innerText().catch(() => "")).trim().length;

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
        // disappeared, which indicates ChatGPT finished generating.
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

    console.log(`>> Generation stable (${totalPolls} polls, final length: ${prevLength} chars, took ${Date.now() - stabStart}ms).`);
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

async function runLoginFlow(page, context = null) {
    console.log(">> Starting login flow. Please log in with your account (up to 10 min)...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    const startTime = Date.now();
    const maxWait = 10 * 60 * 1000;

    while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(2000);

        const loggedInByCookie = context ? await isLoggedInViaCookies(context) : false;
        if (loggedInByCookie) {
            console.log(">> Login detected via session cookie. Session saved in the browser profile for future runs.");
            return;
        }

        if (!isOnAuthPage(page)) {
            await dismissBlockingUI(page);

            const input = promptInput(page);
            if (await input.count() > 0) {
                try {
                    await input.waitFor({ state: "visible", timeout: 5000 });
                    await waitForEnabled(page, input);
                    await input.click({ timeout: 5000 });
                    if (context) {
                        console.log(">> Login prompt ready. Confirming authentication...");
                        const confirmDeadline = Date.now() + 15000;
                        while (Date.now() < confirmDeadline) {
                            if (await isLoggedInViaCookies(context)) {
                                console.log(">> Login detected via session cookie. Session saved in the browser profile for future runs.");
                                return;
                            }
                            await page.waitForTimeout(1000);
                        }
                    } else {
                        console.log(">> Login detected. Session saved in the browser profile for future runs.");
                        return;
                    }
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

async function runLogoutFlow(page, context = null) {
    console.log(">> Opening ChatGPT. Please log out manually...");
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    const startTime = Date.now();
    const maxWait = 10 * 60 * 1000;

    while (Date.now() - startTime < maxWait) {
        await page.waitForTimeout(2000);

        const loggedInByCookie = context ? await isLoggedInViaCookies(context) : false;
        if (!loggedInByCookie) {
            console.log(">> Logout detected via session cookie. Session cleared.");
            return;
        }
    }

    throw new Error("Logout timed out after 10 minutes. Please try again.");
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
    if (matches.length > 1) {
        console.log(`>> Multiple conversations match id prefix "${idPrefix}". Use a longer prefix to be specific:`);
        for (const conversation of matches) {
            console.log(`   - ${conversation.id}${conversation.title ? ` ("${conversation.title}")` : ""}`);
        }
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

function looksLikeConversationId(token) {
    const trimmed = String(token || "").trim();
    if (!trimmed) return false;
    const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (fullUuid.test(trimmed)) return true;
    return loadConversations().conversations.some((conversation) =>
        String(conversation.id || "").toLowerCase().startsWith(trimmed.toLowerCase())
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
        throw new Error(`Conversation id prefix "${idPrefix}" is ambiguous. Use a longer prefix to be specific.`);
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

async function recordConversation(page, run, provider) {
    try {
        console.log(">> Recording conversation to local history...");
        const convId = provider ? await provider.getConversationId(page) : null;
        const convIdStr = convId;

        let title = null;
        if (provider && provider.getConversationTitle) {
            title = await provider.getConversationTitle(page);
        } else {
            title = (await page.title().catch(() => "")).replace(/\s*-\s*ChatGPT\s*$/i, "").trim();
        }

        const seedMessages = Array.isArray(run.seedMessages) ? run.seedMessages : [];
        const entry = {
            id: convIdStr || crypto.randomUUID(),
            provider: provider ? provider.id : "chatgpt",
            url: convIdStr ? `${provider ? provider.url : URL}c/${convIdStr}` : null,
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

function loadAIPrefs() {
    try {
        const prefs = JSON.parse(fs.readFileSync(AI_PREFS_FILE, "utf8"));
        console.log(`>> Loaded AI preferences (default: ${prefs.defaultAI || "auto"}).`);
        return prefs;
    } catch {
        console.log(">> No AI preferences file found, using defaults.");
        return {};
    }
}

function saveAIPrefs(prefs) {
    fs.writeFileSync(AI_PREFS_FILE, JSON.stringify(prefs, null, 2), "utf8");
    console.log(`>> AI preferences saved to ${AI_PREFS_FILE}.`);
}

function aiLabel(provider) {
    if (!provider) return "";
    return provider.name || provider.id;
}

function aiByName(name) {
    try {
        return getProvider(name);
    } catch {
        return undefined;
    }
}

function orderedAIProviders() {
    const prefs = loadAIPrefs();
    const savedOrder = Array.isArray(prefs.aiOrder)
        ? prefs.aiOrder.map(aiByName).filter(Boolean)
        : [];
    const seen = new Set(savedOrder.map((provider) => provider.id));
    const list = [...savedOrder, ...getAllProviders().filter((provider) => !seen.has(provider.id))];

    const preferred = prefs.defaultAI ? aiByName(prefs.defaultAI) : null;
    if (preferred) {
        const ordered = [preferred, ...list.filter((provider) => provider !== preferred)];
        console.log(`>> AI provider order resolved: ${ordered.map((p) => aiLabel(p)).join(", ")} (preferred: ${aiLabel(preferred)}).`);
        return ordered;
    }
    console.log(`>> AI provider order resolved: ${list.map((p) => aiLabel(p)).join(", ")}.`);
    return list;
}

async function configureDefaultAI() {
    const prefs = loadAIPrefs();
    const current = orderedAIProviders();

    console.log("\nAI website configuration\n");
    console.log(
        `Current default: ${
            prefs.defaultAI && aiByName(prefs.defaultAI)
                ? aiLabel(aiByName(prefs.defaultAI))
                : `${aiLabel(current[0])} (automatic)`
        }\n`
    );
    getAllProviders().forEach((provider, index) => {
        console.log(`${index + 1}. ${aiLabel(provider)}`);
    });

    const answer = await promptUser("\nEnter number to change default (Enter keeps current): ");
    if (!answer) {
        console.log(">> Default unchanged.");
        return;
    }

    if (!/^\d+$/.test(answer) || Number(answer) < 1 || Number(answer) > getAllProviders().length) {
        console.log(">> Invalid selection, default unchanged.");
        return;
    }

    const chosen = getAllProviders()[Number(answer) - 1];
    prefs.defaultAI = chosen.id;
    saveAIPrefs(prefs);
    console.log(`\n✓ Default AI website changed to ${aiLabel(chosen)}.`);
}

async function configureAIOrder() {
    const prefs = loadAIPrefs();
    const current = orderedAIProviders();

    console.log("\nCurrent order:");
    current.forEach((provider, index) => {
        console.log(`${index + 1}. ${aiLabel(provider)}`);
    });

    const answer = await promptUser("\nEnter new order (e.g. 2,1): ");
    const indices = answer
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((n) => Number.isInteger(n));

    const isValid =
        indices.length === getAllProviders().length &&
        new Set(indices).size === getAllProviders().length &&
        indices.every((n) => n >= 1 && n <= getAllProviders().length);

    if (!isValid) {
        console.log(`>> Invalid order (need a permutation of 1-${getAllProviders().length}), unchanged.`);
        return;
    }

    prefs.aiOrder = indices.map((n) => current[n - 1].id);
    saveAIPrefs(prefs);
    console.log(
        `\n✓ AI website order updated: ${prefs.aiOrder.map((id) => aiLabel(aiByName(id))).join(", ")}.`
    );
}

function resetAIPreferences() {
    try {
        fs.unlinkSync(AI_PREFS_FILE);
        console.log(`>> Deleted AI preferences file: ${AI_PREFS_FILE}`);
    } catch {
        console.log(`>> No AI preferences file to delete (${AI_PREFS_FILE}).`);
    }
    console.log("✓ AI preferences reset to automatic (ChatGPT first).");
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
            if (wantsClearSession()) {
                // clearSessionData() above only wipes Local Storage LevelDB files.
                // ChatGPT auth is cookie-based, so we must also clear cookies here
                // — after context creation so Playwright's API is available.
                await context.clearCookies();
                console.log(`>> --clear-session: cleared browser cookies for ${browser.name}`);
            }
            console.log(`>> Browser: ${browser.name} (profile: ${browser.profileDir})`);
            return context;
        } catch (error) {
            console.log(`>> ${browser.name} failed to launch (${firstLine(error)}), trying next browser...`);
            lastError = error;
        }
    }
    throw new Error(`No browser could be launched (tried: ${browsersToTry.map((b) => b.name).join(", ")}). ${lastError?.message || ""}`);
}

async function loadQuestion() {
    console.log(">> Loading question and attachments...");
    const question = parseQuestion();
    console.log(
        `>> Parsed: text="${(question.text || "").slice(0, 80).replace(/\s+/g, " ").trim()}${
            (question.text || "").length > 80 ? "..." : ""
        }" | files: ${question.files.length} | commands: ${CLI.commands.length}`
    );
    question.files = loadFiles(question.files);
    question.commandResults = await executeCommands(CLI.commands);
    console.log(
        `>> Question ready (text: ${(question.text || "").length} chars, files: ${question.files.length}, command results: ${
            question.commandResults.length
        }).`
    );
    return question;
}

CHATGPT_PROVIDER = createChatGptProvider({
    gotoChatGPT,
    waitForChatGPTReady,
    isLoggedInViaCookies,
    isOnAuthPage,
    runLoginFlow,
    runLogoutFlow,
    promptInput,
    sendButton,
    stopButton,
    attachButton,
    fileInput,
    assistantMessages,
    userMessages,
    dismissBlockingUI,
    dismissAndSettle,
    isPromptReady,
    waitForEnabled,
    uploadOverlayVisible,
    isStopVisible,
    waitForGenerationEnd,
    attachFiles,
    typePrompt,
    pressSendAndConfirm,
    sendQuestion,
    waitForAnswer,
    looksLoggedOut,
    resetComposer,
    startPopupMonitor,
    buildFullPrompt,
    buildTextPayload,
    stageTempPayload,
    buildDeliveryPlan,
    buildTransmissionFinale,
    splitPayloadChunks,
    buildTransmissionPlan,
});
registerProvider(CHATGPT_PROVIDER);

try { require("./providers/gemini"); } catch (e) {}

async function main() {
    console.log(`>> askweb v${VERSION}`);
    if (CLI.showHelp) {
        console.log(">> Mode: help");
        return showHelp();
    }
    if (CLI.showVersion) {
        console.log(">> Mode: version");
        return console.log(`v${VERSION}`);
    }

    if (CLI.dryRun && (CLI.login || CLI.logout || CLI.configureBrowser || CLI.configureBrowserOrder || CLI.resetBrowserPrefs || CLI.configureAI || CLI.configureAIOrder || CLI.resetAIPrefs || CLI.promptsAction === "manager" || CLI.promptCreate !== null || CLI.clearConversations || CLI.clearConversationId)) {
        console.log(">> Mode: dry-run (rejected - incompatible flags)");
        console.log(">> --dry-run can only be combined with a question (optionally with files or a preset). It cannot be combined with standalone actions like --login, --logout, --browser, --browser-order, --browser-reset, --ai, --ai-order, --ai-reset, --prompts, --prompt-create, --clear-conversations, or --clear-conversation. Exiting without performing any action.");
        return;
    }

    if (CLI.promptCreate !== null) {
        console.log(">> Mode: prompt create");
        return createPromptFlow(CLI.promptCreate);
    }
    if (CLI.promptsAction === "manager") {
        console.log(">> Mode: prompt manager");
        return runPromptManager();
    }

    if (CLI.configureBrowser) {
        console.log(">> Mode: browser configuration");
        return configureDefaultBrowser();
    }
    if (CLI.configureBrowserOrder) {
        console.log(">> Mode: browser order configuration");
        return configureBrowserOrder();
    }
    if (CLI.resetBrowserPrefs) {
        console.log(">> Mode: browser preferences reset");
        return resetBrowserPreferences();
    }

    if (CLI.configureAI) {
        console.log(">> Mode: AI configuration");
        return configureDefaultAI();
    }
    if (CLI.configureAIOrder) {
        console.log(">> Mode: AI order configuration");
        return configureAIOrder();
    }
    if (CLI.resetAIPrefs) {
        console.log(">> Mode: AI preferences reset");
        return resetAIPreferences();
    }

    if (CLI.clearConversations) {
        console.log(">> Mode: clear all conversations");
        return clearAllConversations();
    }
    if (CLI.clearConversationId) {
        console.log(">> Mode: clear conversation");
        return clearConversationById(CLI.clearConversationId);
    }

    let provider;
    if (CLI.provider) {
        try {
            provider = getProvider(CLI.provider);
        } catch (error) {
            console.error(`Error: ${error.message}`);
            process.exit(1);
        }
    } else {
        provider = orderedAIProviders()[0];
    }
    console.log(`>> Provider: ${provider.name}`);

    if (CLI.logout) {
        console.log(">> Mode: logout");
        const context = await launchBrowser();
        const page = context.pages()[0] || await context.newPage();
        try {
            await provider.runLogoutFlow(page, context);
        } finally {
            await context.close();
        }
        return;
    }

    let targetUrl = provider.url;
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

        const savedProvider = continuing.provider || "chatgpt";
        if (CLI.provider && CLI.provider !== savedProvider) {
            console.log(`>> Warning: --provider ${CLI.provider} differs from the conversation's original provider (${savedProvider}).`);
            console.log(`>> Using --provider as requested; transcript will be replayed via ${provider.name}.`);
        } else if (!CLI.provider && savedProvider && savedProvider !== provider.id) {
            console.log(`>> Note: This conversation was originally started with ${savedProvider}, but continuing with the currently selected provider (${provider.name}).`);
            console.log(`>> Use --provider ${savedProvider} to continue with the original provider.`);
        } else {
            console.log(`>> Resuming with provider: ${provider.name}`);
        }
    }

    const loginOnly = wantsLogin();
    if (loginOnly) {
        console.log(">> Login mode: launching browser for manual login...");
    }
    if (CLI.dryRun) {
        console.log(">> Mode: dry run");
    } else if (loginOnly) {
        console.log(">> Mode: login");
    } else {
        console.log(">> Mode: question");
    }
    const question = loginOnly ? null : await loadQuestion();
    if (question && continuing) {
        console.log(">> Building continuation prompt from saved history...");
        question.originalText = question.text;
        question.text = buildContinuationPrompt(continuing.messages || [], question.text);
        console.log(`>> Continuation prompt built (history: ${continuing.messages.length} messages, ${question.text.length} chars total).`);
    }

    if (CLI.dryRun) {
        const payload = buildFullPrompt(question);
        process.stdout.write(`\n--- DRY RUN: PROMPT THAT WOULD BE SENT TO ${provider.name.toUpperCase()} ---\n`);
        process.stdout.write(payload);
        process.stdout.write("\n--- END DRY RUN ---\n");
        console.log(`>> Payload length: ${payload.length} characters`);
        return;
    }

    console.log(">> Launching browser...");
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

    let popupMonitor = null;
    try {
        if (loginOnly) {
            await provider.runLoginFlow(page, context);
            return;
        }
        if (continuing) {
            console.log(
                `>> Replaying ${continuing.messages.length} saved message(s) into a fresh chat${continuing.title ? ` ("${continuing.title}")` : ""}`
            );
        }
        popupMonitor = provider.startPopupMonitor(page);
        console.log(">> Popup safety monitor active (continuous blocking-UI detection).");
        const assistantCountBefore = await provider.sendQuestion(page, question, targetUrl, context);
        console.log(">> Prompt sent, waiting for response...");
        const reply = await provider.waitForAnswer(page, assistantCountBefore);
        console.log("\n--- ANSWER ---\n");
        console.log(reply.trim());
        const trimmed = reply.trim();
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
            answer: reply.trim(),
            seedMessages: continuing?.messages || [],
            meta: question.deliveryMeta || null,
            provider: provider.id,
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
        if (popupMonitor) popupMonitor.stop();
        cleanupTempPayloads();
        await context.close();
        console.log(">> Session ended.");
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error("Error:", error.message);
        process.exit(1);
    });
}

module.exports = {
    parseCliArgs,
    RESERVED_PROMPT_FLAGS,
    OPTION_DEFINITIONS,
    DEFAULT_QUESTION,
    DEFAULT_OUTPUT_FILE,
    AI_PREFS_FILE,
    PREFS_FILE,
    loadAIPrefs,
    saveAIPrefs,
    orderedAIProviders,
    configureDefaultAI,
    configureAIOrder,
    resetAIPreferences,
};
