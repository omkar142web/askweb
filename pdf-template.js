const fs = require("fs");
const path = require("path");

const HJS_LIGHT_CSS = fs.readFileSync(
    path.join(__dirname, "node_modules/highlight.js/styles/github.css"),
    "utf8",
);

const HJS_DARK_CSS = fs.readFileSync(
    path.join(__dirname, "node_modules/highlight.js/styles/github-dark.css"),
    "utf8",
);

const KATEX_FONTS_DIR = path
    .join(__dirname, "node_modules/katex/dist/fonts")
    .replace(/\\/g, "/");

const KATEX_CSS = fs.readFileSync(
    path.join(__dirname, "node_modules/katex/dist/katex.min.css"),
    "utf8",
)    .replace(/url\(["']?fonts\/([^"')\s]+)["']?\)/g, (_, fontPath) => `url("${KATEX_FONTS_DIR}/${fontPath}")`);

const DOCUMENT_CSS = `
:root {
    --max-width: 820px;
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: "SF Mono", "Cascadia Code", "Consolas", "Liberation Mono", monospace;
    --bg-page: #f6f8fa; --bg-content: #ffffff; --bg-code: #f6f8fa; --bg-code-block: #f6f8fa;
    --bg-code-header: #f0f2f5; --bg-table-stripe: #f8f9fb; --bg-blockquote: #f0f4ff;
    --text-primary: #1f2937; --text-secondary: #4b5563; --text-muted: #9ca3af;
    --text-heading: #0f172a; --text-link: #2563eb; --text-link-hover: #1d4ed8;
    --text-code: #d63384; --text-code-block: #1f2937;
    --text-success: #16a34a; --text-danger: #dc2626;
    --border-color: #e5e7eb; --border-focus: #2563eb;
    --radius: 8px; --transition: 0.2s ease;
    --bg-mark: #fef9c3;
    --bg-alert-note: #eef5fd; --bg-alert-tip: #eaf6ee;
    --bg-alert-important: #f6edfb; --bg-alert-warning: #fdf3e0;
    --bg-alert-caution: #fbebeb;
}
[data-theme="dark"] {
    --bg-page: #0d1117; --bg-content: #161b22; --bg-code: #1c2333; --bg-code-block: #1c2333;
    --bg-code-header: #1c2333; --bg-table-stripe: #1c2333; --bg-blockquote: #1c2333;
    --text-primary: #e6edf3; --text-secondary: #8b949e; --text-muted: #484f58;
    --text-heading: #f0f6fc; --text-link: #58a6ff; --text-link-hover: #79c0ff;
    --text-code: #f0888e; --text-code-block: #e6edf3;
    --text-success: #3fb950; --text-danger: #f85149;
    --border-color: #30363d; --border-focus: #58a6ff;
}
body {
    margin: 0; padding: 0; font-family: var(--font-sans); background: var(--bg-page);
    color: var(--text-primary); line-height: 1.7; -webkit-font-smoothing: antialiased;
}
    .content { max-width: 100%; padding: 48px 32px 96px; background: var(--bg-content); }
.content-inner { max-width: var(--max-width); margin: 0 auto; }
h1, h2, h3, h4, h5, h6 {
    color: var(--text-heading); font-weight: 700; line-height: 1.3;
    margin: 1.8em 0 0.5em; scroll-margin-top: 24px;
}
h1 { font-size: 2.2em; margin-top: 0; border-bottom: 1px solid var(--border-color); padding-bottom: 0.3em; }
h2 { font-size: 1.7em; border-bottom: 1px solid var(--border-color); padding-bottom: 0.25em; }
h3 { font-size: 1.35em; }
h4 { font-size: 1.15em; }
h5 { font-size: 1em; }
h6 { font-size: 0.9em; color: var(--text-secondary); }
p { margin: 0 0 1.2em; }
a { color: var(--text-link); text-decoration: none; border-bottom: 1px solid transparent; }
strong { font-weight: 700; color: var(--text-heading); }
em { font-style: italic; }
del { text-decoration: line-through; color: var(--text-secondary); }
blockquote {
    margin: 1.2em 0; padding: 12px 20px; background: var(--bg-blockquote);
    border-left: 4px solid var(--text-link); border-radius: 0 var(--radius) var(--radius) 0;
    color: var(--text-secondary);
}
blockquote p:last-child { margin-bottom: 0; }
ul, ol { margin: 0 0 1.2em; padding-left: 1.8em; }
ul ul, ol ol, ul ol, ol ul { margin-bottom: 0.4em; }
li { margin-bottom: 0.2em; }
li > p { margin-bottom: 0.2em; }
.task-list-item { list-style: none; display: flex; align-items: flex-start; gap: 8px; padding-left: 0; }
.task-list-item input[type="checkbox"] { margin-top: 4px; width: 16px; height: 16px; accent-color: var(--border-focus); flex-shrink: 0; }
ul .task-list-item { margin-left: -1.8em; }
hr { border: none; height: 1px; background: var(--border-color); margin: 2.4em 0; }
img { max-width: 100%; height: auto; border-radius: var(--radius); border: 1px solid var(--border-color); margin: 0.8em 0; }
img.broken { border-style: dashed; opacity: 0.7; min-height: 48px; padding: 16px; }
pre {
    margin: 1.2em 0; border-radius: var(--radius); background: var(--bg-code-block);
    border: 1px solid var(--border-color); overflow: hidden; position: relative;
}
pre code {
    display: block; padding: 16px 20px; font-family: var(--font-mono); font-size: 13.5px;
    line-height: 1.65; overflow-x: auto; white-space: pre; color: var(--text-code-block); tab-size: 2;
}
code:not(pre code) {
    font-family: var(--font-mono); font-size: 0.9em; padding: 0.2em 0.5em;
    background: var(--bg-code); border-radius: 4px; color: var(--text-code);
    border: 1px solid var(--border-color); white-space: nowrap;
}
    mark { background: var(--bg-mark); color: var(--text-primary); border-radius: 3px; padding: 0 2px; }
    [data-theme="dark"] mark { background: #423d1f; }
.md-front-matter {
    font-family: var(--font-mono); font-size: 12.5px; line-height: 1.6; color: var(--text-secondary);
    background: var(--bg-code); border: 1px dashed var(--border-color); border-radius: 8px;
    padding: 12px 16px; margin: 0 0 1.2em; white-space: pre-wrap; word-break: break-word;
}
.md-front-matter::before {
    display: block; font-family: var(--font-sans); font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);
    content: attr(data-type); margin-bottom: 6px;
}
blockquote.md-alert { border-left-width: 4px; border-radius: 8px; padding: 12px 16px; }
blockquote.md-alert::before {
    display: block; font-family: var(--font-sans); font-size: 12px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px;
    content: attr(data-alert);
}
blockquote.md-alert-note { background: var(--bg-alert-note); border-left-color: var(--text-link); }
blockquote.md-alert-tip { background: var(--bg-alert-tip); border-left-color: var(--text-success); }
blockquote.md-alert-important { background: var(--bg-alert-important); border-left-color: #8250df; }
blockquote.md-alert-warning { background: var(--bg-alert-warning); border-left-color: #d29922; }
    blockquote.md-alert-caution { background: var(--bg-alert-caution); border-left-color: var(--text-danger); }
    [data-theme="dark"] blockquote.md-alert-note { background: rgba(88, 166, 255, 0.08); }
    [data-theme="dark"] blockquote.md-alert-tip { background: rgba(63, 185, 80, 0.08); }
    [data-theme="dark"] blockquote.md-alert-important { background: rgba(130, 80, 223, 0.12); }
    [data-theme="dark"] blockquote.md-alert-warning { background: rgba(210, 153, 34, 0.1); }
    [data-theme="dark"] blockquote.md-alert-caution { background: rgba(248, 81, 73, 0.1); }
.footnotes { margin-top: 2.4em; padding-top: 1em; border-top: 1px solid var(--border-color); font-size: 13.5px; color: var(--text-secondary); }
.footnotes h2 { font-size: 1.1em; margin: 0 0 0.6em; border-bottom: none; }
.footnotes ol { margin: 0; padding-left: 1.5em; }
.footnotes li { margin-bottom: 0.4em; }
.footref { font-size: 0.75em; vertical-align: super; line-height: 0; color: var(--text-link); text-decoration: none; padding: 0 1px; }
.footref-back { color: var(--text-muted); text-decoration: none; }
.math-block { margin: 1.2em 0; text-align: center; overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
.math-block .katex-display { margin: 0; }
.math-marker { background: transparent; color: var(--text-secondary); font-family: var(--font-mono); }
.math-marker.math-display { display: inline-block; }
.mermaid-holder {
    margin: 1.2em 0; padding: 24px; background: var(--bg-content);
    border: 1px solid var(--border-color); border-radius: 8px; overflow-x: auto; text-align: center;
}
.mermaid-holder svg { max-width: 100%; height: auto; }
.mermaid-holder.mermaid-error { font-family: var(--font-mono); white-space: pre; text-align: left; }
th[align="center"], td[align="center"] { text-align: center; }
th[align="right"], td[align="right"] { text-align: right; }
li.task-done, .task-done { text-decoration: line-through; color: var(--text-muted); }
pre blockquote code:not(pre code) { background: var(--bg-code); }
.code-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 16px; background: var(--bg-code-header); border-bottom: 1px solid var(--border-color);
    font-size: 12px; font-weight: 600; color: var(--text-secondary); font-family: var(--font-sans);
}
.code-header .lang { text-transform: uppercase; letter-spacing: 0.3px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code-header .copy-btn { display: none; }
.table-wrapper { overflow-x: auto; margin: 1.2em 0; border-radius: var(--radius); border: 1px solid var(--border-color); }
table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 480px; }
table th { background: var(--bg-table-stripe); font-weight: 700; color: var(--text-heading); padding: 10px 14px; text-align: left; border-bottom: 2px solid var(--border-color); }
table td { padding: 9px 14px; border-bottom: 1px solid var(--border-color); }
table tr:last-child td { border-bottom: none; }
table tbody tr:nth-child(even) { background: var(--bg-table-stripe); }
    @media print {
        @page { margin: 0.75in; size: A4; }
        body { background: var(--bg-page) !important; }
        .content { padding: 48px 32px !important; }
        pre, blockquote, .table-wrapper, tr, img { break-inside: avoid; page-break-inside: avoid; }
        h1, h2, h3 { page-break-after: avoid; }
        h1, h2, h3, h4, h5, h6 { page-break-before: avoid; }
    }
`;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function buildHtmlDocument(contentHtml, options) {
    options = options || {};
    const theme = options.theme || "light";
    const title = options.title || "Document";
    const usesMath =
        options.usesMath ||
        contentHtml.indexOf("math-marker") !== -1 ||
        contentHtml.indexOf("katex") !== -1;
    const usesMermaid =
        options.usesMermaid || contentHtml.indexOf("mermaid-holder") !== -1;

    const hjsCss = theme === "dark" ? HJS_DARK_CSS : HJS_LIGHT_CSS;
    const katexCss = usesMath ? KATEX_CSS : "";
    const themeAttr = theme === "dark" ? ' data-theme="dark"' : "";

    return `<!DOCTYPE html>
<html lang="en"${themeAttr}>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>${DOCUMENT_CSS}${hjsCss}${katexCss}</style>
    ${usesMermaid ? `<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>` : ""}
    <script>
window.addEventListener('load', function() {
    document.querySelectorAll('img').forEach(function(img) {
        img.addEventListener('error', function() { img.classList.add('broken'); });
        if (img.complete && img.naturalWidth === 0) img.classList.add('broken');
    });
    ${usesMermaid ? mermaidInitScript(theme) : ""}
    window.__pdfReady = true;
});
window.addEventListener('error', function() { window.__pdfReady = true; }, { once: true });
</script>
</head>
<body>
    <main class="content">
        <div class="content-inner">
${contentHtml}
        </div>
    </main>
</body>
</html>`;
}

function mermaidInitScript(theme) {
    return `
if (window.mermaid) {
    var holders = document.querySelectorAll('.mermaid-holder');
    var pending = holders.length;
    if (pending === 0) { window.__mermaidDone = true; return; }
    mermaid.initialize({ startOnLoad: false, theme: '${theme === "dark" ? "dark" : "default"}', securityLevel: 'loose' });
    holders.forEach(function(el, i) {
        var graph = (el.dataset.graph || el.textContent).trim();
        if (!graph) { if (--pending === 0) window.__mermaidDone = true; return; }
        mermaid.render('mermaid-export-' + i, graph).then(function(res) {
            el.innerHTML = res.svg;
        }).catch(function() {
            el.classList.add('mermaid-error');
        }).finally(function() {
            if (--pending === 0) window.__mermaidDone = true;
        });
    });
} else {
    window.__mermaidDone = true;
}
`;
}

module.exports = {
    buildHtmlDocument,
    DOCUMENT_CSS,
    HJS_LIGHT_CSS,
    HJS_DARK_CSS,
    KATEX_CSS,
    escapeHtml,
};
