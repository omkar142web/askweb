const { JSDOM } = require("jsdom");
const marked = require("marked");
const DOMPurify = require("dompurify");
const hljs = require("highlight.js");
const katex = require("katex");

const EMOJI = {
    rocket: "\u{1F680}",
    warning: "\u{26A0}\u{FE0F}",
    white_check_mark: "\u{2705}",
    x: "\u{274C}",
    bulb: "\u{1F4A1}",
    bug: "\u{1F41B}",
    fire: "\u{1F525}",
    tada: "\u{1F389}",
    sparkles: "\u{2728}",
    heart: "\u{2764}\u{FE0F}",
    bookmark: "\u{1F516}",
    key: "\u{1F511}",
    lock: "\u{1F512}",
    unlock: "\u{1F513}",
    eyes: "\u{1F440}",
    zap: "\u{26A1}",
    memo: "\u{1F4DD}",
    book: "\u{1F4D6}",
    page_facing_up: "\u{1F48C}",
    package: "\u{1F4E6}",
    pushpin: "\u{1F4CC}",
    hourglass: "\u{23F3}",
    alarm_clock: "\u{23F0}",
    thinking: "\u{1F914}",
    raised_hands: "\u{1F64C}",
    thumbsup: "\u{1F44D}",
    thumbsdown: "\u{1F44E}",
    clap: "\u{1F44F}",
    loudspeaker: "\u{1F4E2}",
    flag: "\u{1F6A9}",
    checkered_flag: "\u{1F3C1}",
    trophy: "\u{1F3C6}",
    medal: "\u{1F3C5}",
    star: "\u{2B50}",
    dizzy: "\u{1F4AB}",
    construction: "\u{1F6A7}",
    warning_sign: "\u{26A0}\u{FE0F}",
    question: "\u{2753}",
    exclamation: "\u{2755}",
    grey_question: "\u{2753}",
    grey_exclamation: "\u{2755}",
    chart_with_upwards_trend: "\u{1F4C8}",
    bar_chart: "\u{1F4CA}",
    scroll: "\u{1F4DC}",
    hammer: "\u{1F5E1}",
    wrench: "\u{1F527}",
    link: "\u{1F517}",
    paperclip: "\u{1F4CE}",
    scissors: "\u{2702}\u{FE0F}",
    telephone: "\u{260E}\u{FE0F}",
    email: "\u{2709}\u{FE0F}",
    mailbox: "\u{1F4EB}",
    hourglass_flowing_sand: "\u{23CF}",
    stopwatch: "\u{23F1}\u{FE0F}",
    calendar: "\u{1F4C5}",
    clock3: "\u{1F552}",
    soon: "\u{1F529}",
    interrobang: "\u{203D}",
    heavy_check_mark: "\u{2714}\u{FE0F}",
    heavy_multiplication_x: "\u{2716}\u{FE0F}",
    arrow_right: "\u{2192}",
    arrow_left: "\u{2190}",
    arrow_up: "\u{2191}",
    arrow_down: "\u{2193}",
    arrow_backward: "\u{2190}",
    arrow_forward: "\u{2192}",
};

const LANGUAGE_LABELS = {
    javascript: "JavaScript", js: "JavaScript",
    typescript: "TypeScript", ts: "TypeScript",
    html: "HTML", css: "CSS",
    bash: "Bash", shell: "Shell", sh: "Shell",
    python: "Python", py: "Python",
    json: "JSON", markdown: "Markdown", md: "Markdown",
};

const ALERT_TYPES = {
    NOTE: "note", TIP: "tip", IMPORTANT: "important",
    WARNING: "warning", CAUTION: "caution",
};

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatLanguage(lang) {
    return LANGUAGE_LABELS[lang.toLowerCase()] || lang;
}

function extractFrontMatter(text) {
    const yaml = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
    if (yaml) {
        return {
            html:
                '<div class="md-front-matter" data-type="YAML front matter">' +
                escapeHtml(yaml[1].trim()) +
                "</div>",
            rest: text.slice(yaml[0].length),
        };
    }
    const toml = /^\+\+\+\r?\n([\s\S]*?)\r?\n\+\+\+\s*(?:\r?\n|$)/.exec(text);
    if (toml) {
        return {
            html:
                '<div class="md-front-matter" data-type="TOML front matter">' +
                escapeHtml(toml[1].trim()) +
                "</div>",
            rest: text.slice(toml[0].length),
        };
    }
    const json = /^(\{[\s\S]*?\})\s*(?:\r?\n|$)/.exec(text);
    if (json) {
        try {
            JSON.parse(json[1]);
            return {
                html:
                    '<div class="md-front-matter" data-type="JSON front matter">' +
                    escapeHtml(json[1]) +
                    "</div>",
                rest: text.slice(json[0].length),
            };
        } catch (e) {}
    }
    return { html: "", rest: text };
}

