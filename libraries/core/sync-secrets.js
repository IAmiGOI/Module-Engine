/**
 * Секреты пары устройств. Публичный канал сигналов (через него два устройства находят друг друга) видит всё, что по нему идёт,
 * поэтому каждое сообщение — зашифрованный конверт (AES-GCM), а адрес «комнаты» выводится из общего секрета и ничего не выдаёт.
 *
 * Два этапа:
 *  1. **Сопряжение** — одноразовый короткий код (`K7QM4-X2P9D`, 50 бит), который человек переносит глазами с одного экрана на
 *     другой. Из него медленным PBKDF2 (чтобы перебор был бессмысленным) выводятся адрес комнаты и ключ. В этой комнате
 *     устройства обмениваются настоящим долгоживущим секретом.
 *  2. **Дальше** — из долгоживущего секрета (HKDF) выводятся постоянные адрес и ключ; код больше не нужен, устройства находят
 *     друг друга сами. Сам файловый канал (WebRTC) шифруется DTLS, а его отпечатки едут внутри этих конвертов — подменить их,
 *     не зная секрета, нельзя.
 *
 * Криптография — штатный WebCrypto (`subtle`), передаётся снаружи, чтобы тесты и браузер использовали одну и ту же реализацию.
 */

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford: без I, L, O, U — их путают с 1, 0 и V
const CODE_LENGTH = 10;
const PBKDF2_ITERATIONS = 200000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const defaultSubtle = () => globalThis.crypto?.subtle;
const defaultRandom = () => globalThis.crypto;

export function toBase64Url(bytes) {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(text).length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
}

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** `K7QM4-X2P9D` — 10 знаков из 32, через дефис по пять. */
export function generatePairingCode({ random = defaultRandom() } = {}) {
    const bytes = random.getRandomValues(new Uint8Array(CODE_LENGTH));
    const chars = Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
    return `${chars.slice(0, 5).join('')}-${chars.slice(5).join('')}`;
}

/** Терпимый разбор ввода человека: регистр, пробелы, дефисы; путаница O/0 и I/L/1 исправляется. `null` — не похоже на код. */
export function normalizePairingCode(input) {
    const cleaned = String(input ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (cleaned.length !== CODE_LENGTH) return null;
    return [...cleaned].every(char => CODE_ALPHABET.includes(char)) ? cleaned : null;
}

export function formatPairingCode(normalized) {
    return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

/** Случайный долгоживущий секрет пары (32 байта, base64url). */
export function generateSecret({ random = defaultRandom() } = {}) {
    return toBase64Url(random.getRandomValues(new Uint8Array(32)));
}

export function generateDeviceId({ random = defaultRandom() } = {}) {
    return toHex(random.getRandomValues(new Uint8Array(8)));
}

async function splitKeyMaterial(bits) {
    const bytes = new Uint8Array(bits);
    return { topic: `stme${toHex(bytes.slice(0, 16))}`, key: bytes.slice(16, 48) };
}

/** Адрес комнаты и ключ из одноразового кода. Намеренно медленно. */
export async function deriveFromPairingCode(code, { subtle = defaultSubtle() } = {}) {
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new Error('deriveFromPairingCode: not a valid pairing code.');
    const material = await subtle.importKey('raw', encoder.encode(normalized), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode('stme-sync-pair-v1'), iterations: PBKDF2_ITERATIONS }, material, 48 * 8);
    return splitKeyMaterial(bits);
}

/** Постоянные адрес и ключ из долгоживущего секрета пары. */
export async function deriveFromSecret(secret, { subtle = defaultSubtle() } = {}) {
    const material = await subtle.importKey('raw', fromBase64Url(secret), 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('stme-sync-room-v1'), info: encoder.encode('signal') }, material, 48 * 8);
    return splitKeyMaterial(bits);
}

/** Шифрованный конверт: `seal(объект)` → строка base64url, `open(строка)` → объект или `null`, если ключ не тот / данные испорчены. */
export async function createBox(keyBytes, { subtle = defaultSubtle(), random = defaultRandom() } = {}) {
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return {
        async seal(value) {
            const iv = random.getRandomValues(new Uint8Array(12));
            const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value))));
            const out = new Uint8Array(iv.length + cipher.length);
            out.set(iv, 0);
            out.set(cipher, iv.length);
            return toBase64Url(out);
        },
        async open(text) {
            try {
                const bytes = fromBase64Url(text);
                const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
                return JSON.parse(decoder.decode(plain));
            } catch {
                return null;
            }
        },
    };
}

/** Публичные каналы сигналов режут длинные сообщения (ntfy: 4 КБ) — длинный конверт едет несколькими частями. */
export function splitPayload(text, id, maxChars = 3000) {
    const parts = [];
    for (let offset = 0; offset < text.length; offset += maxChars) parts.push(text.slice(offset, offset + maxChars));
    if (!parts.length) parts.push('');
    return parts.map((data, index) => JSON.stringify({ id, i: index, n: parts.length, d: data }));
}

/** Собирает части обратно; `push(строка)` вернёт целый текст, когда пришли все части, иначе `null`. */
export function createPayloadJoiner({ maxPending = 32 } = {}) {
    const groups = new Map();
    return {
        push(line) {
            let part;
            try { part = JSON.parse(line); } catch { return null; }
            if (!part || typeof part.id !== 'string' || !Number.isInteger(part.i) || !Number.isInteger(part.n) || part.n < 1 || part.n > 64 || part.i < 0 || part.i >= part.n) return null;
            let group = groups.get(part.id);
            if (!group) {
                if (groups.size >= maxPending) groups.delete(groups.keys().next().value);
                group = { n: part.n, parts: new Map() };
                groups.set(part.id, group);
            }
            group.parts.set(part.i, String(part.d ?? ''));
            if (group.parts.size < group.n) return null;
            groups.delete(part.id);
            return Array.from({ length: group.n }, (_, index) => group.parts.get(index)).join('');
        },
    };
}
