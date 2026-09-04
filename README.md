# askweb

Automate AI chat from the command line using a real Chromium-based browser with Playwright. Send questions, attach files, and save responses as Markdown.

askweb controls a persistent browser session, so the same browser profile and (optional) login are reused across runs. Logging in is **optional** for ChatGPT: askweb runs anonymously by default and only needs a login for file uploads and very large payloads. Gemini typically requires a Google login.

askweb supports multiple AI providers behind a common interface. ChatGPT is the default; Gemini is also available. Use `--provider <name>` for a one-off override, or `--ai` / `--ai-order` / `--ai-reset` to configure the default and fallback order (stored in `.ai-prefs.json`).

## Features

- CLI-driven AI chat automation with a persistent browser profile
- Multiple AI providers behind a common interface: ChatGPT (default) and Gemini (`--provider`, `--ai`, `--ai-order`, `--ai-reset`)
- Question submission with retry logic and UI-state validation
- File attachment support: text/code files pasted inline, binary files uploaded (when logged in)
- **Local commands** (`--cmd`) — run a shell command and pipe its output into the prompt sent to the AI
- **Dry runs** (`--dry-run`) — preview the exact prompt payload that would be sent, without launching a browser
- Prompt presets as native flags (`--explain`, `--find-error`, ...), with a built-in and a custom (editable) set
- Append/prepend answer output to an existing file (`--append` / `--prepend`)
- Multiple browser fallback: Chrome, Brave, Edge (configurable order and default)
- Login/logout flow with session persistence across runs
- Works from any working directory: browser profiles, preferences, and history are anchored to the install location
- Visible progress while waiting for login instead of silent hangs
- Conversation history with `--continue [id]` and `--new`
- Large payloads delivered as numbered multi-part transmissions or a single attachment
- Browser preference persistence (`.browser-prefs.json`)
- AI provider preference persistence (`.ai-prefs.json`)
- Conversation history persistence (`.chatgpt-conversations.json`, max 50 entries)
- Graceful shutdown on SIGINT/SIGTERM

## Tech Stack

- **Runtime:** Node.js (CommonJS)
- **Browser automation:** Playwright (`playwright-extra`)
- **Stealth:** `puppeteer-extra-plugin-stealth`
- **AI providers:** pluggable registry in `providers/` (`chatgpt`, `gemini`) with shared payload logic in `lib/payload.js`
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

# Run a local shell command and reason over its output
node index.js --cmd "git status" "Explain the current repository state."

# Preview the payload that would be sent (no browser launched)
node index.js --dry-run "Explain closures"

# Continue the most recent conversation
node index.js --continue "Follow up question"

# Continue a specific conversation by id prefix
node index.js --continue a2cc6a02 "More on this"

# Start a fresh conversation
node index.js --new "New topic"

# Use a specific AI provider for one run
node index.js --provider gemini "Explain React"

# Choose the default AI provider interactively
node index.js --ai

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
| `askweb [options] [question] [files...]` | — | Ask the selected AI a question, optionally attaching files. |
| `<question>` | — | Free-form question text (default: `"What is JavaScript?"`). |
| `<file>` / `@file` | path | Attach a file. A bare path is used only if it exists; `@path` always forces a file. |
| `-o`, `--output` | `<file>` | Save the answer to a file (default: `./output.md`). Also accepts `--output=<file>`. |
| `--append` | — | Append the answer to an existing output file. Requires `--output`. |
| `--prepend` | — | Prepend the answer to an existing output file. Requires `--output`. |
| `--login` | — | Open the selected AI site to log in and save the session. Standalone (ignores question/files/`--continue`/`--new`). |
| `--logout` | — | Open the selected AI site to log out manually; the session cookie is cleared. Standalone (up to 10 min). |
| `--continue` | `[id]` | Resume the most recent conversation, or a specific one by id prefix. |
| `--new` | — | Start a fresh conversation (the default). Cannot be used with `--continue`. |
| `--prompts` | — | Open the interactive Prompt Manager. |
| `--prompt-create` | `[name]` | Interactively create a prompt preset. |
| `--<preset>` | `[text]` | Run a preset as a native command (e.g. `--explain`, `--find-error`). |
| `--browser` | — | Choose the default browser interactively. |
| `--browser-order` | — | Reorder the browser fallback list interactively. |
| `--browser-reset` | — | Reset browser preferences to automatic (Chrome first). |
| `--provider` | `<name>` | Use a specific AI provider for this run only (e.g. `chatgpt`, `gemini`). Overrides the default from `--ai`. Also accepts `--provider=<name>`. |
| `--ai` | — | Choose the default AI provider interactively. |
| `--ai-order` | — | Reorder the AI provider fallback list interactively. |
| `--ai-reset` | — | Delete saved AI preferences and return to defaults (ChatGPT first). |
| `--clear-session` | — | Wipe local/session storage before launching (starts logged out). |
| `--clear-conversations` | — | Delete all saved conversation history. |
| `--clear-conversation` | `<id>` | Delete one saved conversation by id (prefix match). Also accepts `--clear-conversation=<id>`. |
| `-h`, `--help` | — | Show help. |
| `-v`, `--version` | — | Show the version. |
| `--dry-run` | — | Print the exact prompt payload that would be sent to the selected AI provider, then exit. No browser is launched and nothing is sent. |
| `--cmd` | `<command>` | Execute a local shell command and include its stdout/stderr in the prompt. Can be repeated. Each command runs with a 30s timeout, capped at `ASKWEB_MAX_CMD_OUTPUT` chars per stream. |
| `--` | — | Stop option parsing; tokens after it are the question/files literally. |

