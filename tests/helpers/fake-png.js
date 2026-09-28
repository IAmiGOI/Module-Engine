/**
 * Собирает МИНИМАЛЬНО валидный (по структуре чанков, не по реальным пикселям) PNG для тестов `card-fingerprint.js`: сигнатура +
 * заданные чанки + `IEND`, если его нет в списке. CRC не считается по-настоящему (наш парсер его не проверяет — как и сама ST при
 * простом переборе чанков) — 4 нулевых байта на каждый чанк вполне достаточно.
 */
const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const encoder = new TextEncoder();

function chunkBytes(type, data) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, data.length, false);
    const typeBytes = encoder.encode(type);
    const crc = new Uint8Array(4);   // не проверяется — см. doc-comment файла
    const out = new Uint8Array(4 + 4 + data.length + 4);
    out.set(length, 0);
    out.set(typeBytes, 4);
    out.set(data, 8);
    out.set(crc, 8 + data.length);
    return out;
}

/** `tEXt`-чанк: `keyword\0text`, оба ASCII/Latin-1, как пишет сама ST. */
export function textChunk(keyword, text) {
    const bytes = new Uint8Array(keyword.length + 1 + text.length);
    for (let index = 0; index < keyword.length; index += 1) bytes[index] = keyword.charCodeAt(index);
    bytes[keyword.length] = 0;
    for (let index = 0; index < text.length; index += 1) bytes[keyword.length + 1 + index] = text.charCodeAt(index);
    return ['tEXt', bytes];
}

/**
 * @param {Array<[string, Uint8Array]>} chunks Пары `[type, data]`, в порядке появления (без сигнатуры и без IEND — тот
 *   добавляется автоматически, если явно не задан).
 */
export function buildPng(chunks) {
    const withEnd = chunks.some(([type]) => type === 'IEND') ? chunks : [...chunks, ['IEND', new Uint8Array(0)]];
    const parts = [SIGNATURE, ...withEnd.map(([type, data]) => chunkBytes(type, data))];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}

export const fakeImageChunk = (label = 'IDAT') => [label, new TextEncoder().encode(`fake-pixels-${label}`)];

/** Карточка Spec v2 минимального вида, с волатильными полями заполненными так, как их проставляет сама ST при импорте. */
export function fakeCard(overrides = {}) {
    return {
        name: 'Alice', description: 'A test character.', spec: 'chara_card_v2', spec_version: '2.0',
        chat: 'Alice - 2026-01-01 @00h00m00s', create_date: '2026-01-01T00:00:00.000Z', avatar: 'none', fav: false,
        data: { name: 'Alice', description: 'A test character.', extensions: { fav: false } },
        ...overrides,
    };
}

/** Полная PNG-карточка: фиктивные «изображение»-чанки + `tEXt chara` (и, по умолчанию, `ccv3`) с `card`, закодированным в base64 — как пишет сама ST. */
export function buildCardPng(card, { imageLabel = 'IDAT', includeCcv3 = true, extraImageChunks = [] } = {}) {
    const json = JSON.stringify(card);
    const base64 = Buffer.from(json, 'utf8').toString('base64');
    const chunks = [['IHDR', new TextEncoder().encode('fake-header')], fakeImageChunk(imageLabel), ...extraImageChunks, textChunk('chara', base64)];
    if (includeCcv3) chunks.push(textChunk('ccv3', Buffer.from(JSON.stringify({ ...card, spec: 'chara_card_v3', spec_version: '3.0' }), 'utf8').toString('base64')));
    return buildPng(chunks);
}
