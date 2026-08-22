# askweb

Automate ChatGPT from the command line using a real Chromium-based browser with Playwright. Send questions, attach files, and save responses as Markdown.

## Features

- CLI-driven ChatGPT automation with a persistent browser profile
- Question submission with retry logic and UI-state validation
- File attachment support: text/code files pasted inline, binary files uploaded
- Multiple browser fallback: Chrome, Brave, Edge (configurable order)
- Login flow with session persistence across runs
- Works from any working directory: browser profiles, preferences, and history are anchored to the install location
- Visible progress while waiting for login instead of silent hangs
- Conversation history with `--continue` and `--new` flags
- Output saved to Markdown by default
- Automatic dismissal of login prompts, popups, and blocking dialogs
- Browser preference persistence (`.browser-prefs.json`)
- Conversation history persistence (`.chatgpt-conversations.json`, max 20 entries)
- Graceful shutdown on SIGINT/SIGTERM

## Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Browser automation:** Playwright (`playwright-extra`)
- **Stealth:** `puppeteer-extra-plugin-stealth`
- **Config:** `dotenv`

## Installation

```bash
git clone <your-repo-url>
cd askweb
npm install
npx playwright install chromium
```

### Global CLI

`package.json` exposes a `bin` entry, so after installing you can also use:

```bash
npm install -g .
askweb "What is JavaScript?"
```

### npm Script Shortcuts

```bash
npm run ask   "What is JavaScript?"
npm run new   "New topic"
npm run cont  "Follow up question"
npm run forget <conversation-id>
npm run wipe
```

## Quick Start

`askweb` (global) and `node index.js` are interchangeable in all examples below. You can run either from any directory; only `-o <path>` resolves relative to your current working directory.

```bash
# Ask a question
node index.js "What is JavaScript?"

# Ask with output to a specific file
node index.js -o result.md "Explain quantum computing"

# Attach a text/code file (pasted inline)
node index.js "Summarize this file" @notes.txt

# Attach multiple files
node index.js "Compare these files" file1.json file2.tsx

# Continue the most recent conversation
node index.js --continue "Follow up question"

# Start a fresh conversation
node index.js --new "New topic"

# Question text that starts with a dash
node index.js -- " -explain this flag"
```

## CLI Options

| Option | Description |
|---|---|
| `node index.js [options] [question] [files...]` | Ask ChatGPT a question |
| `-o <path>` or `--output <path>` | Save answer to a file (default: `./output.md`) |
| `--login` | Open browser to log in and save session (up to 10 min) |
| `--continue` | Continue the most recent conversation |
| `--new` | Start a fresh conversation (default) |
| `--browser` | Set default browser interactively |
| `--browser-order` | Set browser fallback order |
| `--browser-reset` | Reset browser preferences to automatic |
| `--clear-session` | Wipe saved local storage before launching |
| `--clear-conversations` | Delete all saved conversation history |
| `--clear-conversation <id>` | Delete one saved conversation by id (prefix match supported) |
| `-h` or `--help` | Show help |
| `-v` or `--version` | Show version |
| `--` | Stop option parsing; everything after is the question. Use `--` before the question to treat leading dashes as literal text. |
| `<text>` | Question text |
| `@file` or existing file path | Attach a file |

**Note:** `--continue` and `--new` cannot be used together.

### Examples

```bash
# Interactive default browser selection
node index.js --browser

# Clear session and run
node index.js --clear-session "What is recursion?"

# Login flow only
node index.js --login

# Multi-part question with attachment
node index.js "Review this code for issues" @src/index.js

# Question text that starts with a dash
node index.js -- " -explain this flag"

# Pipe question from another command
echo "Write a hello world in Python" | xargs node index.js

# Delete all conversation history
node index.js --clear-conversations

# Delete a specific conversation by id prefix
node index.js --clear-conversation abc123
```

## File Attachments

### Text and Code Files