### Combinations to avoid

- `--continue` and `--new` cannot be used together.
- `--append` and `--prepend` cannot be used together (and each requires `--output`).
- Only one prompt preset may be used per run (`--explain --review` is rejected).
- `--output` and `--clear-conversation` each require their argument.
- `--continue=<id>` is not supported; use a space: `--continue <id>`.
- `--dry-run` cannot be combined with standalone actions (`--login`, `--logout`,
  `--browser`, `--browser-order`, `--browser-reset`, `--ai`, `--ai-order`,
  `--ai-reset`, `--prompts`, `--prompt-create`, `--clear-conversations`,
  `--clear-conversation`).

## Local Commands (`--cmd`)

`--cmd` runs a local shell command and folds its stdout/stderr into the prompt
sent to the AI as a `<command name="...">` block. Combine with a question to
ask about the command's output. The flag can be repeated for multiple commands.

```bash
node index.js --cmd "git status" "Explain the current repository state."
node index.js --cmd "git diff" --cmd "git status" "Review my changes."
node index.js --cmd "git log -5" "Summarize the recent changes."
```

- Each command runs with your user's permissions and a 30s timeout.
- Output is capped at `ASKWEB_MAX_CMD_OUTPUT` characters per stream (default
  `100000`, i.e. 100 KB). Set the variable to override.
- Obvious destructive patterns (`rm -rf /`, `mkfs`, etc.) are blocked.

## Dry Run (`--dry-run`)

`--dry-run` builds the prompt payload exactly as it would be sent (question,
attached/inlined files, command results, and any `<file>` blocks) and prints it
to stdout, then exits. No browser is launched and nothing is sent to the AI
provider. The header names the selected provider
(`--- DRY RUN: PROMPT THAT WOULD BE SENT TO <PROVIDER> ---`).
This is useful for inspecting how files and `--cmd` outputs are assembled
before committing tokens to a real run.

```bash
node index.js --dry-run "Review this" src/index.js
```

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
  delivered as a **numbered multi-part transmission** that the AI acknowledges
  part-by-part before answering.
- Logged-in users can also upload a large payload as a single attachment.
- Anonymous (logged-out) transmissions are capped at about ~293 KB (~6 parts).
  Beyond that, log in (`askweb --login`) or trim the input.
- Set `ASKWEB_CHUNK_SIZE=<chars>` to override the automatic part size.

## Conversation History

Conversation history is saved to `.chatgpt-conversations.json` in the askweb
install directory. Up to 50 conversations are retained.

Each entry stores:
- `id` (from the ChatGPT URL UUID, a Gemini URL token, or generated)
- `provider` (e.g. `"chatgpt"`, `"gemini"`; defaults to `"chatgpt"` for old entries)
- `url`
- `title`
- `updatedAt`
- `delivery` *(optional, present only when the payload was large)* —
  `mode`: `"chunked"` (anonymous multi-part) or `"attachment"` (uploaded as
  a single file), plus `parts`/`chars` (chunked) or `chars` (attachment)
- `messages[]`

Conversation ids are provider-agnostic: `--continue` replays the saved
transcript as plain text into a new chat with the currently selected provider,
so it works across providers and even when logged out. The selected provider
is never silently switched — if the saved conversation came from a different
provider you get a note (or a warning when `--provider` explicitly overrides
it) with a hint to pass `--provider <original>` to stay on the original one.

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

The answer is captured exclusively from the browser's copy button and read
from the clipboard, which preserves the original Markdown formatting. The
browser context is granted `clipboard-read` and `clipboard-write` permissions
for reliable extraction.

## Login & Browser

ChatGPT needs no account. It runs anonymously by default; the browser opens and
you can start asking right away. Logging in is only required for file uploads
and large payloads. Gemini typically requires a Google login — run
`askweb --login` (or `askweb --login --provider gemini`) and sign in inside the
opened window.