function extractMath(text, mathLatex) {
    const protectedChunks = [];
    let idx = 0;
    text = text.replace(
        /```[\s\S]*?```|`[^`\n]*`/g,
        function (m) {
            protectedChunks.push(m);
            return "\u0001MD" + idx++ + "\u0001";
        },
    );
    text = text.replace(
        /(?<!\\)\$\$([\s\S]+?)\$\$/g,
        function (m, inner) {
            const n = mathLatex.length;
            mathLatex.push({ latex: inner.trim(), display: true });
            return "⟦math:" + n + "⟧";
        },
    );
    text = text.replace(
        /(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\$)/g,
        function (m, inner) {
            const n = mathLatex.length;
            mathLatex.push({ latex: inner, display: false });
            return "⟦math:" + n + "⟧";
        },
    );
    text = text.replace(/\u0001MD(\d+)\u0001/g, function (m, i) {
        return protectedChunks[Number(i)];
    });
    return text;
}

const markExtension = {
    name: "mark",
    level: "inline",
    start: function (src) {
        return src.indexOf("==");
    },
    tokenizer: function (src) {
        const rule = /^==([^=\n]+?)(?<! )==(?!=)/;
        const match = rule.exec(src);
        if (match) {
            return {
                type: "mark",
                raw: match[0],
                text: match[1],
            };
        }
    },
    renderer: function (token) {
        return "<mark>" + token.text + "</mark>";
    },
};

marked.use({ extensions: [markExtension] });

function parseMarkdown(text) {
    const mathLatex = [];
    const fm = extractFrontMatter(text);
    const mathText = extractMath(fm.rest, mathLatex);

    let rawHtml;
    try {
        marked.setOptions({
            gfm: true,
            breaks: true,
            pedantic: false,
        });
        rawHtml = marked.parse(mathText);
    } catch (err) {
        console.error("Parse error:", err);
        throw new Error("Failed to parse Markdown: " + err.message);
    }

    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    const wnd = dom.window;
    const doc = wnd.document;
    const purify = DOMPurify(wnd);

    const withFm = fm.html + rawHtml;
    const sanitized = purify.sanitize(withFm, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["target"],
        ADD_TAGS: ["input"],
        ADD_DATA_URI_TAGS: ["img"],
    });

    const container = doc.createElement("div");
    container.innerHTML = sanitized;

    return { container, wnd, doc, mathLatex };
}

function postProcessAlerts(container) {
    container.querySelectorAll("blockquote").forEach(function (bq) {
        const firstP = bq.querySelector(":scope > p");
        if (!firstP) return;
        const m = /^\s*\[!([A-Z]+)\]\s*/.exec(firstP.textContent);
        if (m && ALERT_TYPES[m[1]]) {
            const type = ALERT_TYPES[m[1]];
            bq.classList.add("md-alert", "md-alert-" + type);
            bq.setAttribute("data-alert", m[1].toLowerCase());
            firstP.textContent = firstP.textContent
                .slice(m[0].length)
                .replace(/^\s*/, "");
        }
    });
}

function postProcessFootnotes(container, wnd, doc) {
    const defs = new Map();
    const defPattern = /^\[\^([^\]]+)\]:\s?([\s\S]*)$/;

    Array.prototype.slice.call(container.children).forEach(function (el) {
        if (el.tagName !== "P") return;
        const m = defPattern.exec(el.textContent);
        if (m && m[2].trim()) {
            defs.set(m[1], m[2]);
            el.remove();
        }
    });

    if (defs.size === 0) return;

    const counter = {};
    const walker = doc.createTreeWalker(
        container,
        wnd.NodeFilter.SHOW_TEXT,
        {
            acceptNode: function (node) {
                const parent = node.parentElement;
                if (parent && parent.closest("pre, code, .math-marker, sup.footref"))
                    return wnd.NodeFilter.FILTER_REJECT;
                return /\[\^[^\]\n]+\]/.test(node.nodeValue)
                    ? wnd.NodeFilter.FILTER_ACCEPT
                    : wnd.NodeFilter.FILTER_REJECT;
            },
        },
    );
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach(function (node) {
        const parts = node.nodeValue.split(/(\[\^[^\]\n]+\])/);
        if (parts.length === 1) return;
        const fragment = doc.createDocumentFragment();
        parts.forEach(function (part) {
            const ref = /^\[\^([^\]\n]+)\]$/.exec(part);
            if (ref && defs.has(ref[1])) {
                counter[ref[1]] = (counter[ref[1]] || 0) + 1;
                const id = "fn-" + ref[1] + "-" + counter[ref[1]];
                const sup = doc.createElement("a");
                sup.className = "footref";
                sup.href = "#fn-def-" + ref[1];
                sup.dataset.fn = ref[1];
                sup.title = defs.get(ref[1]);
                sup.textContent = counter[ref[1]];
                fragment.appendChild(sup);
            } else {
                fragment.appendChild(doc.createTextNode(part));
            }
        });
        node.parentNode.replaceChild(fragment, node);
    });

    const section = doc.createElement("div");
    section.className = "footnotes";
    const title = doc.createElement("h2");
    title.textContent = "Footnotes";
    section.appendChild(title);
    const list = doc.createElement("ol");

    function renderInlineMd(text) {
        let s = String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
        s = s
            .replace(/`([^`\n]+)`/g, function (m, c) {
                return "<code>" + c + "</code>";
            })
            .replace(/\*\*([^*\n]+)\*\*/g, function (m, c) {
                return "<strong>" + c + "</strong>";
            })
            .replace(/\*([^*\n]+)\*/g, function (m, c) {
                return "<em>" + c + "</em>";
            })
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
                return '<a href="' + u + '">' + t + "</a>";
            });
        return s;
    }

    Array.from(defs.entries()).forEach(function (entry) {
        const id = entry[0];
        const text = entry[1];
        const li = doc.createElement("li");
        const anchor = doc.createElement("a");
        anchor.href = "#fn-" + id + "-1";
        anchor.id = "fn-def-" + id;
        li.appendChild(anchor);
        const body = doc.createElement("span");
        body.innerHTML = renderInlineMd(text);
        li.appendChild(body);
        const back = doc.createElement("a");
        back.className = "footref-back";
        back.href = "#fn-" + id + "-1";
        back.textContent = " \u21a9";
        li.appendChild(back);
        list.appendChild(li);
    });
    section.appendChild(list);
    container.appendChild(section);
}

