"use strict";

const fs = require("fs");
const path = require("path");

const AI_PREFS_FILE = path.join(__dirname, "..", ".ai-prefs.json");

let savedPrefs = null;
if (fs.existsSync(AI_PREFS_FILE)) {
    savedPrefs = fs.readFileSync(AI_PREFS_FILE, "utf8");
}

let total = 0;
const failures = [];
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}

function cleanPrefs() {
    if (fs.existsSync(AI_PREFS_FILE)) {
        fs.unlinkSync(AI_PREFS_FILE);
    }
}

function restorePrefs() {
    if (savedPrefs !== null) {
        fs.writeFileSync(AI_PREFS_FILE, savedPrefs, "utf8");
    } else if (fs.existsSync(AI_PREFS_FILE)) {
        fs.unlinkSync(AI_PREFS_FILE);
    }
}

const { parseCliArgs, RESERVED_PROMPT_FLAGS, OPTION_DEFINITIONS } = require("../index.js");

cleanPrefs();

check("--ai parses as configureAI", (() => {
    const opts = parseCliArgs(["--ai"]);
    check("configureAI flag set", opts.configureAI === true);
    return true;
})());

check("--ai-order parses as configureAIOrder", (() => {
    const opts = parseCliArgs(["--ai-order"]);
    check("configureAIOrder flag set", opts.configureAIOrder === true);
    return true;
})());

check("--ai-reset parses as resetAIPrefs", (() => {
    const opts = parseCliArgs(["--ai-reset"]);
    check("resetAIPrefs flag set", opts.resetAIPrefs === true);
    return true;
})());

check("--provider <name> parses correctly", (() => {
    const opts = parseCliArgs(["--provider", "gemini", "hello"]);
    check("provider set to gemini", opts.provider === "gemini");
    check("question captured", opts.questionArgs.includes("hello"));
    return true;
})());

check("--provider=<name> parses correctly", (() => {
    const opts = parseCliArgs(["--provider=gemini", "hello"]);
    check("provider set to gemini", opts.provider === "gemini");
    return true;
})());

check("--provider without value throws", (() => {
    let threw = false;
    try {
        parseCliArgs(["--provider"]);
    } catch {
        threw = true;
    }
    check("throws for missing provider value", threw);
    return true;
})());

check("--dry-run --ai can both parse (validation is in main)", (() => {
    const opts = parseCliArgs(["--dry-run", "--ai"]);
    check("dryRun is true", opts.dryRun === true);
    check("configureAI is true", opts.configureAI === true);
    return true;
})());

check("no provider defaults to null", (() => {
    const opts = parseCliArgs(["hello"]);
    check("provider is null", opts.provider === null);
    check("question captured", opts.questionArgs.includes("hello"));
    check("dryRun is false", opts.dryRun === false);
    return true;
})());

check("--ai is in RESERVED_PROMPT_FLAGS", (() => {
    check("ai is reserved", RESERVED_PROMPT_FLAGS.has("ai"));
    check("ai-order is reserved", RESERVED_PROMPT_FLAGS.has("ai-order"));
    check("ai-reset is reserved", RESERVED_PROMPT_FLAGS.has("ai-reset"));
    check("provider is reserved", RESERVED_PROMPT_FLAGS.has("provider"));
    return true;
})());

check("--provider in OPTION_DEFINITIONS", (() => {
    const providerOpt = OPTION_DEFINITIONS.find((o) => o.flags.includes("--provider"));
    check("--provider defined", providerOpt !== undefined);
    return true;
})());

check("--print defaults to false", (() => {
    const opts = parseCliArgs(["hello"]);
    check("print is false", opts.print === false);
    check("outputExplicit is false", opts.outputExplicit === false);
    return true;
})());

check("--print parses correctly", (() => {
    const opts = parseCliArgs(["--print", "hello"]);
    check("print is true", opts.print === true);
    check("question captured", opts.questionArgs.includes("hello"));
    return true;
})());

check("--print with -o/--output throws", (() => {
    let threw = false;
    try {
        parseCliArgs(["--print", "-o", "out.md", "hi"]);
    } catch {
        threw = true;
    }
    check("throws for --print -o", threw);
    threw = false;
    try {
        parseCliArgs(["--print", "--output=x.md", "hi"]);
    } catch {
        threw = true;
    }
    check("throws for --print --output=", threw);
    return true;
})());

check("--print with --append/--prepend throws", (() => {
    let threw = false;
    try {
        parseCliArgs(["--print", "--append", "--output", "x.md", "hi"]);
    } catch {
        threw = true;
    }
    check("throws for --print --append", threw);
    threw = false;
    try {
        parseCliArgs(["--print", "--prepend", "--output", "x.md", "hi"]);
    } catch {
        threw = true;
    }
    check("throws for --print --prepend", threw);
    return true;
})());

check("--print with --dry-run allows -o (dry run writes nothing)", (() => {
    const opts = parseCliArgs(["--print", "--dry-run", "-o", "out.md", "hi"]);
    check("print is true", opts.print === true);
    check("dryRun is true", opts.dryRun === true);
    return true;
})());

check("--print is in RESERVED_PROMPT_FLAGS and OPTION_DEFINITIONS", (() => {
    check("print is reserved", RESERVED_PROMPT_FLAGS.has("print"));
    const printOpt = OPTION_DEFINITIONS.find((o) => o.flags.includes("--print"));
    check("--print defined", printOpt !== undefined);
    return true;
})());

restorePrefs();

console.log(`\n${total - failures.length}/${total} passed`);
if (failures.length) {
    console.log("FAILURES: " + failures.join(", "));
    process.exit(1);
}
console.log("ALL TESTS PASSED");
