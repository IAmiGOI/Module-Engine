/**
 * Сжатие и упаковка файлов для облака (Dropbox / Google Drive) — чистые функции, без сети и без хранилища.
 *
 * Зачем и сколько это даёт (замер на настоящих данных, не на теории):
 *  - **Текст** (чаты, миры, пресеты, настройки) сжимается gzip'ом примерно в 4 раза (чаты: 9,2 МБ → 2,4 МБ, −74 %). Brotli лучше всего на ~10 %,
 *    но в браузере его нет «из коробки» (нужна своя библиотека, а на слабом железе она заметно дороже) — берём `CompressionStream('gzip')`:
 *    нативный, асинхронный, без зависимостей.
 *  - **Карточки персонажей** — это PNG; 84 % их веса — сама картинка, уже сжатая. Целиком gzip даёт всего −17 %, а картинку нельзя перекодировать,
 *    не сменив байты и отпечаток (`card-fingerprint.js`). Поэтому карточки, фоны и любые бинарные файлы НЕ сжимаем: слабое железо не
 *    тратит время ради нескольких процентов. Упаковывать их в блоки тоже не нужно: объём не уменьшится, а ради одной карточки пришлось бы
 *    качать весь блок.
 *  - **Старые чаты в блоки по персонажу** уменьшают число запросов (на первой синхронизации — главная трата времени на мелких файлах) и
 *    общее число файлов у провайдера; сжимаются они в одном потоке.
 *
 * Совместимость с устройствами без обновления (важно: у `daed3bf` и новее при несовпадении байтов с меткой включается «лечение метки»,
 * которое ПРИНЯЛО бы чужие байты как файл) — поэтому сжатое и упакованное лежит под НОВЫМИ именами (`z-…`, `k-…`), которых старая версия не
 * ищет: она увидит запись в индексе без данных под своим именем и честно откажет по этому файлу, ничего не испортив.
 */

export const COMPRESSED_PREFIX = 'z-';
export const PACK_PREFIX = 'k-';

/** Чат «старый», если его последнее сообщение старше этого. */
export const COLD_AGE_MS = 30 * 24 * 3600 * 1000;
/** Меньше стольких старых чатов одного персонажа в блок не собираем — просто сжатые файлы. */
export const PACK_MIN_MEMBERS = 3;
/** Блок собирается в памяти: потолок несжатого размера, чтобы слабое устройство не держало десятки мегабайт. */
export const PACK_MAX_BYTES = 8 * 1024 * 1024;
/** Файл меньше этого не сжимаем: заголовок gzip съест выигрыш. */
export const MIN_COMPRESS_BYTES = 256;
/** Сжатое хранится, только если вышло не больше этой доли оригинала. */
export const MAX_COMPRESSED_RATIO = 0.9;

const TEXT_EXTENSIONS = /\.(jsonl|json|txt|md|css|ya?ml)$/i;
const TEXT_SECTIONS = new Set(['chats', 'groupChats', 'groups', 'worlds', 'presets', 'themes', 'quickReplies', 'stmeSettings', 'stmeGraphs', 'stmePmPresets']);

/** Текстовый путь, который стоит сжимать. Картинки, карточки и прочее бинарное — нет. */
export function isCompressible(path, size = Infinity) {
    const text = String(path);
    if (size < MIN_COMPRESS_BYTES) return false;
    const section = text.slice(0, Math.max(0, text.indexOf('/')));
    return TEXT_SECTIONS.has(section) && TEXT_EXTENSIONS.test(text);
}

/** Старый чат — кандидат в блок (по персонажу): только чаты персонажей, не групповые и не открытые прямо сейчас (это забота локальной стороны). */
export function isPackable(path, { modified = 0, size = 0, now = Date.now() } = {}) {
    const text = String(path);
    if (!text.startsWith('chats/') || !text.endsWith('.jsonl')) return false;
    if (!modified || now - modified < COLD_AGE_MS) return false;
    return size < PACK_MAX_BYTES / 2;
}

/** Группа блока: папка персонажа (`chats/Alex`). */
export const packGroupOf = path => String(path).slice(0, String(path).lastIndexOf('/'));

// ── gzip через встроенные потоки ─────────────────────────────────────────────────────────────────────────────────

async function through(bytes, stream) {
    const piped = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(piped).arrayBuffer());
}

export const gzip = async bytes => through(bytes, new CompressionStream('gzip'));
export const gunzip = async bytes => through(bytes, new DecompressionStream('gzip'));

const toBytes = async blob => (blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer()));

/**
 * Сжать, если это того стоит.
 * @returns {Promise<{bytes:Uint8Array, compressed:boolean}>}
 */
export async function maybeCompress(path, blob) {
    const original = await toBytes(blob);
    if (!isCompressible(path, original.length)) return { bytes: original, compressed: false };
    const packed = await gzip(original);
    return packed.length <= original.length * MAX_COMPRESSED_RATIO ? { bytes: packed, compressed: true } : { bytes: original, compressed: false };
}

// ── Блок ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Блок = gzip( [4 байта: длина заголовка][заголовок JSON][тела файлов подряд] ). Один поток сжатия на весь блок, заголовок самоописывающий
 * (из блока можно восстановить, что в нём лежит, даже если индекс потерян).
 * @param {Array<{path:string, bytes:Uint8Array}>} members
 * @returns {Promise<{bytes:Uint8Array, entries:Array<{path:string, offset:number, length:number}>}>}
 */
export async function buildPack(members) {
    const entries = [];
    let offset = 0;
    for (const member of members) { entries.push({ path: member.path, offset, length: member.bytes.length }); offset += member.bytes.length; }
    const header = encoder.encode(JSON.stringify({ v: 1, files: entries.map(entry => [entry.path, entry.offset, entry.length]) }));
    const raw = new Uint8Array(4 + header.length + offset);
    new DataView(raw.buffer).setUint32(0, header.length, false);
    raw.set(header, 4);
    let at = 4 + header.length;
    for (const member of members) { raw.set(member.bytes, at); at += member.bytes.length; }
    return { bytes: await gzip(raw), entries };
}

/** @returns {Promise<{files:Map<string,{offset:number,length:number}>, payload:Uint8Array}>} */
export async function parsePack(packBytes) {
    const raw = await gunzip(packBytes);
    if (raw.length < 4) throw new Error('The pack is damaged (too short).');
    const headerLength = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, false);
    if (4 + headerLength > raw.length) throw new Error('The pack is damaged (header does not fit).');
    const header = JSON.parse(decoder.decode(raw.subarray(4, 4 + headerLength)));
    if (header?.v !== 1 || !Array.isArray(header.files)) throw new Error('The pack has an unknown format.');
    const payload = raw.subarray(4 + headerLength);
    const files = new Map(header.files.map(([path, offset, length]) => [path, { offset, length }]));
    return { files, payload };
}

/** Тело одного файла из разобранного блока. */
export function sliceFromPack(pack, path) {
    const found = pack.files.get(path);
    if (!found) throw new Error(`"${path}" is not inside this pack.`);
    return pack.payload.subarray(found.offset, found.offset + found.length);
}
