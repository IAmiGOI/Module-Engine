/**
 * Снимок графа для библиотеки (MEMORY_GRAPH_TYPES_PLAN.md, этап 9) — чистые функции, без обращений к хранилищу и Ядру.
 * Запись библиотеки — версионированный JSON: граф без временных данных чата (закреплённый блок ретрива, журнал решений, часы,
 * ссылки `wiUid`/`wiBook` на зеркальные записи лорбука чужого чата), эмбеддинги — квантованные Int8 в base64 (≈ 0.5 КБ на ноду
 * вместо ~4.6 КБ в JSON).
 */

export const RECORD_FORMAT = 'stme-memory-graph';
export const RECORD_VERSION = 1;
export const LIBRARY_LIMITS = Object.freeze({ maxRecords: 50, maxBytes: 20 * 1024 * 1024 });

// --- Квантование эмбеддингов ---------------------------------------------------

/** `{ q, s }`: base64 Int8 и множитель (`значение ≈ q[i] * s`). Нулевой вектор — множитель 0. */
export function quantizeEmbedding(vector) {
    const max = vector.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
    const scale = max / 127;
    const bytes = new Int8Array(vector.length);
    if (scale > 0) for (let i = 0; i < vector.length; i += 1) bytes[i] = Math.round(vector[i] / scale);
    return { q: toBase64(new Uint8Array(bytes.buffer)), s: scale };
}

export function dequantizeEmbedding({ q, s }) {
    const bytes = new Int8Array(fromBase64(q).buffer);
    return Array.from(bytes, value => value * s);
}

function toBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
}

function fromBase64(text) {
    const binary = globalThis.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// --- Запись --------------------------------------------------------------------

const TRANSIENT_NODE_FIELDS = ['wiUid', 'wiBook'];

function packNode(node) {
    const copy = { ...node };
    for (const field of TRANSIENT_NODE_FIELDS) delete copy[field];
    if (Array.isArray(copy.embedding) && copy.embedding.length) copy.embedding = quantizeEmbedding(copy.embedding);
    return copy;
}

function unpackNode(node, turn) {
    const copy = { ...node };
    if (copy.embedding && !Array.isArray(copy.embedding) && copy.embedding.q) copy.embedding = dequantizeEmbedding(copy.embedding);
    // Часы приводятся к текущему чату (как `migrateTimestamps`): возраст нод в чате, где граф открыт, считается заново.
    copy.createdTurn = turn;
    copy.lastTouchedTurn = turn;
    return copy;
}

const countOf = (nodes, predicate) => Object.values(nodes).filter(predicate).length;

export function snapshotCounts(nodes, regions) {
    return {
        nodes: Object.keys(nodes).length,
        regions: Object.keys(regions).length,
        cores: countOf(nodes, node => node.core || node.protectedNode),
        events: countOf(nodes, node => node.kind === 'event'),
    };
}

/** Собирает запись библиотеки. `source` — откуда граф (персонаж, чат, отпечаток лорбука), `thumbnail` — SVG-строка ≤ 8 КБ или `null`. */
export function buildRecord({ id, name, mode, now, source = {}, thumbnail = null, graph, createdAt = now }) {
    const nodes = Object.fromEntries(Object.entries(graph.nodes).map(([nodeId, node]) => [nodeId, packNode(node)]));
    const record = {
        format: RECORD_FORMAT, version: RECORD_VERSION, id, name, mode, savedAt: createdAt, updatedAt: now,
        source: { characterName: source.characterName ?? null, chatName: source.chatName ?? null, lorebookFingerprint: source.lorebookFingerprint ?? null },
        counts: snapshotCounts(graph.nodes, graph.regions),
        thumbnail: typeof thumbnail === 'string' && thumbnail.length <= 8192 ? thumbnail : null,
        graph: {
            nodes, regions: graph.regions, mergeQueue: graph.mergeQueue ?? {}, reconsolidationQueue: graph.reconsolidationQueue ?? {},
            staging: graph.staging ?? {}, stats: { distance: graph.distanceStats ?? null, novelty: graph.noveltyStats ?? null },
        },
    };
    record.size = JSON.stringify(record).length;
    return record;
}

/** Граф из записи для копирования в чат: распакованные эмбеддинги, часы = `turn`, без ссылок на чужой лорбук. */
export function restoreGraph(record, turn) {
    const nodes = Object.fromEntries(Object.entries(record.graph.nodes).map(([id, node]) => [id, unpackNode(node, turn)]));
    const clone = value => JSON.parse(JSON.stringify(value ?? {}));
    return {
        nodes, regions: clone(record.graph.regions), mergeQueue: clone(record.graph.mergeQueue),
        reconsolidationQueue: clone(record.graph.reconsolidationQueue), staging: clone(record.graph.staging),
        distanceStats: record.graph.stats?.distance ?? null, noveltyStats: record.graph.stats?.novelty ?? null,
    };
}

/** Разбор импортируемого текста: `{ ok, record }` или `{ ok: false, error }` с понятным текстом. */
export function parseImportedRecord(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, error: 'This file is not valid JSON.' }; }
    if (parsed?.format !== RECORD_FORMAT) return { ok: false, error: 'This file is not a Memory Graph export.' };
    if (parsed.version !== RECORD_VERSION) return { ok: false, error: `Unsupported Memory Graph export version ${parsed.version} (this build reads version ${RECORD_VERSION}).` };
    if (!parsed.id || !parsed.graph?.nodes || !parsed.graph?.regions) return { ok: false, error: 'This Memory Graph export is incomplete.' };
    return { ok: true, record: parsed };
}

/** Проверка лимитов перед сохранением: `{ ok }` или `{ ok: false, error }`. `existing` — сводки текущих записей `{ id, size }`; заменяемая запись (`replacingId`) не считается. */
export function checkLibraryLimits(existing, incomingSize, replacingId = null) {
    const others = existing.filter(item => item.id !== replacingId);
    if (others.length + 1 > LIBRARY_LIMITS.maxRecords) return { ok: false, error: `The library holds at most ${LIBRARY_LIMITS.maxRecords} graphs — delete one first.` };
    const total = others.reduce((sum, item) => sum + (item.size ?? 0), 0) + incomingSize;
    if (total > LIBRARY_LIMITS.maxBytes) return { ok: false, error: `The library is limited to ${Math.round(LIBRARY_LIMITS.maxBytes / 1048576)} MB — delete a graph to make room.` };
    return { ok: true };
}

/** Отпечаток лорбука: хэш строки из отсортированных `book|uid|name|length` сводок записей (текст записей не читается — это вызов на каждую; длина ловит правку содержимого). */
export async function lorebookFingerprint(summaries, { subtle = globalThis.crypto?.subtle } = {}) {
    if (!subtle || !summaries?.length) return null;
    const text = summaries.map(entry => `${entry.book ?? ''}|${entry.uid}|${entry.name ?? ''}|${entry.length ?? ''}`).sort().join('\n');
    const digest = await subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Сводка записи для списка и карточек: всё, кроме самого графа. */
export function summarizeRecord(record) {
    const { graph, ...rest } = record;
    return rest;
}
