I decoded the Base64 and looked through the actual index.js. My honest take: the code is technically fairly sophisticated, but I would not run it on a machine/browser profile containing anything sensitive without major changes.

What it is doing

At a high level, this is a Playwright-based ChatGPT browser automation CLI that:

launches Chromium/Chrome/Edge/Brave with persistent browser profiles

uses puppeteer-extra-plugin-stealth

optionally logs into ChatGPT interactively

detects/dismisses login and upload overlays

accepts a question from CLI arguments

supports @file arguments and reads those files

uploads files to ChatGPT using several fallback techniques

types the prompt into the ChatGPT UI

sends it

waits for the assistant response to stabilize

writes the answer to ./output.md

So the overall architecture is basically:

CLI → local files → browser automation → ChatGPT web UI → response → output.md

👍 Things I like

There is quite a bit of defensive engineering here.

1. Multiple attachment strategies

The fallback chain:

drag/drop → file chooser → <input type=file>

is a good idea. Browser automation around file uploads can be surprisingly fragile.

2. Persistent browser profiles

Using persistent contexts means the user can authenticate once and reuse the session later. That's convenient for a CLI tool.

3. Good handling of dynamic UI

Functions such as:

waitForChatGPTReady

dismissBlockingUI

waitForPromptInput

waitForAnswer

show that you aren't assuming the page is instantly ready.

The response-stability logic is also a reasonable attempt to distinguish a streaming response from a completed one.

4. Graceful fallbacks

I like the general philosophy of:

try primary method
    ↓
detect failure
    ↓
try alternative
    ↓
recover/reload if necessary

That's much better than a brittle 20-line Playwright script.

🚨 The biggest problem: arbitrary file reading

This is the part I'd fix before anything else.

You parse arguments beginning with @ as files:

JavaScript
if (token.startsWith("@") && token.length > 1) {
    fileRefs.push(stripShellQuotes(token.slice(1)));
}

Then:

JavaScript
const fullPath = path.resolve(ref);

if (!fs.existsSync(fullPath)) {
    throw new Error(...)
}

let content = fs.readFileSync(fullPath, "utf8");

There is no restriction on where that file can be located.

That means something like:

Bash
node index.js @../../some-sensitive-file

can potentially cause the program to read files outside the intended project directory.

And then the contents are deliberately inserted into the ChatGPT prompt:

JavaScript
Buffer.from(file.content, "utf8").toString("base64")

So the effective data flow can be:

arbitrary local file
        ↓
readFileSync()
        ↓
base64
        ↓
ChatGPT prompt
        ↓
remote service

That's a serious data-exfiltration risk if this tool is distributed to other people.

Even without a malicious user, someone could accidentally run:

Bash
node index.js @/home/user/Documents/private.txt

and send that file to ChatGPT.

I'd change this to a workspace restriction

For example, conceptually:

JavaScript
const workspace = path.resolve("./inputs");
const fullPath = path.resolve(workspace, ref);

if (!fullPath.startsWith(workspace + path.sep)) {
    throw new Error("File must be inside ./inputs");
}

And ideally also reject symlinks that escape the workspace.

🚨 --clear-session is surprisingly destructive

This part caught my attention:

JavaScript
const files = fs.readdirSync(localStoragePath)
    .filter(f => f.endsWith(".log") || f.endsWith(".ldb"));

for (const file of files) {
    fs.unlinkSync(path.join(localStoragePath, file));
}

That's effectively deleting browser Local Storage database files.

I'd be very reluctant to expose this as a casual CLI option.

At minimum:

make it explicitly opt-in

print exactly what is going to be deleted

don't silently swallow errors

preferably use the browser's own context/session mechanisms rather than manually deleting storage databases

⚠️ You're modifying the browser profile

This:

JavaScript
prefs.profile.exit_type = "Normal";
prefs.profile.exited_cleanly = true;

is another red flag from a software-maintenance perspective.

You're modifying Chromium's internal profile metadata to make the browser appear to have exited normally.

Combined with:

JavaScript
"--no-first-run",
"--no-default-browser-check",
"--disable-session-crashed-bubble",
"--hide-crash-restore-bubble"

it feels like the program is intentionally trying to make automation invisible to the browser.

