The **top error** is in `waitForAnswer()`:

```js
const answerIndex = assistantCountBefore;
const answer = replies.nth(answerIndex);
```

This assumes the new assistant message will always be at exactly `assistantCountBefore`. That can break if ChatGPT adds/updates assistant-message DOM nodes during generation, or if there are hidden/system-generated assistant elements. The result is that your script can wait on the wrong element and either hang or extract the wrong response.

Tell your AI IDE:

Fix the highest-priority bug in `index.js` inside `waitForAnswer()`.

### Problem

The code currently identifies the new assistant response using:

```js
const answerIndex = assistantCountBefore;
const answer = replies.nth(answerIndex);
```

This relies on the assistant-message DOM collection remaining perfectly stable while ChatGPT generates the response. That assumption is fragile and can cause the script to monitor or extract the wrong assistant message.

### Fix

Refactor `waitForAnswer()` so it identifies the specific newly-created assistant message robustly instead of permanently relying on `nth(assistantCountBefore)`.

After detecting that the assistant-message count has increased, select the newest newly-created assistant message and keep a reference to that locator. Then monitor that same message for stabilization and extract from it.

Preserve the existing behavior:

* Wait until a new assistant response appears.
* Wait until its text stops changing for `STABLE_POLLS_REQUIRED` polls.
* Ensure the stop button is no longer visible before considering it stable.
* Use the copy button to retrieve Markdown when available.
* Fall back to `innerText()` if copying fails.
* Do not change unrelated browser, login, upload, or prompt logic.

Also make sure the fix handles the case where multiple assistant messages already exist before sending the prompt.