function applyAttributeLists(container) {
    container
        .querySelectorAll("h1, h2, h3, h4, h5, h6")
        .forEach(function (h) {
            const m = h.textContent.match(/(\s*)\{#([^}]+)\}\s*$/);
            if (m) {
                h.id = m[2].trim();
                const keep = h.textContent.slice(0, h.textContent.length - m[0].length);
                h.textContent = keep.trimEnd();
            }
        });
}

function replaceMathPlaceholders(container, mathLatex, wnd, doc) {
    const markerRe = /⟦math:(\d+)⟧/g;
    const walker = doc.createTreeWalker(
        container,
        wnd.NodeFilter.SHOW_TEXT,
        {
            acceptNode: function (node) {
                markerRe.lastIndex = 0;
                return markerRe.test(node.nodeValue)
                    ? wnd.NodeFilter.FILTER_ACCEPT
                    : wnd.NodeFilter.FILTER_REJECT;
            },
        },
    );
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach(function (node) {
        const parts = node.nodeValue.split(/⟦math:(\d+)⟧/);
        const hasMarker = parts.length > 1;
        if (!hasMarker) return;
        const fragment = doc.createDocumentFragment();
        let hasDisplay = false;
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) {
                const info = mathLatex[Number(parts[i])];
                if (info && info.display) hasDisplay = true;
                const span = doc.createElement("span");
                span.className =
                    "math-marker" +
                    (info && info.display ? " math-display" : "");
                if (info) {
                    span.dataset.latex = info.latex;
                    span.dataset.math = parts[i];
                    try {
                        span.innerHTML = katex.renderToString(info.latex, {
                            displayMode: !!info.display,
                            throwOnError: false,
                            trust: false,
                        });
                    } catch (e) {
                        span.textContent = info.latex;
                    }
                } else {
                    span.textContent = "⟦math:" + parts[i] + "⟧";
                }
                fragment.appendChild(span);
            } else if (parts[i]) {
                fragment.appendChild(doc.createTextNode(parts[i]));
            }
        }
        const parent = node.parentNode;
        const next = node.nextSibling;
        parent.removeChild(node);
        parent.insertBefore(fragment, next);
        if (
            hasDisplay &&
            parent.tagName === "P" &&
            parent.childNodes.length === 1 &&
            parent.firstChild.classList &&
            parent.firstChild.classList.contains("math-display")
        ) {
            const div = doc.createElement("div");
            div.className = "math-block";
            while (parent.firstChild) div.appendChild(parent.firstChild);
            parent.parentNode.replaceChild(div, parent);
        }
    });
}

