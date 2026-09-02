"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const SINGLE_PASTE_MAX = 25000;
const ANON_MAX_PARTS = 6;
const ANON_PART_SIZE_CEILING = 50000;
const PART_TAG_OVERHEAD = 1000;
const MAX_FILE_CHARS = 400000;

const PASTE_FILE_EXTENSIONS = new Set([
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
]);

function codeFenceFor(content) {
    let longest = 0;
    for (const match of content.match(/`+/g) || []) {
        longest = Math.max(longest, match.length);
    }
    return "`".repeat(Math.max(3, longest + 1));
}

function fileBlock(file) {
    const truncationNote = file.truncated ? `\n(${file.name} was truncated to ${MAX_FILE_CHARS} chars)` : "";
    if (!file.isText) {
        return `\n\n<file name="${file.name}" encoding="base64">\n${file.content}\n</file>${truncationNote}`;
    }
    const lang = path.extname(file.name).slice(1);
    const fence = codeFenceFor(file.content);
    return `\n\n<file name="${file.name}" lang="${lang}">\n${fence}${lang}\n${file.content}\n${fence}\n</file>${truncationNote}`;
}

const DECODE_NOTE = '\n\nAny <file> block with encoding="base64" contains base64-encoded bytes. Decode those blocks before analyzing them.';

function buildTextPayload(question) {
    const commandBlocks = (question.commandResults || [])
        .map(formatCommandResult)
        .join("\n\n");
    const parts = [];
    if (commandBlocks) parts.push(commandBlocks);
    if (question.text) parts.push(question.text);
    return parts.join("\n\n");
}

function buildFullPrompt(question, options = {}) {
    const { includeFiles = true } = options;
    const commandBlocks = (question.commandResults || [])
        .map(formatCommandResult)
        .join("\n\n");
    const parts = [];
    if (commandBlocks) parts.push(commandBlocks);
    if (question.text) parts.push(question.text);
    if (includeFiles) {
        const filesBlocks = question.files.map(fileBlock).join("");
        const hasBinary = question.files.some((file) => !file.isText);
        if (filesBlocks) parts.push(filesBlocks);
        if (hasBinary) parts.push(DECODE_NOTE);
    }
    return parts.join("\n\n");
}

function formatCommandResult(result) {
    const truncatedStdout = result.stdout.length > result.maxOutput;
    const truncatedStderr = result.stderr.length > result.maxOutput;
    const displayStdout = truncatedStdout ? result.stdout.slice(0, result.maxOutput) : result.stdout;
    const displayStderr = truncatedStderr ? result.stderr.slice(0, result.maxOutput) : result.stderr;

    let block = `<command name="${result.command}">\n`;
    block += `<exit_code>${result.exitCode}</exit_code>\n`;
    if (result.timedOut) {
        block += `<timed_out>true</timed_out>\n`;
    }
    block += `<status>${result.success ? "success" : "failed"}</status>\n`;
    if (truncatedStdout || truncatedStderr) {
        block += `<truncated>true</truncated>\n`;
        block += `<truncation_note>Output was truncated to ${result.maxOutput.toLocaleString()} characters per stream. Set ASKWEB_MAX_CMD_OUTPUT to override.</truncation_note>\n`;
    }
    if (result.blocked) {
        block += `<blocked>true</blocked>\n`;
    }
    block += `<stdout>\n${displayStdout}\n</stdout>\n`;
    if (displayStderr) {
        block += `<stderr>\n${displayStderr}\n</stderr>\n`;
    }
    block += `</command>`;
    return block;
}

const ACTIVE_TEMP_FILES = [];

function stageTempPayload(payload) {
    const stageStart = Date.now();
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askweb-payload-"));
        const file = path.join(dir, "payload.md");
        fs.writeFileSync(file, payload, "utf8");
        ACTIVE_TEMP_FILES.push(dir);
        return { name: "payload.md", fullPath: file, isText: true, content: payload, truncated: false };
    } catch (error) {
        console.log(`>> Failed to stage temp payload: ${error.message}`);
        return null;
    }
}

function cleanupTempPayloads() {
    const count = ACTIVE_TEMP_FILES.length;
    for (const dir of ACTIVE_TEMP_FILES.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (count > 0) {
        console.log(`>> Cleaned up ${count} temp payload dir(s).`);
    }
}

function shouldPasteFiles(files) {
    return files.some((file) => PASTE_FILE_EXTENSIONS.has(path.extname(file.name).toLowerCase()));
}

function splitPayloadChunks(text, size) {
    const chunks = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(offset + size, text.length);
        const lastCode = text.charCodeAt(end - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff && end < text.length) end += 1;
        chunks.push(text.slice(offset, end));
        offset = end;
    }
    return chunks;
}

function buildTransmissionPlan(payload, chunkSize) {
    const chunks = splitPayloadChunks(payload, chunkSize);
    const total = chunks.length;
    const header = [
        `[TRANSMISSION HEADER] I am sending a document in ${total} numbered part(s).`,
        "Each part is delimited by [PAYLOAD PART i/N] ... [/PAYLOAD PART i/N].",
        'After each part, reply with ONLY "OK". Do not analyze or answer anything yet.',
        "When I send TRANSMISSION COMPLETE, then answer my question.",
    ].join("\n");

    const parts = chunks.map((chunk, i) => {
        const open = `[PAYLOAD PART ${i + 1}/${total} chars=${chunk.length}]`;
        const close = `[/PAYLOAD PART ${i + 1}/${total}]`;
        const body = `${open}\n${chunk}\n${close}`;
        return i === 0 ? `${header}\n\n${body}` : body;
    });
    return { parts, totalParts: total, totalChars: payload.length };
}

function planTransmissionParts(payloadLength) {
    const usablePerPart = ANON_PART_SIZE_CEILING - PART_TAG_OVERHEAD;
    return Math.max(1, Math.ceil(payloadLength / usablePerPart));
}

function buildMinimalTransmissionPlan(payload) {
    const totalParts = planTransmissionParts(payload.length);
    return buildTransmissionPlan(payload, Math.ceil(payload.length / totalParts));
}

function resolveChunkSizeOverride() {
    const manual = Number(process.env.ASKWEB_CHUNK_SIZE);
    return Number.isFinite(manual) && manual > 0 ? Math.floor(manual) : null;
}

function buildDeliveryPlan(payload) {
    const manualChunkSize = resolveChunkSizeOverride();
    if (manualChunkSize) {
        console.log(`>> Using manual chunk size override: ${manualChunkSize} chars (${(manualChunkSize / 1024).toFixed(1)} KB).`);
    }
    return {
        plan: manualChunkSize
            ? buildTransmissionPlan(payload, manualChunkSize)
            : buildMinimalTransmissionPlan(payload),
        manualChunkSize,
    };
}

function buildTransmissionFinale(total, finalQuestion) {
    const confirm = `TRANSMISSION COMPLETE - all ${total} part(s) sent (1..${total}). Now answer my question below.`;
    return finalQuestion ? `${confirm}\n\nMy question: ${finalQuestion}` : confirm;
}

module.exports = {
    SINGLE_PASTE_MAX,
    ANON_MAX_PARTS,
    ANON_PART_SIZE_CEILING,
    PART_TAG_OVERHEAD,
    MAX_FILE_CHARS,
    PASTE_FILE_EXTENSIONS,
    DECODE_NOTE,
    codeFenceFor,
    fileBlock,
    formatCommandResult,
    buildTextPayload,
    buildFullPrompt,
    stageTempPayload,
    cleanupTempPayloads,
    shouldPasteFiles,
    splitPayloadChunks,
    buildTransmissionPlan,
    planTransmissionParts,
    buildMinimalTransmissionPlan,
    resolveChunkSizeOverride,
    buildDeliveryPlan,
    buildTransmissionFinale,
};
