const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");
const { renderMarkdown } = require("./markdown-to-html");
const { buildHtmlDocument } = require("./pdf-template");
const { generateFileId } = require("./file-id-generator");

async function generatePDF(text, options) {
    options = options || {};
    const {
        outputDir = ".",
        outputFile = null,
        theme = "dark",
        title = "document",
    } = options;

    const { contentHtml, usesMath, usesMermaid } = renderMarkdown(text);

    const html = buildHtmlDocument(contentHtml, {
        theme,
        title,
        usesMath,
        usesMermaid,
    });

    const fileName = outputFile || generateFileId() + ".pdf";
    const filePath = path.resolve(outputDir, fileName);

    if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "domcontentloaded" });

        if (usesMermaid) {
            try {
                await page.waitForFunction("window.__mermaidDone === true", {
                    timeout: 30000,
                });
            } catch (e) {
                console.warn(
                    "Mermaid rendering timed out (requires internet). Diagrams will show as text.",
                );
            }
        }

        await page.waitForFunction("window.__pdfReady === true", {
            timeout: 10000,
        }).catch(() => {});

        const waitMs = usesMermaid ? 1000 : 500;
        await page.waitForTimeout(waitMs);

        await page.pdf({
            path: filePath,
            format: "A4",
            printBackground: true,
            displayWidth: 1200,
            margin: {
                top: "0.75in",
                right: "0.75in",
                bottom: "0.75in",
                left: "0.75in",
            },
        });

        return filePath;
    } finally {
        await browser.close();
    }
}

async function generatePDFFromMarkdownFile(markdownPath, options) {
    options = options || {};
    const text = fs.readFileSync(markdownPath, "utf8");
    const title = options.title || path.basename(markdownPath, path.extname(markdownPath));
    return generatePDF(text, { ...options, title });
}

generatePDF.fromFile = generatePDFFromMarkdownFile;

module.exports = { generatePDF };
