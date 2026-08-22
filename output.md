Yes. Since you mean `prompt.md` as the instruction file for your AI IDE, I’d give it a precise implementation directive focused on the composer-state bug we identified. You can paste this directly into `prompt.md`:

# Fix ChatGPT Composer Input State Bug

## Objective

Fix the ChatGPT prompt-sending pipeline so that text entered into the composer is registered by ChatGPT's actual editor state, not merely inserted into the DOM.

The current implementation incorrectly assumes:

> DOM text == ChatGPT composer state

This is the primary bug to fix.

## Problem

The existing `pasteIntoComposer()` flow uses DOM-level manipulation such as:

```js
document.execCommand("insertText", false, text)
```

and/or direct selection/DOM manipulation for `contenteditable`.

This can make the prompt visibly appear in the composer while ChatGPT's React/ProseMirror editor state has not received the corresponding input transaction.

That creates false-positive verification:

```text
DOM contains prompt
        ↓
promptHasExpectedText() === true
        ↓
trySend()
        ↓
ChatGPT has incomplete/empty internal state
```

Symptoms include:

* Send button remaining disabled even though text is visible.
* Text disappearing after a rerender.
* Enter/click failing to send.
* Only part of a prompt being submitted.
* `promptHasExpectedText()` reporting success when the actual editor state is invalid.

## Required Fix

### 1. Stop using DOM injection as the primary input mechanism

Do not use:

```js
document.execCommand(...)
```

as the normal way to populate the ChatGPT composer.

Do not directly modify:

```js
innerText
textContent
innerHTML
```

to populate the composer.

Do not treat a DOM mutation as proof that ChatGPT accepted the input.

### 2. Use Playwright/user-level input

For the ChatGPT `contenteditable` composer, prefer real keyboard/input events.

The preferred approach should be equivalent to:

```js
await input.click();
await page.keyboard.insertText(text);
```

or another Playwright API that produces genuine browser input events.

If `fill()` is reliably supported by the current composer, it may be used:

```js
await input.fill(text);
```

But do not assume `fill()` works for every ProseMirror/contenteditable implementation. Detect the actual element type and use the appropriate user-level mechanism.

### 3. Preserve existing composer detection

Keep the existing `prepareComposerProbe(page)` / composer discovery logic if it is otherwise correct.

The implementation should continue supporting:

* `<textarea>`
* `<input>`
* `contenteditable`
* ProseMirror-style contenteditable editors

Do not replace working selectors unnecessarily.

### 4. Rewrite verification

The existing verification:

```js
const typed = await promptInput(page)
    .evaluate((el) =>
        ("value" in el ? el.value : el.innerText || el.textContent || "")
    );
```

is insufficient by itself.

Verification must establish that:

1. The expected text is present in the editor.
2. The editor has accepted real input.
3. The Send button is enabled/usable when appropriate.
4. The text survives a short asynchronous/rerender boundary.

For example, after entering the text:

```js
await expect.poll(async () => {
    return await readComposerText(page);
}).toBe(expectedText);
```

Then allow the page to process the input and verify again.

Do not declare the composer successfully populated solely because `innerText` matches.

### 5. Do not introduce arbitrary delays as the fix

Do NOT solve this with large:

```js
waitForTimeout(...)
```

calls.

Waiting may hide the race condition but does not fix the underlying state synchronization problem.

Use event-driven/polling verification instead.

### 6. Handle large prompts safely

If the existing implementation chunks large text, preserve that capability, but each chunk must be inserted through the browser's normal input path.

Do not use:

```js
execCommand("insertText", ...)
```

for chunk insertion.

If chunking is necessary, ensure that:

```text
chunk 1
  ↓
real input event
  ↓
editor state update
  ↓
chunk 2
  ↓
real input event
  ↓
editor state update
  ↓
...
```

Do not rapidly mutate the DOM and assume React/ProseMirror will reconstruct the intended state.

### 7. Verify the actual send operation

After the composer has been populated, `trySend()` should only send when the prompt has been accepted by the composer.

Prefer the actual Send button when it is available and enabled.

If keyboard Enter is used as a fallback, ensure focus is actually inside the composer and that the prompt was successfully registered first.

Do not blindly press Enter immediately after DOM insertion.

## Implementation Requirements

Inspect the existing code before changing it.

Specifically inspect:

* `pasteIntoComposer()`
* `prepareComposerProbe()`
* `promptInput()`
* `promptHasExpectedText()`
* `insertContenteditableChunk()`
* `trySend()`

Determine the current composer element and how the existing code handles:

* textarea/input
* contenteditable
* ProseMirror
* chunked insertion
* send-button detection
* prompt verification

Then make the smallest robust change that fixes the state synchronization problem.

## Desired Architecture

The flow should become:

```text
Find composer
    ↓
Focus composer
    ↓
Insert text using real browser/user-level input
    ↓
Wait for editor state/input processing
    ↓
Verify expected composer text
    ↓
Verify Send is usable
    ↓
Send
    ↓
Verify send actually occurred
```

The important invariant is:

> Never consider the prompt successfully entered merely because JavaScript can see the text in the DOM.

## Regression Protection

Add or update tests for the failure mode described above.

At minimum test:

1. Normal short prompt.
2. Long prompt.
3. Contenteditable composer.
4. Textarea/input composer if supported.
5. Prompt containing newlines.
6. Prompt containing special characters.
7. Composer rerender after input.
8. Send button becoming enabled after genuine input.
9. Failed input must not proceed to `trySend()`.
10. Existing successful flows must continue working.

A successful test should prove that the prompt remains present after the editor has processed the input and that the send operation uses the populated composer.

## Important Constraint

Do not "fix" this by adding more DOM manipulation.

The root issue is that DOM manipulation bypasses the editor's input/state pipeline.

The fix must make ChatGPT receive the prompt through the same browser input mechanisms that a real user typing/pasting into the composer would trigger.

## Final Deliverable

After implementing the fix:

* Show which files/functions were changed.
* Explain why the previous implementation could produce a false-positive prompt verification.
* Explain why the new input path updates the editor correctly.
* Report the tests run and their results.
* Do not make unrelated refactors.
