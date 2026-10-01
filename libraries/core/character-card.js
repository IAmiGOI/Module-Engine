/**
 * Карточка персонажа SillyTavern (Character Card V2): чистые функции без ввода-вывода — пределы полей, приведение присланного к записи,
 * разбор сырого JSON ST, тела запросов `create` / `merge-attributes` и слияние вложенной книги мира. Картинка аватара сюда не входит.
 *
 * Плоский вид (`fields`) называет поля по V2: name, description, personality, scenario, first_mes, mes_example, creator_notes, system_prompt,
 * post_history_instructions, alternate_greetings[], tags[], creator, character_version, talkativeness, fav, world, depth_prompt{prompt,depth,role},
 * character_book{name,description,scan_depth,token_budget,recursive_scanning,entries[]}, extensions{}.
 */

export const TEXT_FIELD_LIMITS = Object.freeze({
    name: 200, description: 40000, personality: 20000, scenario: 20000, first_mes: 20000, mes_example: 30000, creator_notes: 20000,
    system_prompt: 20000, post_history_instructions: 20000, creator: 200, character_version: 100, world: 200,
});
export const CARD_LIMITS = Object.freeze({ greetings: 40, greetingLength: 20000, tags: 50, tagLength: 60, bookEntries: 300, entryContentLength: 10000, entryKeys: 30, keyLength: 100, extensionsJsonLength: 20000, depthPromptLength: 20000 });
export const DEPTH_PROMPT_ROLES = Object.freeze(['system', 'user', 'assistant']);
export const CARD_FIELD_NAMES = Object.freeze([...Object.keys(TEXT_FIELD_LIMITS), 'alternate_greetings', 'tags', 'talkativeness', 'fav', 'depth_prompt', 'character_book', 'extensions']);

const BOOK_META_FIELDS = Object.freeze(['name', 'description', 'scan_depth', 'token_budget', 'recursive_scanning']);
// Эти ключи `extensions` движок ведёт отдельными полями; в общий `extensions` их класть нельзя, иначе два поля спорят за одно значение.
const FIELD_OWNED_EXTENSION_KEYS = Object.freeze(['talkativeness', 'fav', 'world', 'depth_prompt']);
// Только эти корневые поля и `data` ST принимает обратно при откате; остальное (чаты, дата создания, путь аватара) откат трогать не должен.
const RESTORABLE_ROOT_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creatorcomment', 'tags', 'talkativeness', 'fav']);

const buildRefusal = error => ({ ok: false, error });
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, maxLength) => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\r\n/g, '\n').trim().slice(0, maxLength) : undefined);
const cleanTextList = (value, maxItems, maxItemLength) => [...new Set((Array.isArray(value) ? value : []).map(item => cleanText(item, maxItemLength)).filter(Boolean))].slice(0, maxItems);
const clampInteger = (value, min, max) => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Math.min(max, Math.max(min, Math.round(Number(value)))) : undefined);
const asBoolean = value => (typeof value === 'boolean' ? value : undefined);

function normalizeBookEntry(raw, index, isNewBook) {
    if (!isPlainObject(raw)) return buildRefusal(`Lorebook entry ${index + 1} is not an object.`);
    const entry = {};
    const id = clampInteger(raw.id, 0, 1e9);
    if (id !== undefined) entry.id = id;
    const name = cleanText(raw.name ?? raw.comment ?? raw.title, 120);
    if (name !== undefined) { entry.name = name; entry.comment = name; }
    if (raw.keys !== undefined) entry.keys = cleanTextList(raw.keys, CARD_LIMITS.entryKeys, CARD_LIMITS.keyLength);
    if (raw.secondary_keys !== undefined) entry.secondary_keys = cleanTextList(raw.secondary_keys, CARD_LIMITS.entryKeys, CARD_LIMITS.keyLength);
    if (raw.content !== undefined) entry.content = cleanText(raw.content, CARD_LIMITS.entryContentLength) ?? '';
    for (const key of ['enabled', 'constant', 'selective', 'case_sensitive']) if (asBoolean(raw[key]) !== undefined) entry[key] = raw[key];
    const insertionOrder = clampInteger(raw.insertion_order, -10000, 10000);
    if (insertionOrder !== undefined) entry.insertion_order = insertionOrder;
    const priority = clampInteger(raw.priority, -10000, 10000);
    if (priority !== undefined) entry.priority = priority;
    if (raw.position === 'before_char' || raw.position === 'after_char') entry.position = raw.position;
    // Запись без id — новая: без текста и ключей она ничего не даёт и только засоряет книгу.
    if (isNewBook || id === undefined) {
        if (!entry.content) return buildRefusal(`Lorebook entry ${index + 1} has no text.`);
        if (!(entry.keys?.length) && entry.constant !== true) return buildRefusal(`Lorebook entry ${index + 1} needs trigger keys (or "constant": true).`);
    }
    return { ok: true, value: entry };
}

