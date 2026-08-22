Yes — I decoded the file, and the .md problem is not in your fs.writeFileSync() call. The main issue is that your code is treating the assistant response as raw innerText, which is not guaranteed to preserve the original Markdown source.

The problematic part

Your code currently does:

JavaScript
const answer = replies.nth(answerIndex);

...

return answer.innerText();

and later:

JavaScript
fs.writeFileSync(
    CLI.outputFile,
    answer.trim() + "\n",
    "utf8"
);

innerText() gives you the rendered text from the ChatGPT DOM, not necessarily the Markdown source that generated it.

For example, if ChatGPT renders:

Markdown
# Hello

This is **bold**.

```js
console.log("hello");

the DOM's `innerText()` can give you something closer to:

```text
Hello

This is bold.

console.log("hello");

So your output.md is a Markdown file extension, but the content you've extracted is already the rendered/plain text.

Fix: extract Markdown from the DOM's source/code representation

The exact DOM structure can change, so I would make your answer extraction try several approaches instead of relying only on innerText().

Replace your current waitForAnswer() with this:

JavaScript
async function waitForAnswer(page, assistantCountBefore = 0) {
    const replies = page.locator(SELECTORS.assistantMessage);

    await page.waitForFunction(
        ({ selector, countBefore }) =>
            document.querySelectorAll(selector).length > countBefore,
        {
            selector: SELECTORS.assistantMessage,
            countBefore: assistantCountBefore
        },
        { timeout: 60000 }
    );

    let stableCount = 0;
    let previousText = "";

    const answerIndex = assistantCountBefore;
    const answer = replies.nth(answerIndex);

    await answer.waitFor({
        state: "visible",
        timeout: 60000
    });

    while (stableCount < STABLE_POLLS_REQUIRED) {
        await page.waitForTimeout(POLL_MS);

        const count = await replies.count();

        const stopButton = page
            .locator(SELECTORS.stopButton)
            .first();

        const stopVisible = await stopButton
            .isVisible()
            .catch(() => false);

        let currentText = "";

        if (count > assistantCountBefore) {
            currentText = await extractAssistantMarkdown(answer);
        }

        const unchanged =
            count > assistantCountBefore &&
            currentText.trim().length > 0 &&
            currentText.trim().length === previousText.length &&
            !stopVisible;

        stableCount = unchanged ? stableCount + 1 : 0;
        previousText = currentText;
    }

    return extractAssistantMarkdown(answer);
}

Then add this helper:

JavaScript
async function extractAssistantMarkdown(locator) {
    return locator.evaluate((el) => {
        // 1. Prefer an actual Markdown/source attribute if the UI exposes one.
        const source =
            el.getAttribute("data-markdown") ||
            el.getAttribute("data-raw-content") ||
            el.getAttribute("data-content");

        if (source && source.trim()) {
            return source;
        }

        // 2. Look for code/pre blocks and reconstruct Markdown.
        const clone = el.cloneNode(true);

        for (const code of clone.querySelectorAll("pre code")) {
            const pre = code.parentElement;

            const languageClass =
                [...code.classList]
                    .find(c => c.startsWith("language-"));

            const language = languageClass
                ? languageClass.replace("language-", "")
                : "";

            const codeText = code.textContent || "";

            const replacement = document.createTextNode(
                "```" + language + "\n" +
                codeText.replace(/\n$/, "") +
                "\n```"
            );

            pre.replaceWith(replacement);
        }

        // 3. Convert common Markdown structures back to Markdown.
        for (const h of clone.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
            const level = Number(h.tagName.substring(1));
            h.replaceWith(
                document.createTextNode(
                    "#".repeat(level) + " " + h.textContent.trim() + "\n\n"
                )
            );
        }

        for (const strong of clone.querySelectorAll("strong")) {
            strong.replaceWith(
                document.createTextNode(
                    `**${strong.textContent}**`
                )
            );
        }

        for (const em of clone.querySelectorAll("em")) {
            em.replaceWith(
                document.createTextNode(
                    `*${em.textContent}*`
                )
            );
        }

        for (const link of clone.querySelectorAll("a")) {
            const text = link.textContent || "";
            const href = link.getAttribute("href") || "";

            link.replaceWith(
                document.createTextNode(
                    href ? `[${text}](${href})` : text
                )
            );
        }

        // 4. Preserve line breaks.
        for (const br of clone.querySelectorAll("br")) {
            br.replaceWith(document.createTextNode("\n"));
        }

        for (const p of clone.querySelectorAll("p")) {
            p.appendChild(document.createTextNode("\n\n"));
        }

        return (clone.innerText || clone.textContent || "")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    });
}
But there is an even more important point

Your current code has:

JavaScript
const expectedParts = [];

if (question.text)
    expectedParts.push(question.text.trim().slice(0, 60));

if (!attached && question.files.length > 0)
    expectedParts.push("</file>");

This only checks whether the response appeared. It doesn't validate that Markdown structure survived.

I'd change it to validate Markdown markers too:

JavaScript
async function promptHasExpectedText(page, expectedParts) {
    if (expectedParts.length === 0) return true;

    const typed = await promptInput(page)
        .evaluate(el =>
            ("value" in el ? el.value : el.innerText || el.textContent || "")
        )
        .catch(() => "");

    return expectedParts.every(part => typed.includes(part));
}

But for your actual .md output problem, the most important change is:

JavaScript
return answer.innerText();

⬇️

JavaScript
return extractAssistantMarkdown(answer);
One more thing: your Base64 file handling is unrelated

Your uploaded file itself is correctly being represented as:

<file name="index.js" encoding="base64">
...
</file>

and your prompt explicitly says:

The file contents above are base64-encoded UTF-8.
Decode each file before analyzing it.

That's fine.

The .md output issue happens after the answer is generated, here:

JavaScript
const answer = await waitForAnswer(...);

fs.writeFileSync(
    CLI.outputFile,
    answer.trim() + "\n",
    "utf8"
);

writeFileSync(..., "utf8") is already correct. Do not change it to Base64 or another encoding.

Also check this

Run:

Bash
node index.js --output test.md "give me a markdown response with headings, bold text, links and a javascript code block"

Then inspect test.md directly in a text editor.

If you want the exact Markdown source produced by the model, rather than reconstructing Markdown from rendered HTML, the best solution is to capture the underlying response data/API response instead of scraping innerText(). DOM-to-Markdown reconstruction can never perfectly recover things like original whitespace, Markdown syntax choices, escaping, or table formatting.

So the hierarchy is:

Best: underlying response source → exact Markdown
Second best: DOM HTML → convert HTML to Markdown
Current: DOM innerText() → plain/rendered text ❌

Your current implementation is doing the third one.