function replaceEmojiShortcodes(container, wnd, doc) {
    const walker = doc.createTreeWalker(
        container,
        wnd.NodeFilter.SHOW_TEXT,
        {
            acceptNode: function (node) {
                const parent = node.parentElement;
                if (
                    parent &&
                    parent.closest("pre, code, .math-marker, .kbd, .mermaid-holder")
                )
                    return wnd.NodeFilter.FILTER_REJECT;
                return /:[A-Za-z0-9_+]+:/.test(node.nodeValue)
                    ? wnd.NodeFilter.FILTER_ACCEPT
                    : wnd.NodeFilter.FILTER_REJECT;
            },
        },
    );
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach(function (node) {
        const replaced = node.nodeValue.replace(
            /:([A-Za-z0-9_+]+):/g,
            function (m, key) {
                return EMOJI[key] || m;
            },
        );
        if (replaced !== node.nodeValue) {
            node.nodeValue = replaced;
        }
    });
}

function highlightAndWrapCode(container, doc) {
    container.querySelectorAll("pre code").forEach(function (block) {
        if (block.classList.contains("language-mermaid")) {
            const pre = block.parentElement;
            if (!pre) return;
            const holder = doc.createElement("div");
            holder.className = "mermaid-holder";
            holder.setAttribute("role", "img");
            const graph = block.textContent;
            holder.dataset.graph = graph;
            block.replaceChildren();
            pre.replaceWith(holder);
            return;
        }

        let lang = "";
        Array.prototype.forEach.call(block.classList, function (cls) {
            if (cls.indexOf("language-") === 0) {
                lang = cls.slice("language-".length);
            }
        });

        const code = block.textContent;
        let highlighted;
        try {
            if (lang && hljs.getLanguage(lang)) {
                highlighted = hljs.highlight(code, { language: lang }).value;
            } else {
                highlighted = hljs.highlightAuto(code).value;
            }
        } catch (e) {
            highlighted = escapeHtml(code);
        }
        block.innerHTML = highlighted;
        block.classList.add("hljs");

        const pre = block.parentElement;
        if (!pre) return;
        if (!pre.id) {
            pre.id =
                "code-" +
                Date.now().toString(36) +
                "-" +
                Math.random().toString(36).slice(2, 6);
        }

        const header = doc.createElement("div");
        header.className = "code-header";

        const langEl = doc.createElement("span");
        langEl.className = "lang";
        langEl.textContent = lang ? formatLanguage(lang) : "Plain text";

        const copyBtn = doc.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.textContent = "Copy";
        copyBtn.setAttribute("aria-label", "Copy code");
        copyBtn.dataset.copyTarget = pre.id;

        header.append(langEl, copyBtn);
        pre.parentElement.insertBefore(header, pre);
    });
}

function wrapTables(container, doc) {
    container.querySelectorAll("table").forEach(function (table) {
        if (!table.parentElement.classList.contains("table-wrapper")) {
            const wrapper = doc.createElement("div");
            wrapper.className = "table-wrapper";
            table.parentElement.replaceChild(wrapper, table);
            wrapper.appendChild(table);
        }
    });
}

function setupTaskLists(container) {
    container
        .querySelectorAll('input[type="checkbox"]')
        .forEach(function (cb) {
            const li = cb.closest("li");
            if (li) li.classList.add("task-list-item");
            cb.disabled = true;
            if (cb.checked) {
                li && li.classList.add("task-done");
            }
        });
}

function handleExternalLinks(container) {
    container.querySelectorAll('a[href^="http"]').forEach(function (a) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
    });
}

function renderMarkdown(text) {
    const { container, wnd, doc, mathLatex } = parseMarkdown(text);

    handleExternalLinks(container);
    postProcessAlerts(container);
    postProcessFootnotes(container, wnd, doc);
    applyAttributeLists(container);
    replaceMathPlaceholders(container, mathLatex, wnd, doc);
    replaceEmojiShortcodes(container, wnd, doc);
    highlightAndWrapCode(container, doc);
    wrapTables(container, doc);
    setupTaskLists(container);

    const contentHtml = container.innerHTML;
    const usesMath =
        mathLatex.length > 0 || contentHtml.indexOf("katex") !== -1;
    const usesMermaid = contentHtml.indexOf("mermaid-holder") !== -1;

    return { contentHtml, usesMath, usesMermaid };
}

module.exports = { renderMarkdown };
