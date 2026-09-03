# Plan: Preserve raw Markdown for Gemini responses

## Problem

When `askweb` extracts answers from ChatGPT, it clicks the response's **Copy** button and reads the clipboard, which preserves the original Markdown syntax (headings, bold, italics, lists, code blocks, links, etc.).

The Gemini provider does **not** do this. Its `waitForAnswer` in `providers/gemini/ui.js` falls back to `answer.innerText()`, which strips all Markdown formatting and returns only plain rendered text. There are no copy-button selectors defined for Gemini, so the Markdown-preserving extraction path is never attempted.

## Goal

Make the Gemini provider capture raw Markdown from responses the same way ChatGPT does: prefer the native copy-button/clipboard path, then fall back gracefully.

## Affected files

- `providers/gemini/ui.js` — add selectors + extraction helpers, update `waitForAnswer`
- `tests/gemini-markdown-copy.test.js` — new test for copy-button detection and Markdown extraction
- `README.md` — update the "Known Issues" and "Troubleshooting" sections

## Implementation

### 1. Add copy-button selectors to `providers/gemini/ui.js`

Add a `COPY_BUTTON_SELECTORS` array and expose it via `SELECTORS.copyButton`.

Use the same generic fallback already used by `index.js` (`button[aria-label*="copy" i]`), plus Gemini-specific candidates. Because the actual Gemini DOM is subject to change, the generic selector is the most important one; the others are defensive.

```js
const COPY_BUTTON_SELECTORS = [
    'button[aria-label="Copy"]',
    'button[aria-label*="Copy" i]',
    'button[aria-label*="copy" i]',
    '[data-testid*="copy" i]',
    'button svg[aria-hidden="true"]',   // icon-only copy button
];
```

### 2. Add extraction helpers to `providers/gemini/ui.js`

Add two functions modeled on the existing ChatGPT logic in `index.js`:

- `findCopyButton(page, answer)` — searches for a visible copy button near the answer element using a tiered selector strategy (answer → parent → page).
- `extractAnswerMarkdown(page, answer)` — clears the clipboard, clicks the copy button, reads `navigator.clipboard.readText()`, and returns the text. Returns `null` on any failure.

Keep the implementation self-contained in `providers/gemini/ui.js` so the Gemini provider does not depend on ChatGPT-specific code in `index.js`.

### 3. Update `waitForAnswer` in `providers/gemini/ui.js`

After the stabilization loop (currently line ~570), replace the final `return await answer.innerText()` with:

```js
let markdown = await extractAnswerMarkdown(page, answer);
if (markdown) {
    console.log(`>> Raw Markdown captured via copy button (${markdown.length} chars).`);
} else {
    console.log(">> Copy button unavailable, falling back to rendered text.");
    markdown = await answer.innerText();
    await page.evaluate((text) => navigator.clipboard.writeText(text), markdown).catch(() => {});
}
return markdown;
```

This mirrors the ChatGPT `waitForAnswer` behavior exactly, including the clipboard write on the fallback path.

### 4. Add tests (`tests/gemini-markdown-copy.test.js`)

Write headless Playwright tests that:

1. Render a fake Gemini response containing Markdown-ish content (`<model-response>` with `<div class="response-content">`).
2. Place a button with `aria-label="Copy"` next to the response.
3. Verify `findCopyButton` locates it.
4. Verify `extractAnswerMarkdown` clicks it and reads the clipboard.
5. Verify `waitForAnswer` returns the clipboard text when the button is present.
6. Verify `waitForAnswer` falls back to `innerText()` when no button is present.

Reuse the existing test patterns from `tests/gemini-send-confirm.test.js`.

### 5. Update `README.md`

- **Known Issues**: remove or reword the entry `Markdown extraction via innerText() may lose original formatting.` because the Gemini path will now prefer the copy button.
- **Troubleshooting**: update the "Answer contains no Markdown formatting" section to mention that the tool falls back to rendered text when the copy button is unavailable, and that this can now happen on either provider.

## Validation

Run the existing test suite to confirm no regressions:

```bash
npm test
```

Run the new Gemini Markdown copy test specifically:

```bash
node tests/gemini-markdown-copy.test.js
```

## Risks / Edge cases

- **Gemini DOM changes**: If Gemini renames or removes the copy button, the generic `aria-label*="copy"` selector should still catch most cases. If the button is entirely absent, the existing `innerText()` fallback preserves current behavior.
- **Clipboard permissions**: The main `index.js` already grants `clipboard-read` and `clipboard-write` permissions before running the provider. No new permission logic is needed.
- **Gemini-specific copy behavior**: If Gemini's copy button copies rendered text instead of raw Markdown (as the user reports for manual copying), the extraction will still return rendered text. In that case, a follow-up plan should investigate whether Gemini exposes raw Markdown in the DOM (e.g., `<script type="application/json">`, `data-markdown` attributes, or hidden inputs) and add a secondary extraction path.

## Open question

Should we also probe the DOM for raw Markdown as a secondary fallback (before `innerText()`) in case Gemini's copy button returns rendered text? If yes, the follow-up plan should inspect the live Gemini DOM to identify where the raw Markdown is stored and add a targeted extractor.
