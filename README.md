# scraping-chatgpt

Automate ChatGPT from the command line using a real Chromium-based browser with Playwright. Send questions, attach files, and save responses as Markdown.

## Features

- CLI-driven ChatGPT automation with a persistent browser profile
- Question submission with retry logic and UI-state validation
- File attachment support via drag-and-drop, file chooser, or file input fallbacks
- Multiple browser fallback: Chrome, Brave, Edge
- Login flow with session persistence across runs
- Output saved to Markdown by default
- Automatic dismissal of login prompts, popups, and blocking dialogs
- Browser preference persistence (`.browser-prefs.json`)

## Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Browser automation:** Playwright (`playwright-extra`)
- **Stealth:** `puppeteer-extra-plugin-stealth`
- **Config:** `dotenv`

## Prerequisites

- Node.js 16+
- A Chromium-based browser installed:
  - Google Chrome (channel: `chrome`)
  - Microsoft Edge (channel: `msedge`)
  - Brave Browser (executable path auto-detected on Windows)
- A ChatGPT account for logged-in usage

## Installation

```bash
git clone <your-repo-url>
cd scraping-chatgpt
npm install
npx playwright install chromium
```

## Quick Start

```bash
# Ask a question
node index.js "What is JavaScript?"

# Ask with output to a specific file
node index.js -o result.md "Explain quantum computing"

# Attach a file
node index.js "Summarize this file" @notes.txt

# Attach multiple files
node index.js "Compare these files" file1.json file2.tsx
```

## CLI Options

| Option | Description |
|---|---|
| `node index.js <question>` | Send a question to ChatGPT |
| `--login` | Open browser to log in and save session |
| `--clear-session` | Wipe saved local storage before launching |
| `--browser` | Set default browser interactively |
| `--browser-order` | Set browser fallback order |
| `--browser-reset` | Reset browser preferences |
| `-o <path>` or `--output <path>` | Save answer to a file |
| `--` | Stop option parsing; everything after is the question |
| `<text>` | Question text |
| `@file` or existing file path | Attach a file |
| `file.js`, `file.json`, etc. | Attach a file by path |

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

# Pipe question from another command
echo "Write a hello world in Python" | xargs node index.js
```

## File Attachments

Supported upload methods (tried in order):

1. `input[type="file"]`
2. File chooser button
3. Drag-and-drop

Files with these extensions are pasted as text instead of uploaded:

`.css`, `.csv`, `.html`, `.js`, `.json`, `.jsx`, `.md`, `.py`, `.ts`, `.tsx`, `.txt`, `.xml`, `.yaml`, `.yml`

Large files are truncated to 150,000 characters.

## Output

Answers are saved to `./output.md` by default. Use `-o` to change the path.

The tool attempts to capture Markdown via the copy button. If unavailable, it falls back to rendered text.

## Browser Profiles

Persistent profiles are stored in:

- `./user-data-chrome` (Chrome)
- `./user-data-brave` (Brave)
- `./user-data-edge` (Edge)

These directories contain cookies, localStorage, and session state and are **not** tracked in version control.

## Configuration

Preferences are stored in `.browser-prefs.json` at the project root:

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

## Known Issues

- Brave executable path is hardcoded for Windows in `index.js`:
  - `executablePath: ${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
  - On macOS/Linux, `LOCALAPPDATA` is undefined and Brave may be skipped.
- Markdown extraction via `innerText()` may lose original formatting. See `output.md` for discussion.
- Some ChatGPT UI changes may require selector updates in `index.js`.

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

# Answer contains no Markdown formatting
# - The copy button may be unavailable
# - Re-run; the tool falls back to rendered text
```

## License

ISC