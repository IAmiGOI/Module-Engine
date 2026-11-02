import { CHARACTER_BANK_BUILDER, fillPrompt } from './decision-prompts.js';

/**
 * Дата-банки персонажей — чистые правила: источник → ключ и хеш, текст для
 * субагента, полоса размера, форма записи банка. Ни сети, ни хранения.
 */

const text = value => String(value ?? '').trim();

/** `key` — главный персонаж карточки и уровни библиотеки 1–2; остальные — `minor`. */
export function bankSizeBand({ level = null, isMain = false } = {}) {
    const value = Number(level);
    return isMain || (Number.isFinite(value) && value >= 1 && value <= 2) ? 'key' : 'minor';
}

/** FNV-1a: короткий стабильный хеш источника, без зависимостей. */
export function hashText(value) {
    let hash = 0x811c9dc5;
    const source = String(value ?? '');
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `h${hash.toString(16).padStart(8, '0')}`;
}

export function cardSourceKey(avatar) { return `card:${text(avatar)}`; }
export function sceneSourceKey(avatar) { return `scene:${text(avatar)}`; }
export function personaSourceKey(avatar) { return `persona:${text(avatar) || 'user'}`; }
export function lorebookSourceKey(book, uid) { return `lorebook:${text(book)}:${text(uid)}`; }

function joined(sections) {
    return sections.filter(([, value]) => text(value)).map(([label, value]) => `${label}:\n${text(value)}`).join('\n\n');
}

/** Карточка → текст источника. `system_prompt` и `mes_example` сюда не входят. */
export function cardSourceText(card = {}) {
    return joined([['Name', card.name], ['Description', card.description], ['Personality', card.personality], ['Instructions', card.post_history_instructions]]);
}

export function personaSourceText(persona = {}) {
    return joined([['Name', persona.name], ['Description', persona.description]]);
}

export function sceneSourceText(card = {}) {
    return text(card.scenario);
}

export function lorebookSourceText(entry = {}) {
    return joined([['Entry', entry.comment], ['Text', entry.content]]);
}

/** Запись банка: базовый слой и копия чата отличаются лишь `status`/`rawSource`. */
export function createBankRecord({ sourceKey, sourceKind, name, sourceHash, text: bankText = '', sizeBand = 'minor', rawSource = '', examples = '', status = 'pending', error = null, at = Date.now() }) {
    return {
        sourceKey: String(sourceKey ?? ''), sourceKind: String(sourceKind ?? ''),
        name: text(name), sourceHash: String(sourceHash ?? ''), text: String(bankText ?? ''),
        sizeBand: sizeBand === 'key' ? 'key' : 'minor', rawSource: String(rawSource ?? ''), examples: String(examples ?? ''),
        status: ['ready', 'pending', 'error', 'short'].includes(status) ? status : 'pending',
        error: error ? String(error) : null, updatedAt: Number(at) || Date.now(),
    };
}

export function bankIsReady(record) { return Boolean(record && record.status === 'ready' && text(record.text)); }

export function bankMatches(record, sourceHash) {
    return Boolean(record && record.sourceHash === sourceHash);
}

/** Готовый промпт субагента для одного источника. */
export function bankPromptFor({ name, sourceKind, source, canonHint = '', sizeBand = 'minor', steps = 20 }) {
    return fillPrompt(CHARACTER_BANK_BUILDER, {
        name: text(name) || 'Unknown', source_kind: sourceKind || 'card', source: text(source),
        canon_hint: text(canonHint), size_band: sizeBand === 'key' ? 'key' : 'minor', steps,
        // Name Literal в промпте называет сам макрос — он должен остаться буквальным.
        char: '{{char}}',
    });
}

function dividerOf(entry) {
    const firstLine = text(entry?.content).split('\n')[0];
    for (const line of [text(entry?.comment), firstLine]) {
        const match = /^\s*--\s*(.+?)\s*--\s*$/.exec(line);
        if (match) return match[1];
    }
    return '';
}

const CHARACTER_SECTION = /character|персонаж|people|cast/i;
const CHARACTER_PREFIX = /^(character|персонаж)\s*[:\-]/i;

/**
 * Записи-персонажи лорбука: раздел вида `-- CHARACTERS --` открывает секцию,
 * следующая строка-разделитель закрывает. Явный префикс `Character:` тоже
 * считается персонажем. Порядок — по `uid` внутри книги.
 */
export function characterLorebookEntries(entries) {
    const byBook = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const book = text(entry?.book) || 'Lorebook';
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(entry);
    }
    const found = [];
    for (const [book, list] of byBook) {
        const ordered = [...list].sort((a, b) => (Number(a?.uid) || 0) - (Number(b?.uid) || 0));
        let inCharacters = false;
        for (const entry of ordered) {
            if (!entry || entry.disable) continue;
            const divider = dividerOf(entry);
            if (divider) {
                inCharacters = CHARACTER_SECTION.test(divider);
                continue;
            }
            const explicit = CHARACTER_PREFIX.test(text(entry.comment));
            if ((inCharacters || explicit) && text(entry.content)) found.push({ ...entry, book });
        }
    }
    return found;
}

/** Все источники чата: карточка (и сцена), записи-персонажи лорбука, персона. */
export function bankSourcesForChat({ cards = [], persona = null, lorebookEntries = [] } = {}) {
    const sources = [];
    (Array.isArray(cards) ? cards : []).forEach((card, index) => {
        const avatar = text(card?.avatar) || text(card?.name) || `card_${index}`;
        const source = cardSourceText(card);
        if (source) sources.push({ sourceKey: cardSourceKey(avatar), sourceKind: 'card', name: text(card.name) || avatar, source, sizeBand: bankSizeBand({ isMain: index === 0 }), avatar, examples: String(card.mes_example ?? '') });
        const scene = sceneSourceText(card);
        if (scene) sources.push({ sourceKey: sceneSourceKey(avatar), sourceKind: 'scene', name: 'World / Scene', source: scene, sizeBand: 'key', avatar });
    });
    if (persona && personaSourceText(persona)) {
        sources.push({ sourceKey: personaSourceKey(persona.avatar), sourceKind: 'persona', name: text(persona.name) || 'User', source: personaSourceText(persona), sizeBand: 'key', avatar: text(persona.avatar) });
    }
    for (const entry of characterLorebookEntries(lorebookEntries)) {
        const source = lorebookSourceText(entry);
        if (!source) continue;
        sources.push({ sourceKey: lorebookSourceKey(entry.book, entry.uid), sourceKind: 'lorebook entry', name: text(entry.comment) || `Entry ${entry.uid}`, source, sizeBand: 'minor' });
    }
    const seen = new Set();
    return sources.filter(source => (seen.has(source.sourceKey) ? false : (seen.add(source.sourceKey), true)));
}

export function findBankSource(sources, name) {
    const wanted = text(name).toLowerCase();
    if (!wanted) return null;
    const exact = (Array.isArray(sources) ? sources : []).filter(source => source.name.toLowerCase() === wanted);
    return exact.find(source => source.sourceKind === 'card') ?? exact[0] ?? null;
}
