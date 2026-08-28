# askweb

Automate ChatGPT from the command line using a real Chromium-based browser with Playwright. Send questions, attach files, and save responses as Markdown.

askweb controls a persistent browser session, so the same browser profile and (optional) login are reused across runs. Logging in is **optional**: askweb runs anonymously by default and only needs a login for file uploads and very large payloads.

## Features

- CLI-driven ChatGPT automation with a persistent browser profile
- Question submission with retry logic and UI-state validation
- File attachment support: text/code files pasted inline, binary files uploaded (when logged in)
- Prompt presets as native flags (`--explain`, `--find-error`, ...), with a built-in and a custom (editable) set
- Append/prepend answer output to an existing file (`--append` / `--prepend`)
- Multiple browser fallback: Chrome, Brave, Edge (configurable order and default)
- Login/logout flow with session persistence across runs
- Works from any working directory: browser profiles, preferences, and history are anchored to the install location
- Visible progress while waiting for login instead of silent hangs
- Conversation history with `--continue [id]` and `--new`
- Large payloads delivered as numbered multi-part transmissions or a single attachment
- Browser preference persistence (`.browser-prefs.json`)
- Conversation history persistence (`.chatgpt-conversations.json`, max 50 entries)
- Graceful shutdown on SIGINT/SIGTERM

## Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Browser automation:** Playwright (`playwright-extra`)
- **Stealth:** `puppeteer-extra-plugin-stealth`
- **Config:** `dotenv`

## Installation

The easiest way to install askweb is from npm as a global CLI:

```bash
npm install -g rutkar
npx playwright install chromium   # one-time: install browser binaries
```

After installation, `askweb` is available from any directory:

```bash
askweb "What is JavaScript?"
```

### Update

```bash
npm update -g rutkar
```

### Uninstall

```bash
npm uninstall -g rutkar
```

### Development / Source Install

For development or local builds from source:

```bash
git clone https://github.com/omkar142web/askweb.git
cd askweb
npm install
npx playwright install chromium
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

`askweb` (global) and `node index.js` are interchangeable in all examples below. You can run either from any directory; only `-o <path>` and file arguments resolve relative to your current working directory.

```bash
# Ask a question
node index.js "What is JavaScript?"

# Ask with output to a specific file
node index.js -o result.md "Explain quantum computing"

# Attach a text/code file (pasted inline)
node index.js "Summarize this file" @notes.txt

# Attach multiple files
node index.js "Compare these files" file1.json file2.tsx

# Run a prompt preset
node index.js --explain "JavaScript closures"
node index.js --find-error src/index.js

# Continue the most recent conversation
node index.js --continue "Follow up question"

# Continue a specific conversation by id prefix
node index.js --continue a2cc6a02 "More on this"

# Start a fresh conversation
node index.js --new "New topic"

# Question text that starts with a dash
node index.js -- " -explain this flag"

# Login once (optional; session persists)
node index.js --login
```

## Usage

```text
askweb [options] [question] [files...]
node index.js [options] [question] [files...]
```

- `question` is optional (default: `"What is JavaScript?"`).
- `files...` is optional; zero or more files.
- `options` may appear before, between, or after the question and files.
- `--` stops option parsing: every token after it is treated literally.
- A bare token is attached as a file **only if it exists on disk**; `@path`
  always forces a file reference.

A new user can run `node index.js --help` for the full in-tool mini-manual.

## CLI Options

| Option | Argument | Description |
| --- | --- | --- |
| `askweb [options] [question] [files...]` | — | Ask ChatGPT a question, optionally attaching files. |
| `<question>` | — | Free-form question text (default: `"What is JavaScript?"`). |
| `<file>` / `@file` | path | Attach a file. A bare path is used only if it exists; `@path` always forces a file. |
| `-o`, `--output` | `<file>` | Save the answer to a file (default: `./output.md`). Also accepts `--output=<file>`. |
| `--append` | — | Append the answer to an existing output file. Requires `--output`. |
| `--prepend` | — | Prepend the answer to an existing output file. Requires `--output`. |
| `--login` | — | Open ChatGPT to log in and save the session. Standalone (ignores question/files/`--continue`/`--new`). |
| `--logout` | — | Open ChatGPT to log out manually; the session cookie is cleared. Standalone (up to 10 min). |
| `--continue` | `[id]` | Resume the most recent conversation, or a specific one by id prefix. |
| `--new` | — | Start a fresh conversation (the default). Cannot be used with `--continue`. |
| `--prompts` | — | Open the interactive Prompt Manager. |
| `--prompt-create` | `[name]` | Interactively create a prompt preset. |
| `--<preset>` | `[text]` | Run a preset as a native command (e.g. `--explain`, `--find-error`). |
| `--browser` | — | Choose the default browser interactively. |
| `--browser-order` | — | Reorder the browser fallback list interactively. |
| `--browser-reset` | — | Reset browser preferences to automatic (Chrome first). |
| `--clear-session` | — | Wipe local/session storage before launching (starts logged out). |
| `--clear-conversations` | — | Delete all saved conversation history. |
| `--clear-conversation` | `<id>` | Delete one saved conversation by id (prefix match). Also accepts `--clear-conversation=<id>`. |
| `-h`, `--help` | — | Show help. |
| `-v`, `--version` | — | Show the version. |
| `--` | — | Stop option parsing; tokens after it are the question/files literally. |

### Combinations to avoid

- `--continue` and `--new` cannot be used together.
- `--append` and `--prepend` cannot be used together (and each requires `--output`).
- Only one prompt preset may be used per run (`--explain --review` is rejected).
- `--output` and `--clear-conversation` each require their argument.
- `--continue=<id>` is not supported; use a space: `--continue <id>`.

## Prompt Presets

Presets are reusable prompts invoked like native flags. They accept files and
an optional question, just like a normal ask.

```bash
# Run a built-in that takes {{input}} (requires a word):
askweb --explain "JavaScript closures"

