"use strict";

const { registerProvider, getProvider, providerById, providerLabel, getAllProviders } = (() => {
    require("../index.js");
    return require("../providers");
})();

let total = 0;
const failures = [];
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}
function checkThrows(name, fn, expectedSubstring) {
    total++;
    let error;
    try {
        fn();
    } catch (e) {
        error = e;
    }
    const cond = error && error.message.includes(expectedSubstring);
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : ` (got: ${error && error.message})`));
}

check("chatgpt resolves from registry", getProvider("chatgpt").id === "chatgpt");
check("chatgpt has correct name", getProvider("chatgpt").name === "ChatGPT");
check("chatgpt has navigate", typeof getProvider("chatgpt").navigate === "function");
check("chatgpt has startPopupMonitor", typeof getProvider("chatgpt").startPopupMonitor === "function");
check("chatgpt has sendQuestion", typeof getProvider("chatgpt").sendQuestion === "function");
check("chatgpt has waitForAnswer", typeof getProvider("chatgpt").waitForAnswer === "function");
check("chatgpt has getConversationId", typeof getProvider("chatgpt").getConversationId === "function");
check("chatgpt has getConversationTitle", typeof getProvider("chatgpt").getConversationTitle === "function");

check("gemini resolves from registry", getProvider("gemini").id === "gemini");
check("gemini has correct name", getProvider("gemini").name === "Gemini");
check("gemini has navigate", typeof getProvider("gemini").navigate === "function");
check("gemini has startPopupMonitor", typeof getProvider("gemini").startPopupMonitor === "function");
check("gemini has sendQuestion", typeof getProvider("gemini").sendQuestion === "function");
check("gemini has waitForAnswer", typeof getProvider("gemini").waitForAnswer === "function");
check("gemini has getConversationId", typeof getProvider("gemini").getConversationId === "function");
check("gemini has getConversationTitle", typeof getProvider("gemini").getConversationTitle === "function");

checkThrows("unknown provider fails with available list", () => getProvider("xyz"), "Available providers");

const all = getAllProviders();
check("getAllProviders has at least 2 providers", all.length >= 2);
check("getAllProviders includes chatgpt", all.map((p) => p.id).includes("chatgpt"));
check("getAllProviders includes gemini", all.map((p) => p.id).includes("gemini"));
check("chatgpt is first (default)", all[0].id === "chatgpt");

check("providerById returns provider", providerById("chatgpt").id === "chatgpt");
check("providerById unknown is undefined", providerById("nope") === undefined);

check("providerLabel for chatgpt", providerLabel(getProvider("chatgpt")) === "ChatGPT");
check("providerLabel for gemini", providerLabel(getProvider("gemini")) === "Gemini");

const before = getAllProviders().length;
registerProvider(getProvider("chatgpt"));
check("registerProvider is idempotent", getAllProviders().length === before);

checkThrows("registerProvider rejects missing id", () => registerProvider({ name: "x" }), "id");

checkThrows("registerProvider rejects null", () => registerProvider(null), "id");

console.log(`\n${total - failures.length}/${total} passed`);
if (failures.length) {
    console.log("FAILURES: " + failures.join(", "));
    process.exit(1);
}
console.log("ALL TESTS PASSED");
