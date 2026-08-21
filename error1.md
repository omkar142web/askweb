One major error is in attachViaDrop():

JavaScript
const b64 = fs.readFileSync(file.fullPath).toString("base64");
...
const binary = atob(b64);
const bytes = new Uint8Array(binary.length);
...
const file = new File([bytes], name, { type: mimeMap[ext] || "text/plain" });

Problem: ext is not normalized to lowercase before looking it up in mimeMap.

Earlier, extensions are normalized in shouldPasteFiles(), but here:

JavaScript
const ext = name.split(".").pop() || "";

So a file such as TEST.JS gets ext === "JS" and falls through to:

JavaScript
"text/plain"

That can cause the browser/ChatGPT upload pipeline to treat the attachment as plain text rather than JavaScript.

Fix:

JavaScript
const ext = (name.split(".").pop() || "").toLowerCase();

This is especially important because the code explicitly supports .js, .json, .py, .ts, etc., and the MIME mapping depends on the extension.