# Run a built-in with no {{input}} over files:
askweb --find-error src/index.js a.js b.js

# Run a preset and save the result:
askweb --review src/index.js -o review.md
```

- Words after the flag fill the template's `{{input}}` slot. A preset with
  `{{input}}` **requires** at least one word (otherwise the CLI errors with
  `Preset --<name> takes an argument`); a preset without `{{input}}` appends
  the words as "Extra focus".
- Preset names cannot collide with CLI flags (`--continue`, `--login`, ...), so
  those tokens always behave as options.

**Built-in presets**

| Preset | Uses `{{input}}` |
| --- | --- |
| `--find-error` | no |
| `--review` | no |
| `--refactor` | no |
| `--tests` | no |
| `--summarize` | no |
| `--explain` | yes |
| `--teach` | yes |
| `--generate` | yes |

**Custom presets** are stored in `.askweb-prompts.json` (in the install
directory). Manage them with the interactive managers:

```bash
node index.js --prompts          # add / edit / rename / delete / view
node index.js --prompt-create fix # interactively create "fix"
```

## File Attachments

### Text and Code Files

Files with these extensions are pasted inline into the prompt as fenced code
blocks:

`.css`, `.csv`, `.html`, `.js`, `.json`, `.jsx`, `.md`, `.py`, `.ts`, `.tsx`,
`.txt`, `.xml`, `.yaml`, `.yml`

Each file is truncated to 400,000 characters if larger. Text attachments are
wrapped in `<file name="..." lang="...">` blocks.

### Binary Files

Non-text files are **uploaded as attachments when logged in**, and inlined as
base64 inside `<file name="..." encoding="base64">` blocks (with an automatic
decode note) when logged out.

### Upload Methods

For binary uploads, the following strategies are tried in order:

1. `input[type="file"]` (inputs tried last-to-first)
2. File chooser button with menu fallback
3. Drag-and-drop on the composer (programmatic `DragEvent` dispatch)

### Large Payloads

- A single paste is capped at about 25 KB (25,000 chars). Anything larger is
  delivered as a **numbered multi-part transmission** that ChatGPT acknowledges
  part-by-part before answering.
- Logged-in users can also upload a large payload as a single attachment.
- Anonymous (logged-out) transmissions are capped at about ~293 KB (~6 parts).
  Beyond that, log in (`askweb --login`) or trim the input.
- Set `ASKWEB_CHUNK_SIZE=<chars>` to override the automatic part size.

## Conversation History

Conversation history is saved to `.chatgpt-conversations.json` in the askweb
install directory. Up to 50 conversations are retained.

Each entry stores:
- `id` (from the ChatGPT URL UUID, or generated)
- `url`
- `title`
- `updatedAt`
- `messages[]`

Use `--continue` to replay the most recent conversation's full transcript into a
fresh chat. Use `--continue <id>` (full id or a unique prefix) for a specific
one. Use `--new` to explicitly start a fresh conversation without history.
The `id` of each saved conversation is printed after a run so you can pass it
to `--continue <id>` later.

Manage history with:
- `--clear-conversations` — delete all saved conversations
- `--clear-conversation <id>` — delete one conversation by id (prefix match supported)

## Output

Answers are saved to `./output.md` by default. Use `-o` to change the path.

- `-o`, `--output <file>` — write the answer to `<file>` (overwrites by default).
- `--append` — append the answer after existing content.
- `--prepend` — prepend the answer before existing content.

`--append` and `--prepend` are mutually exclusive and both require `--output`.
The output path (`-o`) is resolved relative to your current working directory;
all other paths (browser profiles, history, preferences) live in the install
directory.

The answer is captured from the browser's copy button and read from the
clipboard when possible; otherwise it falls back to the rendered message text.
The browser context is granted `clipboard-read` and `clipboard-write`
permissions for reliable extraction.

## Login & Browser

askweb needs no account. It runs anonymously by default; the browser opens and
you can start asking right away. Logging in is only required for file uploads
and large payloads.

```bash
node index.js --login    # open the login page; session cookie is saved in the profile
node index.js --logout   # open ChatGPT and log out manually; cookie is cleared
```

The session cookie is saved in the browser profile and reused by later runs, so
you only log in once.

### Browser Selection

Persistent profiles are stored in the askweb install directory (resolved against
the install location, not your current working directory):

- `user-data-chrome` (Chrome)
- `user-data-brave` (Brave)
- `user-data-edge` (Edge)

Because profile paths are anchored to the install directory, your login session
is shared across every invocation regardless of where you run `askweb` from.

These directories contain cookies, `localStorage`, and session state and are
**not** tracked in version control. Profile directories are cleaned on exit by
setting `exit_type=Normal` and `exited_cleanly=true` in `Default/Preferences`.

askweb tries browsers in a saved order (Chrome first by default) and uses the
first one installed on this machine. Manage this interactively:

```bash
node index.js --browser        # choose the default browser
node index.js --browser-order  # reorder the fallback list
node index.js --browser-reset  # reset to automatic (Chrome first)
```

`--clear-session` wipes local/session storage for the next launch, so the
browser starts logged out/anonymous:

```bash
node index.js --clear-session "Who won the 2024 election?"
```

## Configuration

Preferences are stored in `.browser-prefs.json` in the askweb install directory:

```json
{
  "defaultBrowser": "chrome",
  "browserOrder": ["chrome", "edge", "brave"]
}
```

The configured preferred browser is tried first, followed by the saved order,
then any remaining defaults.

## Environment

| Variable | Description |
| --- | --- |
| `ASKWEB_CHUNK_SIZE` | Force the part size (in characters) used by the anonymous multi-part transmission path. Only used when a payload exceeds the single-message budget (~25 KB). |

```bash
# Windows
$env:ASKWEB_CHUNK_SIZE=40000; node index.js "long question"