function normalizeBook(raw, isNewBook) {
    if (!isPlainObject(raw)) return buildRefusal('character_book must be an object.');
    const book = {};
    const name = cleanText(raw.name, 120);
    if (name !== undefined) book.name = name;
    const description = cleanText(raw.description, 2000);
    if (description !== undefined) book.description = description;
    for (const [key, min, max] of [['scan_depth', 0, 1000], ['token_budget', 0, 100000]]) {
        const value = clampInteger(raw[key], min, max);
        if (value !== undefined) book[key] = value;
    }
    if (asBoolean(raw.recursive_scanning) !== undefined) book.recursive_scanning = raw.recursive_scanning;
    const incoming = Array.isArray(raw.entries) ? raw.entries : [];
    if (incoming.length > CARD_LIMITS.bookEntries) return buildRefusal(`A card lorebook holds at most ${CARD_LIMITS.bookEntries} entries.`);
    const entries = [];
    for (const [index, item] of incoming.entries()) {
        const made = normalizeBookEntry(item, index, isNewBook);
        if (!made.ok) return made;
        entries.push(made.value);
    }
    if (raw.entries !== undefined || isNewBook) book.entries = entries;
    if (!isNewBook) book.removeEntries = (Array.isArray(raw.removeEntries) ? raw.removeEntries : []).map(id => clampInteger(id, 0, 1e9)).filter(id => id !== undefined);
    return { ok: true, value: book };
}

/**
 * Присланное моделью → `{ ok, value: fields }` (только названные поля) либо `{ ok: false, error }`. Неизвестное поле — отказ с перечнем настоящих:
 * молча выбросить его нельзя, человек решит, что оно записалось.
 */
