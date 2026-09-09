# Testing askweb

Unit tests live in `tests/` and run with plain Node — no browser is launched.
Mocks stand in for Playwright pages (clipboard, DOM selectors, send/answer
flows), so the suite is fast and safe to run anywhere.

```bash
npm test
```

`npm test` runs every file in this order (see `package.json`):

| File | What it covers |
| --- | --- |
| `provider-registry.test.js` | Provider registration, lookup, and unknown-provider errors (`providers/index.js`). |
| `cli-args.test.js` | `parseCliArgs` — `--provider`, `--ai*` flags, reserved prompt names, `OPTION_DEFINITIONS` consistency. Parses args in-process; backs up and restores `.ai-prefs.json`. |
| `ai-preferences.test.js` | Load/save/ordering/reset of `.ai-prefs.json` (`loadAIPrefs`, `orderedAIProviders`, ...). |
| `popup-resilience.test.js` | Blocking-UI dismissal and prompt-readiness against mocked DOMs (both providers). |
| `gemini-anchor-fix.test.js` | `isUsableControl` / `isPromptReady` reject non-writable matches (e.g. `<a>` links) and require a real input; `typePrompt` smoke test. |
| `gemini-send-confirm.test.js` | Send acceptance (`waitForSendAccepted`: stop button, cleared composer, user-count) and `pressSendAndConfirm` retry/delayed-detection behavior. |
| `gemini-markdown-copy.test.js` | Copy-button scoping and clipboard extraction (`findCopyButton`, `extractAnswerMarkdown`, `waitForAnswer` copy path), including the code-block-button exclusion. |
| `chatgpt-finale-race.test.js` | Chunked-transmission finale race: `isFreshAssistantAnswer` must ignore a stale per-part ack and wait for the real finale answer. |
| `gemini-paste-finale.test.js` | Gemini contenteditable pasting (no `input.fill` hang), the 32,001-char composer cap, `isFreshAssistantAnswer` parity, and the no-generation watchdog message. |

Each file prints `PASS ...` lines and ends with `ALL TESTS PASSED`, or
`TEST ERROR:` plus a non-zero exit on failure. Single files can be run
directly:

```bash
node tests/cli-args.test.js
npm run test:popup   # tests/popup-resilience.test.js only
```

Notes:

- Tests that touch preferences (`cli-args`, `ai-preferences`) save and
  restore your real `.ai-prefs.json`; they never touch browser profiles,
  conversation history, or the network.
- Live browser behavior (login flows, real ChatGPT/Gemini pages) is not
  covered — verify those manually with `--dry-run` first, then a short
  `--print` run.
