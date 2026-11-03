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
/**
 * Версия сборщика банков. Банк старее этой версии не считается готовым и пересобирается: так банки, собранные, пока
 * веб-поиск субагента был сломан (в них лежала служебная строка «The researcher returned no report.»), уходят сами.
 */
export const BANK_BUILDER_VERSION = 3;

export function createBankRecord({ sourceKey, sourceKind, name, sourceHash, text: bankText = '', sizeBand = 'minor', rawSource = '', examples = '', aliases = [], canonicalName = '', status = 'pending', error = null, at = Date.now(), builderVersion = 0, timelineHash = '' }) {
    return {
        builderVersion: Number(builderVersion) || 0,
        sourceKey: String(sourceKey ?? ''), sourceKind: String(sourceKind ?? ''),
        name: text(name), sourceHash: String(sourceHash ?? ''), text: String(bankText ?? ''),
        timelineHash: String(timelineHash ?? ''),
        sizeBand: sizeBand === 'key' ? 'key' : 'minor', rawSource: String(rawSource ?? ''), examples: String(examples ?? ''),
        aliases: (Array.isArray(aliases) ? aliases : String(aliases ?? '').split(',')).map(item => text(item)).filter(Boolean),
        canonicalName: text(canonicalName) || text(name),
        status: ['ready', 'pending', 'error', 'short'].includes(status) ? status : 'pending',
        error: error ? String(error) : null, updatedAt: Number(at) || Date.now(),
    };
}

export function bankIsReady(record) {
    return Boolean(record && record.status === 'ready' && text(record.text) && (record.sourceKind === 'manual' || Number(record.builderVersion) >= BANK_BUILDER_VERSION));
}

export function bankMatches(record, sourceHash) {
    return Boolean(record && record.sourceHash === sourceHash);
}

/** Последняя строка банка `IMPORTANCE: key|minor` — решение сборщика; из текста она вырезается. */
export function splitBankImportance(value) {
    const lines = String(value ?? '').trimEnd().split('\n');
    for (let index = lines.length - 1; index >= Math.max(0, lines.length - 3); index -= 1) {
        const match = /^\W*importance\W*:\W*(key|minor)\W*$/i.exec(lines[index].trim());
        if (match) return { text: lines.filter((_, at) => at !== index).join('\n').trimEnd(), importance: match[1].toLowerCase() };
    }
    return { text: String(value ?? '').trim(), importance: null };
}

/** Готовый промпт субагента для одного источника; `sizeBand: 'key'` — нижняя граница важности. */
export function bankPromptFor({ name, sourceKind, source, canonHint = '', aliases = '', timeline = '', sizeBand = 'minor', steps = 20 }) {
    return fillPrompt(CHARACTER_BANK_BUILDER, {
        name: text(name) || 'Unknown', source_kind: sourceKind || 'card', source: text(source),
        canon_hint: text(canonHint), aliases: text(aliases), timeline: text(timeline), steps,
        importance_floor: sizeBand === 'key' ? 'This character is already key in this story. ' : '',
        // Name Literal в промпте называет сам макрос — он должен остаться буквальным.
        char: '{{char}}',
    });
}

function entryKeys(entry) {
    return [entry?.key, entry?.keys].flatMap(value => (Array.isArray(value) ? value : String(value ?? '').split(','))).map(text).filter(Boolean);
}

/** Все разделители книги в порядке появления — подсказка для разметки. */
export function lorebookSections(entries) {
    return [...new Set((Array.isArray(entries) ? entries : []).map(entry => dividerOf(entry)).filter(Boolean))];
}

/** Хеш списка записей книги: uid + название + ключи + текст. */
export function lorebookHash(entries) {
    const list = [...(Array.isArray(entries) ? entries : [])]
        .sort((a, b) => (Number(a?.uid) || 0) - (Number(b?.uid) || 0))
        .map(entry => `${entry?.uid}|${text(entry?.comment)}|${entryKeys(entry).join(',')}|${text(entry?.content)}`);
    return hashText(list.join('\n'));
}

/** Хеш одной записи: по нему разметка понимает, какие записи новые или изменились. */
export function lorebookEntryHash(entry) {
    return hashText(`${entry?.uid}|${text(entry?.comment)}|${entryKeys(entry).join(',')}|${text(entry?.content)}`);
}

/**
 * План разметки книги ПО ЗАПИСЯМ, а не по всей книге: граф памяти постоянно дописывает в лорбук новые записи, и
 * перемечать из-за этого всю книгу (сотни записей) было бы дорого. Директору уходят только новые и изменённые
 * записи; отметки неизменённых сохраняются, отметки удалённых пропадают. Старая запись хранилища без хешей записей,
 * совпадающая с книгой целиком, считается проверенной полностью.
 * @returns {{ toMark: object[], kept: object[], entryHashes: Record<string, string>, sourceHash: string }}
 */