export function normalizeCardFields(params = {}, { isNewCard = false } = {}) {
    if (!isPlainObject(params)) return buildRefusal('The card needs its fields.');
    const unknown = Object.keys(params).filter(key => !CARD_FIELD_NAMES.includes(key) && key !== 'avatar');
    if (unknown.length) return buildRefusal(`Unknown character field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The fields are: ${CARD_FIELD_NAMES.join(', ')}.`);
    const fields = {};
    for (const [key, maxLength] of Object.entries(TEXT_FIELD_LIMITS)) {
        if (params[key] === undefined) continue;
        const value = cleanText(params[key], maxLength);
        if (value === undefined) return buildRefusal(`"${key}" must be text.`);
        fields[key] = value;
    }
    if ((fields.name !== undefined || isNewCard) && !fields.name) return buildRefusal('The character needs a name.');
    if (params.alternate_greetings !== undefined) {
        if (!Array.isArray(params.alternate_greetings)) return buildRefusal('"alternate_greetings" must be a list of texts.');
        fields.alternate_greetings = cleanTextList(params.alternate_greetings, CARD_LIMITS.greetings, CARD_LIMITS.greetingLength);
    }
    if (params.tags !== undefined) fields.tags = cleanTextList(Array.isArray(params.tags) ? params.tags : String(params.tags).split(','), CARD_LIMITS.tags, CARD_LIMITS.tagLength);
    if (params.talkativeness !== undefined) {
        const value = Number(params.talkativeness);
        if (!Number.isFinite(value)) return buildRefusal('"talkativeness" is a number from 0 to 1.');
        fields.talkativeness = Math.min(1, Math.max(0, Math.round(value * 100) / 100));
    }
    if (params.fav !== undefined) {
        if (asBoolean(params.fav) === undefined) return buildRefusal('"fav" is true or false.');
        fields.fav = params.fav;
    }
    if (params.depth_prompt !== undefined) {
        if (!isPlainObject(params.depth_prompt)) return buildRefusal('"depth_prompt" is {"prompt", "depth", "role"}.');
        const depthPrompt = {};
        const prompt = cleanText(params.depth_prompt.prompt, CARD_LIMITS.depthPromptLength);
        if (prompt !== undefined) depthPrompt.prompt = prompt;
        const depth = clampInteger(params.depth_prompt.depth, 0, 999);
        if (depth !== undefined) depthPrompt.depth = depth;
        if (DEPTH_PROMPT_ROLES.includes(params.depth_prompt.role)) depthPrompt.role = params.depth_prompt.role;
        fields.depth_prompt = depthPrompt;
    }
    if (params.character_book !== undefined) {
        const book = normalizeBook(params.character_book, isNewCard);
        if (!book.ok) return book;
        fields.character_book = book.value;
    }
    if (params.extensions !== undefined) {
        if (!isPlainObject(params.extensions)) return buildRefusal('"extensions" must be an object.');
        const extra = Object.fromEntries(Object.entries(params.extensions).filter(([key]) => !FIELD_OWNED_EXTENSION_KEYS.includes(key)));
        if (JSON.stringify(extra).length > CARD_LIMITS.extensionsJsonLength) return buildRefusal('"extensions" is too large.');
        fields.extensions = extra;
    }
    if (!isNewCard && !Object.keys(fields).length) return buildRefusal('Nothing to change in the character.');
    return { ok: true, value: fields };
}

/** Сырой JSON ST (V2 во вложенном `data`, V1 плоско) → плоский вид. Плоское поле в приоритете: ST уже привёл его к единому виду. */
export function computeFlatCard(raw = {}) {
    const data = isPlainObject(raw.data) ? raw.data : {};
    const extensions = isPlainObject(data.extensions) ? data.extensions : {};
    const pickText = key => String(raw[key] ?? data[key] ?? '');
    const talkativeness = Number(extensions.talkativeness ?? raw.talkativeness);
    const { talkativeness: _owned1, fav: _owned2, world, depth_prompt: depthPrompt, ...otherExtensions } = extensions;
    return {
        name: String(raw.name ?? data.name ?? ''),
        description: pickText('description'), personality: pickText('personality'), scenario: pickText('scenario'),
        first_mes: pickText('first_mes'), mes_example: pickText('mes_example'),
        creator_notes: String(data.creator_notes ?? raw.creatorcomment ?? ''), system_prompt: String(data.system_prompt ?? ''),
        post_history_instructions: String(data.post_history_instructions ?? ''), creator: String(data.creator ?? ''), character_version: String(data.character_version ?? ''),
        alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.map(String) : [],
        tags: Array.isArray(data.tags) ? data.tags.map(String) : Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        talkativeness: Number.isFinite(talkativeness) ? talkativeness : 0.5,
        fav: Boolean(extensions.fav ?? raw.fav), world: String(world ?? ''),
        depth_prompt: {
            prompt: String(depthPrompt?.prompt ?? ''),
            depth: Number.isFinite(Number(depthPrompt?.depth)) ? Number(depthPrompt.depth) : 4,
            role: DEPTH_PROMPT_ROLES.includes(depthPrompt?.role) ? depthPrompt.role : 'system',
        },
        character_book: isPlainObject(data.character_book) ? data.character_book : null,
        extensions: otherExtensions,
    };
}

/**
 * Форма `/api/characters/create` несёт ТОЛЬКО имя: multipart превращает каждый перевод строки в CRLF, и `` остался бы в описании, которое читает модель.
 * Всё остальное пишется следом слиянием JSON (`buildMergeBody`), где переводы строк и числа остаются как есть.
 */
