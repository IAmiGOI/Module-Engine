import { TRIGGER_MODES, computeTriggers } from './trigger-modes.js';

/**
 * «Создать по описанию» для гида (cores/guide): чистые функции без DOM и шины. Модель предлагает трекер, макрос или запись лорбука блоком
 * ```proposal``` с параметрами; здесь параметры приводятся к настоящей записи движка (или отвергаются с понятной причиной), а по ней же строится
 * ОПИСАНИЕ для человека — то, что он увидит на карточке перед нажатием «Apply». Карточка показывает не слова модели, а то, что реально запишется.
 */

export const CREATE_ACTIONS = Object.freeze(['tracker.create', 'macro.create', 'lorebook.addEntry', 'lorebook.addEntries', 'lorebook.createBook']);

const LIMITS = Object.freeze({ fields: 12, prompt: 300, defaultText: 80, macroText: 2000, macroCode: 4000, keys: 8, key: 40, content: 4000, title: 80 });
const TRACKER_WHEN = TRIGGER_MODES.map(mode => mode.value);

const text = (value, max) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');
export const slug = (value, max = 32) => text(value, 200).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
const fail = error => ({ ok: false, error });

/** Параметры трекера → запись для `tracking.configure` (без `workerId`: его подставляет действие) либо `{ ok: false, error }`. */
export function normalizeTracker(params = {}) {
    const id = slug(params.id || params.title);
    if (!id) return fail('The tracker needs a name.');
    const seen = new Set();
    const fields = [];
    for (const raw of Array.isArray(params.fields) ? params.fields : []) {
        const name = slug(typeof raw === 'string' ? raw : raw?.name, 24);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const fallback = raw?.default;
        fields.push({
            name,
            prompt: text(raw?.prompt, LIMITS.prompt),
            default: typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : text(fallback, LIMITS.defaultText),
        });
    }
    if (!fields.length) return fail('The tracker needs at least one field.');
    if (fields.length > LIMITS.fields) return fail(`A tracker holds at most ${LIMITS.fields} fields.`);
    const when = TRACKER_WHEN.includes(params.when) ? params.when : 'everyReply';
    const every = Math.min(50, Math.max(1, Math.round(Number(params.every) || 1)));
    const mode = when === 'everyReply' && every > 1 ? 'everyNReplies' : when;
    return { ok: true, value: { id, kind: 'user', enabled: true, fields, triggers: computeTriggers(mode, every), when: mode, every } };
}

/** Параметры макроса → программа для `macros.configure` либо ошибка. `{ name, text }` — фиксированный текст; `{ name, code }` — программа на языке макросов. */
export function normalizeMacro(params = {}) {
    const macroName = text(params.name, 32).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
    if (!/^[A-Za-z]/.test(macroName)) return fail('The macro needs a name made of letters, digits and underscores, starting with a letter.');
    const code = text(params.code, LIMITS.macroCode);
    const source = code || text(params.text, LIMITS.macroText);
    if (!source) return fail('The macro is empty.');
    return { ok: true, value: { id: `macro_${macroName.toLowerCase()}`, macroName, name: macroName, kind: code ? 'code' : 'text', source, triggers: [] } };
}

/** Параметры записи лорбука → патч для `lorebook.createEntry` либо ошибка. */
export function normalizeLorebookEntry(params = {}) {
    const content = text(params.content, LIMITS.content);
    if (!content) return fail('The entry has no text.');
    const always = params.always === true;
    const keys = [...new Set((Array.isArray(params.keys) ? params.keys : []).map(key => text(key, LIMITS.key)).filter(Boolean))].slice(0, LIMITS.keys);
    if (!keys.length && !always) return fail('Give the entry at least one trigger word (or make it always active).');
    return { ok: true, value: { comment: text(params.title, LIMITS.title) || keys[0] || 'Entry', key: keys, content, constant: always } };
}

/** Новая книга: только имя (проверку занятости и знаков делает Сервис). */
export function normalizeLorebookBook(params = {}) {
    const name = text(params.name ?? params.book ?? params.title, 80);
    return name ? { ok: true, value: { name, avatar: text(params.avatar, 200) } } : fail('The lorebook needs a name.');
}

/** Пакет записей: до 20, каждая проверяется как одиночная; хотя бы одна должна быть годной. */
export function normalizeLorebookEntries(params = {}) {
    const items = (Array.isArray(params.entries) ? params.entries : []).slice(0, 20).map(item => normalizeLorebookEntry(item ?? {}));
    const good = items.filter(item => item.ok).map(item => item.value);
    return good.length ? { ok: true, value: { book: text(params.book, 80), entries: good } } : fail('No entry in the list is usable: each needs text and a trigger word.');
}

const NORMALIZERS = Object.freeze({ 'tracker.create': normalizeTracker, 'macro.create': normalizeMacro, 'lorebook.addEntry': normalizeLorebookEntry, 'lorebook.createBook': normalizeLorebookBook, 'lorebook.addEntries': normalizeLorebookEntries });

const WHEN_LABEL = Object.freeze(Object.fromEntries(TRIGGER_MODES.map(mode => [mode.value, mode.label.toLowerCase()])));

/** Что покажет карточка предложения: `{ ok, title, lines }` либо `{ ok: false, error }`. Только по нормализованной записи — то, что покажем, то и запишется. */
export function describeProposal(action, params) {
    const normalize = NORMALIZERS[action];
    if (!normalize) return fail(`Unknown proposal "${action}".`);
    const result = normalize(params ?? {});
    if (!result.ok) return result;
    const { value } = result;
    if (action === 'tracker.create') {
        const poll = value.when === 'everyNReplies' ? `every ${value.every} replies` : WHEN_LABEL[value.when] ?? value.when;
        return {
            ok: true, title: `Tracker “${value.id}”`,
            lines: [...value.fields.map(field => `${field.name}${field.default === '' ? '' : ` (starts at ${field.default})`} — ${field.prompt || 'the model decides from the chat'}`), `Updated: ${poll}.`],
        };
    }
    if (action === 'macro.create') {
        return { ok: true, title: `Macro {{${value.macroName}}}`, lines: [value.kind === 'code' ? 'A small program:' : 'Inserts the text:', value.source.slice(0, 240)] };
    }
    if (action === 'lorebook.createBook') return { ok: true, title: `Lorebook “${value.name}”`, lines: ['A new empty lorebook.'] };
    if (action === 'lorebook.addEntries') return { ok: true, title: `${value.entries.length} lorebook entries`, lines: value.entries.map(entry => entry.comment).slice(0, 12) };
    return {
        ok: true, title: `Lorebook entry “${value.comment}”`,
        lines: [value.constant ? 'Always active.' : `Triggers on: ${value.key.join(', ')}.`, value.content.slice(0, 240)],
    };
}

export { NORMALIZERS };
