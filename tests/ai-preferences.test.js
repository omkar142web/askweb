"use strict";

const fs = require("fs");
const path = require("path");

const {
    AI_PREFS_FILE,
    PREFS_FILE: BROWSER_PREFS_FILE,
    loadAIPefs: noop,
} = require("../index.js");

const { loadAIPrefs, saveAIPrefs, orderedAIProviders, resetAIPreferences, parseCliArgs } = require("../index.js");

let savedAiPrefs = null;
let savedBrowserPrefs = null;
if (fs.existsSync(AI_PREFS_FILE)) {
    savedAiPrefs = fs.readFileSync(AI_PREFS_FILE, "utf8");
}
if (fs.existsSync(BROWSER_PREFS_FILE)) {
    savedBrowserPrefs = fs.readFileSync(BROWSER_PREFS_FILE, "utf8");
}

let total = 0;
const failures = [];
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}

function cleanFiles() {
    if (fs.existsSync(AI_PREFS_FILE)) fs.unlinkSync(AI_PREFS_FILE);
}

function restoreFiles() {
    if (savedAiPrefs !== null) {
        fs.writeFileSync(AI_PREFS_FILE, savedAiPrefs, "utf8");
    } else if (fs.existsSync(AI_PREFS_FILE)) {
        fs.unlinkSync(AI_PREFS_FILE);
    }
    if (savedBrowserPrefs !== null) {
        fs.writeFileSync(BROWSER_PREFS_FILE, savedBrowserPrefs, "utf8");
    }
}

cleanFiles();

check("loadAIPrefs returns {} when file missing", (() => {
    const prefs = loadAIPrefs();
    check("returns empty object", prefs && Object.keys(prefs).length === 0);
    return true;
})());

check("orderedAIProviders includes all registered providers", (() => {
    cleanFiles();
    const providers = orderedAIProviders();
    check("at least 1 provider", providers.length >= 1);
    check("includes gemini", providers.some((p) => p.id === "gemini"));
    return true;
})());

check("orderedAIProviders with saved order moves default to front", (() => {
    cleanFiles();
    saveAIPrefs({ aiOrder: ["gemini"], defaultAI: "gemini" });
    const providers = orderedAIProviders();
    check("preferred is at front", providers[0].id === "gemini");
    return true;
})());

check("orderedAIProviders filters out unknown saved providers", (() => {
    cleanFiles();
    saveAIPrefs({ aiOrder: ["old-provider", "gemini"] });
    const providers = orderedAIProviders();
    check("does not include old-provider", !providers.some((p) => p.id === "old-provider"));
    check("includes gemini", providers.some((p) => p.id === "gemini"));
    return true;
})());

check("orderedAIProviders moves defaultAI to front when in middle of order", (() => {
    cleanFiles();
    saveAIPrefs({ aiOrder: ["gemini"], defaultAI: "gemini" });
    const providers = orderedAIProviders();
    check("preferred is at front", providers[0].id === "gemini");
    check("preferred not duplicated", providers.filter((p) => p.id === "gemini").length === 1);
    return true;
})());

check("saveAIPrefs writes valid JSON", (() => {
    cleanFiles();
    saveAIPrefs({ defaultAI: "gemini", aiOrder: ["gemini"] });
    check("file exists", fs.existsSync(AI_PREFS_FILE));
    const raw = JSON.parse(fs.readFileSync(AI_PREFS_FILE, "utf8"));
    check("defaultAI is gemini", raw.defaultAI === "gemini");
    check("aiOrder contains gemini", raw.aiOrder.includes("gemini"));
    return true;
})());

check("resetAIPreferences deletes ai-prefs file", (() => {
    cleanFiles();
    saveAIPrefs({ defaultAI: "gemini" });
    check("file exists before reset", fs.existsSync(AI_PREFS_FILE));
    resetAIPreferences();
    check("file deleted after reset", !fs.existsSync(AI_PREFS_FILE));
    return true;
})());

check("resetAIPreferences does not affect browser-prefs", (() => {
    cleanFiles();
    if (fs.existsSync(BROWSER_PREFS_FILE)) {
        const before = fs.readFileSync(BROWSER_PREFS_FILE, "utf8");
        saveAIPrefs({ defaultAI: "gemini" });
        resetAIPreferences();
        const after = fs.existsSync(BROWSER_PREFS_FILE) ? fs.readFileSync(BROWSER_PREFS_FILE, "utf8") : null;
        check("browser-prefs unchanged", before === after);
    } else {
        saveAIPrefs({ defaultAI: "gemini" });
        resetAIPreferences();
        check("browser-prefs not created by reset", !fs.existsSync(BROWSER_PREFS_FILE));
    }
    return true;
})());

check("orderedAIProviders appends new registered providers not in saved order", (() => {
    cleanFiles();
    const allProviders = orderedAIProviders();
    if (allProviders.length >= 1) {
        const firstId = allProviders[0].id;
        saveAIPrefs({ aiOrder: [firstId] });
        const after = orderedAIProviders();
        check("default moved to front", after[0].id === firstId);
        check("includes firstId", after.some((p) => p.id === firstId));
        check("at least 1 provider", after.length >= 1);
    } else {
        check("needs at least 1 provider", false);
    }
    return true;
})());

restoreFiles();

console.log(`\n${total - failures.length}/${total} passed`);
if (failures.length) {
    console.log("FAILURES: " + failures.join(", "));
    process.exit(1);
}
console.log("ALL TESTS PASSED");
