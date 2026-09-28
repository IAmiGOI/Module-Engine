/**
 * Отпечаток персонажа «по смыслу», а не по байтам PNG — устраняет главную причину ложных конфликтов при первой встрече пары
 * устройств (см. `sync-plan.js`): один и тот же персонаж на двух устройствах почти никогда не совпадает побайтно, потому что сама
 * ST переписывает часть полей карточки при каждом импорте/сохранении — не по случайности, а КАЖДЫЙ раз безусловно.
 *
 * **Проверено по исходникам ST 1.18** (`src/endpoints/characters.js`, `src/character-card-parser.js`):
 *  - `importFromPng()` → для Spec v2/v3 файла (`jsonData.spec !== undefined`, обычный случай): `unsetPrivateFields(jsonData)`
 *    делает `chat` = удалено, `fav` = `false`, `data.extensions.fav` = `false` — БЕЗ УСЛОВИЙ, на каждом импорте; следом
 *    `readFromV2(jsonData)` подставляет `chat = chat ?? "<имя> - <текущее время>"`, а раз `chat` только что удалён — это
 *    ВСЕГДА генерирует новое значение. Затем `jsonData.create_date = new Date().toISOString()` — тоже безусловно, не только
 *    когда поле отсутствует.
 *  - Значит после ЛЮБОГО push/pull карточки (`/api/characters/import`, `services/st-user-data.js`'s `characters` provider) файл
 *    на другой стороне гарантированно отличается от источника по `chat`/`create_date`/`fav`/`data.extensions.fav` — не только
 *    при конфликте первой встречи (`sync-plan.js`'s `B === null`), а на КАЖДОМ обычном переносе тоже. Из-за этого база,
 *    записанная по байтовому хешу источника, тут же расходится с тем, что реально лежит у получателя, и на следующем проходе
 *    файл конфликтует уже сам с собой (см. doc-comment `sync-plan.js`, пункт про потерю привязки).
 *  - `character-card-parser.js`'s `write()`/`read()`: карточка лежит в PNG как один или два tEXt-чанка — `chara` (Spec v2,
 *    пишется всегда) и `ccv3` (Spec v3, пишется дополнительно поверх того же `data`, если `data` распарсился) — оба base64
 *    внутри `keyword\0text`; `ccv3`, если есть, имеет приоритет при чтении (`ccv3Index > -1` проверяется первым), сравнение
 *    ключевого слова регистронезависимо (`keyword.toLowerCase()`) — сделано так же и здесь.
 *  - `fav`/`json_data` НЕ трогаются `importRisuSprites()` (только RisuAI-персонажи со спрайтами — не общий случай, не считалось).
 *
 * Отпечаток = хеш(байты изображения без текстовых чанков + '\0' + канонический JSON карточки без волатильных полей).
 * `card1:` — префикс версии формата: если правила нормализации когда-нибудь изменятся, старые кэши/базы не совпадут по ошибке
 * с новыми (сравнение в `sync-plan.js` явно требует `key` с ОБЕИХ сторон, отпечаток другой версии просто не считается ключом).
 *
 * Байты изображения (IHDR/PLTE/IDAT/…) сравниваются как есть, без декодирования пикселей: если один и тот же персонаж был
 * когда-либо пересобран другим кодировщиком PNG (не через саму ST), отпечаток изображения будет другим и пара всё равно
 * поймает конфликт — это не хуже сегодняшнего поведения (сейчас конфликт ловит вообще всегда), только не устраняет этот
 * редкий случай полностью.
 */

const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_CHUNK_TYPES = Object.freeze(new Set(['tEXt', 'zTXt', 'iTXt']));
/** Поля, которые сама ST переписывает безусловно на каждом импорте/сохранении (см. doc-comment выше) — сравнение по ним бессмысленно. */
export const CARD_VOLATILE_FIELDS = Object.freeze(['create_date', 'chat', 'avatar', 'json_data', 'fav', 'data.extensions.fav']);
export const FINGERPRINT_PREFIX = 'card1:';

function toBytes(content) {
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    throw new TypeError('card-fingerprint: expected a Uint8Array or ArrayBuffer.');
}

