/**
 * Пул снимков: тяжёлые части снимка (Great Bank, журнал Советника, окно сцены) хранятся один раз, по хэшу, а снимок держит
 * ссылки. Персонаж делится на части, списки знаний и истории — на строки: за ход меняется малое, и полный снимок
 * на каждый ход почти ничего не стоит. Раньше тяжёлое держали только три последних снимка, и откат глубже
 * молча оставлял банки и журнал от удалённых ходов. Чистые функции, без хранилища.
 */

const json = value => JSON.stringify(value ?? null);

/** cyrb53 — 53-битный хэш строки; двух разных частей с одним хэшем в одном чате не будет. */
export function hashOf(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const LISTS = ['history'];
const PARTS = ['material', 'spiritual', 'decree', 'psyche', 'pending'];

/** Значение → ссылка; само значение ложится в пул. */
function refer(pool, value) {
    const text = json(value);
    const key = hashOf(text);
    if (!(key in pool)) pool[key] = JSON.parse(text);
    return key;
}
const read = (pool, key) => (key in pool ? JSON.parse(json(pool[key])) : undefined);

function packCharacter(pool, character) {
    if (!character || typeof character !== 'object') return { $value: character };
    const out = { ...character };
    for (const part of PARTS) if (part in out) out[part] = { $ref: refer(pool, out[part]) };
    for (const list of LISTS) if (Array.isArray(out[list])) out[list] = { $refs: out[list].map(item => refer(pool, item)) };
    if (Array.isArray(out.knowledge?.items)) out.knowledge = { ...out.knowledge, items: { $refs: out.knowledge.items.map(item => refer(pool, item)) } };
    return out;
}

function unpackValue(pool, value) {
    if (value && typeof value === 'object' && '$ref' in value) return read(pool, value.$ref);
    if (value && typeof value === 'object' && Array.isArray(value.$refs)) return value.$refs.map(key => read(pool, key));
    return value;
}

function unpackCharacter(pool, packed) {
    if (packed && typeof packed === 'object' && '$value' in packed) return packed.$value;
    const out = { ...packed };
    for (const key of [...PARTS, ...LISTS]) if (key in out) out[key] = unpackValue(pool, out[key]);
    if (out.knowledge && typeof out.knowledge === 'object') out.knowledge = { ...out.knowledge, items: unpackValue(pool, out.knowledge.items) };
    return out;
}

/** Снимок → снимок со ссылками; пул пополняется. Уже упакованный снимок не трогается. */
export function packSnapshot(pool, snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || snapshot.packed) return snapshot;
    const out = { ...snapshot, packed: 1 };
    if (snapshot.greatBank && typeof snapshot.greatBank === 'object') {
        out.greatBank = Object.fromEntries(Object.entries(snapshot.greatBank).map(([key, character]) => [key, packCharacter(pool, character)]));
    }
    if (Array.isArray(snapshot.ledger)) out.ledger = { $refs: snapshot.ledger.map(row => refer(pool, row)) };
    if (Array.isArray(snapshot.window?.entries)) out.window = { ...snapshot.window, entries: { $refs: snapshot.window.entries.map(entry => refer(pool, entry)) } };
    if (Array.isArray(snapshot.frozenWindows)) out.frozenWindows = { $refs: snapshot.frozenWindows.map(record => refer(pool, record)) };
    return out;
}

/** Снимок со ссылками → полный снимок. Ссылка, которой нет в пуле, — `missing` в ответе, а не тихая дыра. */
export function unpackSnapshot(pool, snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.packed) return snapshot;
    const { packed: _packed, ...out } = snapshot;
    const missing = [];
    const check = value => { if (value === undefined) missing.push('part'); return value; };
    if (out.greatBank) {
        out.greatBank = Object.fromEntries(Object.entries(out.greatBank).map(([key, character]) => {
            const full = unpackCharacter(pool, character);
            for (const part of PARTS) if (part in character) check(full[part]);
            return [key, full];
        }));
    }
    const list = refs => refs.$refs.map(key => check(read(pool, key))).filter(item => item !== undefined);
    if (out.ledger && Array.isArray(out.ledger.$refs)) out.ledger = list(out.ledger);
    if (out.window && Array.isArray(out.window.entries?.$refs)) out.window = { ...out.window, entries: list(out.window.entries) };
    if (out.frozenWindows && Array.isArray(out.frozenWindows.$refs)) out.frozenWindows = list(out.frozenWindows);
    return missing.length ? { ...out, missing: missing.length } : out;
}

/**
 * Правка вне сюжета (пользователь, вкладка Files, входящий ящик): часть персонажа, которая в снимке совпадает с прежней
 * версией, заменяется новой — перегенерация и свайп её не откатывают. Снимки, где часть была другой (раньше по сюжету),
 * не трогаются: исправляется настройка, а не история.
 */
export function correctSnapshotPart(pool, snapshot, { key, part, from, to } = {}) {
    const character = snapshot?.greatBank?.[key];
    if (!character || typeof character !== 'object' || '$value' in character || !(part in character)) return { snapshot, changed: false };
    const current = snapshot.packed ? unpackValue(pool, character[part]) : character[part];
    if (json(current) !== json(from)) return { snapshot, changed: false };
    const value = snapshot.packed ? { $ref: refer(pool, to) } : JSON.parse(json(to));
    return { snapshot: { ...snapshot, greatBank: { ...snapshot.greatBank, [key]: { ...character, [part]: value } } }, changed: true };
}

/** Ссылки, на которые опираются снимки; всё прочее из пула можно выбросить. */
export function prunePool(pool, snapshots) {
    const used = new Set();
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.$ref === 'string') used.add(value.$ref);
        if (Array.isArray(value.$refs)) value.$refs.forEach(key => used.add(key));
        for (const inner of Object.values(value)) walk(inner);
    };
    for (const snapshot of Object.values(snapshots ?? {})) {
        walk(snapshot?.greatBank);
        walk(snapshot?.ledger);
        walk(snapshot?.window);
        walk(snapshot?.frozenWindows);
    }
    let removed = 0;
    for (const key of Object.keys(pool)) if (!used.has(key)) { delete pool[key]; removed += 1; }
    return removed;
}