export function planLorebookMarking(record, entries) {
    const list = Array.isArray(entries) ? entries : [];
    const entryHashes = Object.fromEntries(list.map(entry => [String(entry?.uid), lorebookEntryHash(entry)]));
    const sourceHash = lorebookHash(list);
    let reviewed = record?.entryHashes && typeof record.entryHashes === 'object' ? record.entryHashes : null;
    if (!reviewed && record?.sourceHash === sourceHash) reviewed = entryHashes;
    reviewed = reviewed ?? {};
    const toMark = list.filter(entry => reviewed[String(entry?.uid)] !== entryHashes[String(entry?.uid)]);
    const changed = new Set(toMark.map(entry => String(entry?.uid)));
    const kept = (Array.isArray(record?.marks) ? record.marks : [])
        .filter(mark => entryHashes[String(mark?.uid)] !== undefined && !changed.has(String(mark?.uid)));
    return { toMark, kept, entryHashes, sourceHash };
}

function bookMarkList(marks, book) {
    if (!marks || typeof marks !== 'object') return null;
    const record = marks[book];
    if (!record) return null;
    return Array.isArray(record) ? record : (Array.isArray(record.marks) ? record.marks : null);
}

/** Отмеченные директором записи: `{ entry, mark }`; для неразмеченной книги — запасной путь по разделам. */
export function markedLorebookCharacters(entries, marks = null) {
    const byBook = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const book = text(entry?.book) || 'Lorebook';
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(entry);
    }
    const found = [];
    for (const [book, list] of byBook) {
        const marked = bookMarkList(marks, book);
        if (marked) {
            const byUid = new Map(list.map(entry => [Number(entry.uid), entry]));
            for (const mark of marked) {
                const entry = byUid.get(Number(mark?.uid));
                if (entry && !entry.disable) found.push({ entry: { ...entry, book }, mark });
            }
        } else {
            for (const entry of characterLorebookEntries(list)) found.push({ entry: { ...entry, book }, mark: null });
        }
    }
    return found;
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
export function bankSourcesForChat({ cards = [], persona = null, lorebookEntries = [], lorebookMarks = null } = {}) {
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
    for (const { entry, mark } of markedLorebookCharacters(lorebookEntries, lorebookMarks)) {
        const source = lorebookSourceText(entry);
        if (!source) continue;
        const aliases = mark ? [...(Array.isArray(mark.aliases) ? mark.aliases : String(mark.aliases ?? '').split(','))].map(text).filter(Boolean) : entryKeys(entry);
        sources.push({
            sourceKey: lorebookSourceKey(entry.book, entry.uid), sourceKind: 'lorebook entry',
            name: text(mark?.name) || text(entry.comment) || `Entry ${entry.uid}`,
            canonicalName: text(entry.comment), aliases, canonHint: text(mark?.franchise),
            source, sizeBand: 'minor',
        });
    }
    const seen = new Set();
    return sources.filter(source => (seen.has(source.sourceKey) ? false : (seen.add(source.sourceKey), true)));
}

export function findBankSource(sources, name) {
    const wanted = text(name).toLowerCase();
    if (!wanted) return null;
    const aliases = source => (Array.isArray(source.aliases) ? source.aliases : String(source.aliases ?? '').split(',')).map(text).map(value => value.toLowerCase()).filter(Boolean);
    const exact = (Array.isArray(sources) ? sources : []).filter(source => text(source.name).toLowerCase() === wanted || aliases(source).includes(wanted));
    return exact.find(source => source.sourceKind === 'card') ?? exact[0] ?? null;
}


/** Банки → стабильная часть контекста. Ошибка/недосборка отдаёт сырой источник. */
export function renderBankSection(records) {
    const list = (Array.isArray(records) ? records : []).filter(record => record && (text(record.text) || text(record.rawSource)));
    if (!list.length) return '';
    const body = list.map(record => {
        // Банк в пересборке (старая версия сборщика, правка источника) работает своим прежним текстом.
        const content = text(record.text) || text(record.rawSource);
        const note = record.status === 'error' && !text(record.text) ? ' (bank rebuilding — the raw source is shown)' : record.status === 'short' ? ' (short bank — the full one is being built)' : '';
        return `### ${text(record.name) || 'Character'}${note}\n${content}`;
    }).join('\n\n');
    return `CHARACTER DATA BANKS (compact cards for the Writer and the Director):\n\n${body}`;
}

/** Примеры диалогов — не события, а образцы речи; идут в самое начало контекста. */
export function renderExampleSection(records) {
    const list = (Array.isArray(records) ? records : []).filter(record => text(record?.examples));
    if (!list.length) return '';
    return `EXAMPLE DIALOGUES (how these characters speak; this is not what happened before):\n\n${list.map(record => `### ${text(record.name)}\n${text(record.examples)}`).join('\n\n')}`;
}