/**
 * Разбор PNG на чанки — сигнатура + повтор `length(4, BE) | type(4 ASCII) | data(length) | crc(4)`, до `IEND` включительно.
 * Возвращает `null` для не-PNG или обрубленного файла (обрывающийся вызывающий падает обратно на побайтовый хеш файла целиком).
 * @param {Uint8Array|ArrayBuffer} content
 * @returns {Array<{type:string, data:Uint8Array, raw:Uint8Array}>|null}
 */
export function extractPngChunks(content) {
    const bytes = toBytes(content);
    if (bytes.length < 8 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        const chunkEnd = dataEnd + 4;   // + CRC
        if (length < 0 || chunkEnd > bytes.length) return null;   // обрублен посреди чанка — не считать, что распарсили
        chunks.push({ type, data: bytes.subarray(dataStart, dataEnd), raw: bytes.subarray(offset, chunkEnd) });
        offset = chunkEnd;
        if (type === 'IEND') break;
    }
    return chunks.length && chunks.at(-1).type === 'IEND' ? chunks : null;
}

const latin1Decode = bytes => String.fromCharCode(...bytes);

/** `tEXt`-чанк → `{keyword, text}` (как `PNGtext.decode` у самой ST) или `null`, если в данных нет разделителя `\0`. */
function decodeTextChunk(data) {
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    return { keyword: latin1Decode(data.subarray(0, nul)), text: latin1Decode(data.subarray(nul + 1)) };
}

function base64ToUtf8(base64) {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
}

/** Удаляет пути из `CARD_VOLATILE_FIELDS` (точка — вложенность); не мутирует вход. */
function stripVolatileFields(card) {
    const clone = JSON.parse(JSON.stringify(card));
    for (const dotted of CARD_VOLATILE_FIELDS) {
        const parts = dotted.split('.');
        let node = clone;
        for (let index = 0; index < parts.length - 1 && node && typeof node === 'object'; index += 1) node = node[parts[index]];
        if (node && typeof node === 'object') delete node[parts.at(-1)];
    }
    return clone;
}

/** `JSON.stringify` с рекурсивно отсортированными ключами объектов — порядок ключей в исходном файле не должен влиять на отпечаток. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

const encoder = new TextEncoder();

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { joined.set(part, offset); offset += part.length; }
    return joined;
}

/**
 * @param {Uint8Array|ArrayBuffer} content Байты PNG-файла карточки.
 * @param {object} input
 * @param {(bytes:Uint8Array)=>Promise<string>} input.hash Хеш-функция (в движке — `computeGitBlobSha`; здесь не важно, какая именно,
 *   лишь бы одна и та же на обеих сторонах).
 * @returns {Promise<string|null>} `"card1:<hex>"` или `null` (не PNG / нет `chara`/`ccv3` / битый base64-JSON) — вызывающий сравнивает
 *   такие файлы по обычному байтовому хешу, как раньше.
 */
export async function computeCardFingerprint(content, { hash } = {}) {
    if (typeof hash !== 'function') throw new TypeError('computeCardFingerprint: "hash" function is required.');
    let chunks;
    try { chunks = extractPngChunks(content); } catch { chunks = null; }
    if (!chunks) return null;

    const imageParts = [];
    let charaText = null;
    let ccv3Text = null;
    for (const chunk of chunks) {
        if (TEXT_CHUNK_TYPES.has(chunk.type)) {
            if (chunk.type === 'tEXt') {
                const decoded = decodeTextChunk(chunk.data);
                const keyword = decoded?.keyword.toLowerCase();
                if (keyword === 'ccv3' && ccv3Text === null) ccv3Text = decoded.text;
                else if (keyword === 'chara' && charaText === null) charaText = decoded.text;
            }
            continue;   // zTXt/iTXt тоже исключены из отпечатка изображения, даже если бы там лежала карта (ST их не пишет)
        }
        imageParts.push(chunk.raw);
    }

    const base64Text = ccv3Text ?? charaText;
    if (base64Text === null) return null;

    let card;
    try { card = JSON.parse(base64ToUtf8(base64Text)); } catch { return null; }
    if (!card || typeof card !== 'object') return null;

    const payload = concatBytes([...imageParts, encoder.encode('\0'), encoder.encode(canonicalJson(stripVolatileFields(card)))]);
    return `${FINGERPRINT_PREFIX}${await hash(payload)}`;
}