Files with these extensions are pasted inline into the prompt as fenced code blocks:

`.css`, `.csv`, `.html`, `.js`, `.json`, `.jsx`, `.md`, `.py`, `.ts`, `.tsx`, `.txt`, `.xml`, `.yaml`, `.yml`

Large files are truncated to 150,000 characters.

Text attachments are wrapped in `<file name="..." lang="...">` blocks with the file contents in a fenced code block.

### Binary Files

Non-text files are uploaded via the browser. Binary attachments are encoded as base64 in `<file name="..." encoding="base64">` blocks with an automatic decode note appended to the prompt.

### Upload Methods

For binary uploads, the following strategies are tried in order:

1. `input[type="file"]` (tries inputs from last to first)
2. File chooser button (`[data-testid="composer-plus-btn"]`) with menu fallback
3. Drag-and-drop on `#prompt-textarea` (programmatic `DragEvent` dispatch)

## Conversation History

Conversation history is saved to `.chatgpt-conversations.json` in the askweb install directory. Up to 20 conversations are retained.

Each entry stores:
- `id` (from URL UUID or generated)
- `url`
- `title`
- `updatedAt`
- `messages[]`

Use `--continue` to replay the most recent conversation's full transcript into a fresh chat. Use `--new` to explicitly start a fresh conversation without history.

Manage history with:
- `--clear-conversations` — delete all saved conversations
- `--clear-conversation <id>` — delete one conversation by id (prefix match supported)

## Output

Answers are saved to `./output.md` by default. Use `-o` to change the path.

The tool attempts to capture Markdown via the copy button (`[data-testid="copy-turn-action-button"]`) and reads it from the clipboard. If unavailable, it falls back to `button[aria-label*="copy" i]`, then to `answer.innerText()`.

The tool grants `clipboard-read` and `clipboard-write` permissions to the browser context for reliable extraction.

## Browser Profiles

Persistent profiles are stored in the askweb install directory (resolved against the install location, not your current working directory):

- `user-data-chrome` (Chrome)
- `user-data-brave` (Brave)
- `user-data-edge` (Edge)

Because profile paths are anchored to the install directory, your login session is shared across every invocation regardless of where you run `askweb` from.

These directories contain cookies, localStorage, and session state and are **not** tracked in version control.

Profile directories are cleaned on exit by setting `exit_type=Normal` and `exited_cleanly=true` in `Default/Preferences`.

## Configuration

Preferences are stored in `.browser-prefs.json` in the askweb install directory:

```json
{
  "defaultBrowser": "chrome",
  "browserOrder": ["chrome", "edge", "brave"]
}
```

Manage these via:

```bash
node index.js --browser
node index.js --browser-order
node index.js --browser-reset
```

The configured preferred browser is tried first, followed by the saved order, then any remaining defaults.

## Known Issues

- Brave executable path is hardcoded for Windows in `index.js`:
  - `executablePath: ${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
  - On macOS/Linux, `LOCALAPPDATA` is undefined and Brave may be skipped silently.
- Markdown extraction via `innerText()` may lose original formatting.
- Some ChatGPT UI changes may require selector updates in `index.js`.
- Maximum of 20 saved conversations in `.chatgpt-conversations.json`.

## Troubleshooting

```bash
# No browser could be launched
# - Install Chrome, Edge, or Brave
# - Run: npx playwright install chromium

# Login page keeps reappearing
# - Run: node index.js --clear-session --login

# Prompt input never appears
# - Run: node index.js --login
# - Log in manually within 10 minutes

# Waiting for login message keeps repeating
# - The active browser profile has no ChatGPT session
# - Log in inside the opened window, or run: node index.js --clear-session --login

# Answer contains no Markdown formatting
# - The copy button may be unavailable
# - Re-run; the tool falls back to rendered text

# Conversation history not saving
# - Ensure the project directory is writable
# - Check that .chatgpt-conversations.json is not locked by another process
```

## License

ISC
