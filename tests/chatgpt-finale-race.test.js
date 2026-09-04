"use strict";

// Regression test for the chunked-transmission finale race (ChatGPT path):
// after a large payload is sent in parts, a late per-part ack
// ("Got part 3/3...") can land after the pre-finale count snapshot, so a
// bare `count > baseline` check fires on the stale ack instead of waiting
// for the finale answer. waitForAnswer must require previously-unseen text.

const { isFreshAssistantAnswer } = require("../index.js");

let total = 0;
const failures = [];
function check(name, cond) {
    total++;
    if (!cond) failures.push(name);
    console.log((cond ? "PASS " : "FAIL ") + name);
}

// Exact scenario from the bug report: 3-part transmission, baseline taken
// after the parts, stale ack for part 3/3 lands before the finale answer.
const ACK_2 = "Got part 2/3.";
const ACK_3 = "Got part 3/3. I have the complete code now. What would you like me to do with it?";
const REAL_ANSWER = "Here is the review of index.js: ...";

check("already-present ack bubble at entry is NOT a fresh answer", (() => {
    // The reported failure: "Answer appeared after 0.0s (replies: 3)" - the
    // part-3 ack settled before the post-finale snapshot, so the baseline
    // already contains it. Polling sees the same bubble with the same text:
    // count did not grow past the baseline, so keep waiting for the finale.
    const baseline = { count: 3, text: ACK_3, previousText: ACK_3 };
    return isFreshAssistantAnswer({ count: 3, text: ACK_3 }, baseline) === false;
})());

check("late ack absorbed by post-finale snapshot is NOT fresh", (() => {
    // sendChunkedPayload re-baselines after the finale is accepted, so a
    // part-3 ack that landed late is part of the baseline itself. The finale
    // answer must arrive as a further, newer bubble.
    const baseline = { count: 3, text: ACK_3, previousText: ACK_2 };
    return (
        isFreshAssistantAnswer({ count: 3, text: ACK_3 }, baseline) === false &&
        isFreshAssistantAnswer({ count: 4, text: REAL_ANSWER }, baseline) === true
    );
})());

check("finale answer in a new bubble IS a fresh answer", (() => {
    const baseline = { count: 3, text: ACK_3, previousText: ACK_3 };
    return isFreshAssistantAnswer({ count: 4, text: REAL_ANSWER }, baseline) === true;
})());

check("same count is never fresh, even with different text", (() => {
    const baseline = { count: 3, text: ACK_3, previousText: ACK_3 };
    return isFreshAssistantAnswer({ count: 3, text: REAL_ANSWER }, baseline) === false;
})());

check("new bubble repeating the baseline text is not fresh", (() => {
    const baseline = { count: 2, text: ACK_2, previousText: ACK_2 };
    return isFreshAssistantAnswer({ count: 3, text: ACK_2 }, baseline) === false;
})());

check("new bubble repeating the entry text is not fresh", (() => {
    // Part-3 ack was already the last text when waitForAnswer started.
    const baseline = { count: 2, text: ACK_2, previousText: ACK_3 };
    return isFreshAssistantAnswer({ count: 3, text: ACK_3 }, baseline) === false;
})());

check("empty text is never fresh", (() => {
    const baseline = { count: 2, text: ACK_2, previousText: ACK_2 };
    return isFreshAssistantAnswer({ count: 3, text: "" }, baseline) === false;
})());

check("missing args are never fresh", (() => {
    const baseline = { count: 2, text: ACK_2, previousText: ACK_2 };
    return (
        isFreshAssistantAnswer(null, baseline) === false &&
        isFreshAssistantAnswer({ count: 3, text: REAL_ANSWER }, null) === false &&
        isFreshAssistantAnswer(undefined, undefined) === false
    );
})());

check("single-paste path unaffected (no baseline object needed)", (() => {
    // waitForAnswer without options.baseline keeps the old `grew` behavior;
    // the predicate simply is not consulted there. This asserts the export
    // exists and is a function so the wiring cannot silently break.
    return typeof isFreshAssistantAnswer === "function";
})());

console.log(`\n${total - failures.length}/${total} passed`);
if (failures.length) {
    console.log("FAILURES: " + failures.join(", "));
    process.exit(1);
}
console.log("ALL TESTS PASSED");