```bash
node index.js --login    # open the login page; session cookie is saved in the profile
node index.js --logout   # open the AI site and log out manually; cookie is cleared
```

`--login` / `--logout` act on the currently selected provider
(`--provider <name>` overrides for that run, otherwise the default from `--ai`).
The session cookie is saved in the browser profile and reused by later runs, so
you only log in once per provider.

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

## AI Providers

askweb supports multiple AI providers behind a common interface. ChatGPT is
the default; Gemini is also available.

```bash
node index.js --provider gemini "Explain React"  # one-off override for this run
node index.js --ai          # choose the default AI provider interactively
node index.js --ai-order    # reorder the AI provider fallback list
node index.js --ai-reset    # delete saved AI preferences (back to ChatGPT first)
```

When `--provider` is omitted, askweb uses the default from `--ai` (or ChatGPT
if no preference is saved). Unknown `--provider` names error out with the list
of available providers. `--provider` also accepts `--provider=<name>`.
`--continue` keeps your selected provider (see Conversation History) — pass
`--provider <original>` explicitly if you want to stay on the conversation's
original provider.

## Configuration

Browser preferences are stored in `.browser-prefs.json` in the askweb install directory:

```json
{
  "defaultBrowser": "chrome",
  "browserOrder": ["chrome", "edge", "brave"]
}
```

The configured preferred browser is tried first, followed by the saved order,
then any remaining defaults.

AI provider preferences are stored separately in `.ai-prefs.json` in the askweb
install directory:

```json
{
  "defaultAI": "chatgpt",
  "aiOrder": ["chatgpt", "gemini"]
}
```

The configured default AI is tried first, followed by the saved order, then any
remaining registered providers. Unknown names left in the file by removed
providers are silently ignored. Deleting the file (via `--ai-reset`) returns to
automatic selection (ChatGPT first). Browser (`.browser-prefs.json`) and AI
(`.ai-prefs.json`) preferences are fully independent.

## Environment

| Variable | Description |
| --- | --- |
| `ASKWEB_CHUNK_SIZE` | Force the part size (in characters) used by the anonymous multi-part transmission path. Only used when a payload exceeds the single-message budget (~25 KB). |
| `ASKWEB_MAX_CMD_OUTPUT` | Maximum characters to capture per command output stream (stdout or stderr) when using `--cmd`. Output beyond this is truncated with an explicit marker in the prompt. Default: `100000` (100 KB). |

```bash
# Windows
$env:ASKWEB_CHUNK_SIZE=40000; node index.js "long question"
$env:ASKWEB_MAX_CMD_OUTPUT=20000; node index.js --cmd "git log"

# Unix
ASKWEB_CHUNK_SIZE=40000 node index.js "long question"
ASKWEB_MAX_CMD_OUTPUT=20000 node index.js --cmd "git log"
```

## Known Issues

- Brave's executable path is hardcoded for Windows in `index.js`:
  - `executablePath: ${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
  - On macOS/Linux, `LOCALAPPDATA` is undefined and Brave may be skipped silently.
- If the provider's copy button is unavailable, the tool polls rapidly for up to 10 seconds before reporting an error. Re-run or refresh the page to retry.
- UI changes by the provider may require selector updates in `chatgpt-ui.js` (ChatGPT) or `providers/gemini/ui.js` (Gemini).
- Maximum of 50 saved conversations in `.chatgpt-conversations.json`.
- Anonymous (logged-out) chats are capped at ~293 KB of transmitted content
  (~6 parts); larger payloads require a login.
- Gemini typically requires a Google login; anonymous Gemini sessions may be
  refused or capped by Google. ChatGPT works anonymously.
- Unknown `--provider` names exit with an error listing the available providers
  (`chatgpt`, `gemini`).

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
#   - The active browser profile has no session for the selected provider
#   - Log in inside the opened window, or run: node index.js --clear-session --login

# Gemini prompt never becomes ready / asks to sign in
#   - Gemini typically requires a Google login
#   - Run: node index.js --login --provider gemini (or set it as default via --ai)

# Answer contains no Markdown formatting
#   - The copy button was not found within the polling window
#   - Re-run or refresh the browser page to retry

# Anonymous chat caps out / large prompt is refused
#   - Anonymous chats accept about 293 KB across ~6 parts
#   - Run: node index.js --login  and re-send (uploads as one attachment)

# Unknown provider
#   - Run: node index.js --provider xyz  -> lists available providers (chatgpt, gemini)
#   - Pick one with --provider <name>, or set the default with --ai

# Conversation history not saving
#   - Ensure the project directory is writable
#   - Check that .chatgpt-conversations.json is not locked by another process
```

## License

ISC