That's not automatically malicious, but it makes the program much harder to trust and audit.

⚠️ stealth + persistent authenticated profile

This combination deserves extra caution:

JavaScript
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

and:

JavaScript
chromium.launchPersistentContext(...)

You're effectively automating a real authenticated user session while trying to make the automation less detectable.

From a security perspective, that means the browser profile becomes a credential-bearing asset.

If this code ever gets compromised, modified, or combined with another dependency that behaves badly, the consequences could be significant.

I'd keep the browser profile dedicated to this application rather than using someone's normal Chrome/Brave profile.

🐛 There's also a real bug in promptHasExpectedText

You have:

JavaScript
const typed = await page
    .locator(SELECTORS.promptInput)
    .first()
    .innerText()

For a <textarea>, innerText() is generally not the right way to retrieve its current value.

You probably want:

JavaScript
const typed = await page
    .locator(SELECTORS.promptInput)
    .first()
    .inputValue();

This matters because your verification can incorrectly conclude:

Prompt text did not stick, retyping...

even when it actually did.

That could explain unnecessary retries.

🐛 DECODE_NOTE is a little awkward

You're putting:

The file contents above are base64-encoded UTF-8. Decode each file before analyzing it.

into the prompt when files are attached.

That's workable, but you're making the model do an unnecessary encoding/decoding step.

If your goal is simply to provide file contents to the model, the better architecture is to use the browser's actual attachment mechanism whenever possible.

Your current fallback is essentially:

file
 ↓
UTF-8
 ↓
Base64
 ↓
keyboard text insertion
 ↓
ChatGPT
 ↓
model decodes it

That's quite expensive and fragile.

🐛 Your 150,000-character limit isn't really a safety limit

You have:

JavaScript
const MAX_FILE_CHARS = 150000;

which is good as a first guard.

But you're then Base64-encoding the content, which increases its size by roughly 33%.

So 150k characters becomes roughly 200k Base64 characters, before the surrounding prompt markup.

I'd impose limits based on bytes and/or total prompt size, not just individual UTF-8 character count.

Also consider:

maximum files
maximum combined size
maximum filename length
maximum total prompt size
🐛 Selector strategy is fragile

For example:

JavaScript
'[data-message-author-role="assistant"]'

is much better than relying on CSS classes, but this entire application is still tightly coupled to ChatGPT's current DOM.

That's unavoidable for this approach, but I'd isolate selectors into a dedicated adapter:

ChatGPTAdapter
  ├── findPrompt()
  ├── sendPrompt()
  ├── uploadFiles()
  ├── waitForResponse()
  └── dismissDialogs()

Then the rest of your application doesn't care about ChatGPT's DOM.

Right now the automation and business logic are heavily intertwined.

🟡 Another architectural concern: this is automating the website rather than using an API

If your actual goal is:

"Give ChatGPT a question + files and get the answer programmatically"

then I'd strongly consider whether browser automation is the right layer.

The current approach has to deal with:

login UI

modal dialogs

selectors

DOM changes

streaming responses

file upload UI

browser profiles

stealth plugins

authentication state

timing problems

That's a lot of moving parts.

An API-based architecture would be substantially cleaner if it fits your requirements.

Overall verdict

I'd score it roughly:

Area	My take
Engineering effort	⭐⭐⭐⭐⭐
Browser automation	⭐⭐⭐⭐
Error recovery	⭐⭐⭐⭐
Maintainability	⭐⭐⭐
Security	⭐⭐
Data handling	⭐⭐
Architecture	⭐⭐⭐
Production readiness	⭐⭐½

The code isn't "bad." In fact, there's a lot of thoughtful automation work in it.

But the biggest issue is that it combines local filesystem access + authenticated browser profile + automated uploading to ChatGPT without sufficiently strong boundaries around what can be read.

If this were my project, my priority order would be:

Lock down @file paths

Use a dedicated browser profile

Remove/rethink --clear-session

Fix innerText() → inputValue()

Put ChatGPT interaction behind an adapter

Add total file/prompt size limits

Add structured logging and error types

Consider an API implementation instead of DOM automation

Only then worry about optimizing the Playwright retry logic

The interesting thing is that the core automation idea is actually pretty solid. The security boundary around it is what I'd be most concerned about.