export function buildCreateForm(fields) {
    return { ch_name: fields.name };
}

/**
 * Тело `/api/characters/merge-attributes` (без `avatar`). ST держит поля и плоско (V1), и в `data` (V2), поэтому пишем оба: иначе читатель старого
 * вида увидит старое значение. Массивы ST заменяет целиком, объекты сливает по ключам — это и позволяет менять только названное.
 */
export function buildMergeBody(fields, book) {
    const body = {};
    const data = {};
    const extensions = {};
    for (const key of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
        if (fields[key] !== undefined) { body[key] = fields[key]; data[key] = fields[key]; }
    }
    for (const key of ['system_prompt', 'post_history_instructions', 'creator', 'character_version']) if (fields[key] !== undefined) data[key] = fields[key];
    if (fields.creator_notes !== undefined) { body.creatorcomment = fields.creator_notes; data.creator_notes = fields.creator_notes; }
    if (fields.tags !== undefined) { body.tags = fields.tags; data.tags = fields.tags; }
    if (fields.alternate_greetings !== undefined) data.alternate_greetings = fields.alternate_greetings;
    if (fields.talkativeness !== undefined) { body.talkativeness = fields.talkativeness; extensions.talkativeness = fields.talkativeness; }
    if (fields.fav !== undefined) { body.fav = fields.fav; extensions.fav = fields.fav; }
    if (fields.world !== undefined) extensions.world = fields.world;
    if (fields.depth_prompt !== undefined) extensions.depth_prompt = fields.depth_prompt;
    Object.assign(extensions, fields.extensions ?? {});
    if (book) data.character_book = book;
    if (Object.keys(extensions).length) data.extensions = extensions;
    if (Object.keys(data).length) body.data = data;
    return body;
}

/** Тело слияния, возвращающее карточку к снимку: только поля, которые ST принимает обратно (см. RESTORABLE_ROOT_FIELDS), и вся `data`. */
export function buildRestoreBody(rawSnapshot = {}) {
    const body = {};
    for (const key of RESTORABLE_ROOT_FIELDS) if (rawSnapshot[key] !== undefined) body[key] = rawSnapshot[key];
    if (isPlainObject(rawSnapshot.data)) body.data = structuredClone(rawSnapshot.data);
    return body;
}

/** Книга после правки. Записи по id дополняются (их `extensions` — вероятность, глубина от ST — сохраняются), новые получают следующий id, удалённые уходят. */
export function computeBookAfterPatch(existingBook, patch) {
    const existing = isPlainObject(existingBook) ? existingBook : {};
    const removedIds = new Set(patch.removeEntries ?? []);
    const entries = (Array.isArray(existing.entries) ? existing.entries : []).filter(entry => !removedIds.has(entry.id)).map(entry => ({ ...entry }));
    let nextId = entries.reduce((max, entry) => Math.max(max, Number.isInteger(entry.id) ? entry.id : -1), -1) + 1;
    for (const incoming of patch.entries ?? []) {
        const position = incoming.id === undefined ? -1 : entries.findIndex(entry => entry.id === incoming.id);
        if (position >= 0) { entries[position] = { ...entries[position], ...incoming }; continue; }
        if (!incoming.content) return buildRefusal(`There is no lorebook entry ${incoming.id} to change, and a new one needs text.`);
        entries.push({ keys: [], secondary_keys: [], content: '', enabled: true, insertion_order: 100, case_sensitive: false, constant: false, selective: false, position: 'before_char', extensions: {}, ...incoming, id: nextId });
        nextId += 1;
    }
    const meta = Object.fromEntries(BOOK_META_FIELDS.filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));
    return { ok: true, value: { extensions: {}, ...existing, ...meta, entries } };
}

/** Какие поля различаются в двух плоских видах — для списка версий: человеку важно, что именно менялось. */
export function computeChangedFieldNames(before, after) {
    return CARD_FIELD_NAMES.filter(key => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
}