# Unix
ASKWEB_CHUNK_SIZE=40000 node index.js "long question"
```

## Known Issues

- Brave's executable path is hardcoded for Windows in `index.js`:
  - `executablePath: ${process.env.LOCALAPPDATA}\BraveSoftware\Brave-Browser\Application\brave.exe`
  - On macOS/Linux, `LOCALAPPDATA` is undefined and Brave may be skipped silently.
- Markdown extraction via `innerText()` may lose original formatting.
- Some ChatGPT UI changes may require selector updates in `chatgpt-ui.js`.
- Maximum of 50 saved conversations in `.chatgpt-conversations.json`.
- Anonymous (logged-out) chats are capped at ~293 KB of transmitted content
  (~6 parts); larger payloads require a login.

## Troubleshooting

```bash
# No browser could be launched
#   - Install Chrome, Edge, or Brave
#   - Run: npx playwright install chromium

# Login page keeps reappearing
#   - Run: node index.js --clear-session --login

# Prompt input never appears
#   - Run: node index.js --login
#   - Log in manually within 10 minutes

# Waiting for login message keeps repeating
#   - The active browser profile has no ChatGPT session
#   - Log in inside the opened window, or run: node index.js --clear-session --login

# Answer contains no Markdown formatting
#   - The copy button may be unavailable
#   - Re-run; the tool falls back to rendered text

# Anonymous chat caps out / large prompt is refused
#   - Anonymous chats accept about 293 KB across ~6 parts
#   - Run: node index.js --login  and re-send (uploads as one attachment)

# Conversation history not saving
#   - Ensure the project directory is writable
#   - Check that .chatgpt-conversations.json is not locked by another process
```

## License

ISC
