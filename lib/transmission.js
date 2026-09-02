"use strict";

const SINGLE_PASTE_MAX = 25000;
const ANON_MAX_PARTS = 6;
const ANON_PART_SIZE_CEILING = 50000;
const PART_TAG_OVERHEAD = 1000;

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

function planAnonymousParts(payloadLength) {
    const usablePerPart = ANON_PART_SIZE_CEILING - PART_TAG_OVERHEAD;
    return Math.max(1, Math.ceil(payloadLength / usablePerPart));
}

module.exports = {
    SINGLE_PASTE_MAX,
    ANON_MAX_PARTS,
    ANON_PART_SIZE_CEILING,
    PART_TAG_OVERHEAD,
    splitPayloadChunks,
    buildTransmissionPlan,
    planTransmissionParts,
    buildMinimalTransmissionPlan,
    resolveChunkSizeOverride,
    buildDeliveryPlan,
    buildTransmissionFinale,
    planAnonymousParts,
};
