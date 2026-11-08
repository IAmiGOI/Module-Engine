import { renderScales, normalizeScaleSystems } from './decision-scales.js';

/**
 * Creation (Мироздание) — чистые правила огромного дата-банка мира, который
 * строит God. Формат — `DIRECTOR-SPEC.md`, раздел «Бог и Мироздание»:
 * шесть гарантированных разделов и сколько угодно свободных, каждый со своим
 * названием; Scales — структурно (см. `decision-scales.js`); у правки
 * раздела своя история с меткой RP-времени.
 *
 * Ни хранения, ни модели: состояние приходит и уходит значением.
 */

const text = value => String(value ?? '').trim();
const slug = value => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

/** Гарантированные разделы Creation, в порядке владельца. */
export const CREATION_SECTIONS = Object.freeze([
    { no: 1, key: 'geography', name: 'Geography', aliases: ['geography', 'география', 'the land', 'lands', 'places'] },
    {
        no: 2, key: 'spirituality', name: 'Spirituality and Culture',
        aliases: ['spirituality and culture', 'spirituality', 'culture', 'spiritual', 'religion', 'beliefs', 'culture and spirituality'],
    },
    { no: 3, key: 'scales', name: 'Scales', aliases: ['scales', 'systems of scales', 'systems', 'magic', 'rules', 'весы', 'системы весов'] },
    { no: 4, key: 'history', name: 'History', aliases: ['history', 'past', 'прошлое', 'история'] },
    { no: 5, key: 'politics', name: 'Politics and Conflicts', aliases: ['politics and conflicts', 'politics', 'conflicts', 'powers', 'власть', 'политика'] },
    { no: 6, key: 'user', name: 'The User in the World', aliases: ['the user in the world', 'user in the world', 'the user', 'user', 'пользователь в мире', 'место пользователя'] },
]);

export const CREATION_SECTION_NAMES = Object.freeze(CREATION_SECTIONS.map(section => section.name));
export const SCALES_KEY = 'scales';

const HISTORY_LIMIT = 100;

/** Раздел по номеру, точному имени, ключу или похожему слову; неизвестное — свободный. */
export function resolveCreationSection(value) {
    const clean = text(value).toLowerCase();
    if (!clean) return null;
    const byNo = /^\s*(\d)\b/.exec(clean);
    if (byNo) {
        const found = CREATION_SECTIONS.find(section => section.no === Number(byNo[1]));
        if (found) return { ...found, guaranteed: true };
    }
    const exact = CREATION_SECTIONS.find(section => section.key === slug(clean) || section.name.toLowerCase() === clean);
    if (exact) return { ...exact, guaranteed: true };
    const similar = CREATION_SECTIONS.find(section => section.aliases.some(alias => clean.includes(alias) || alias.includes(clean)));
    if (similar) return { ...similar, guaranteed: true };
    return { no: 0, key: slug(clean), name: text(value), guaranteed: false };
}

/** Один раздел: номер, название, текст, метка правки. */
export function normalizeSection(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const resolved = resolveCreationSection(source.title ?? source.name ?? source.key ?? '');
    const title = text(source.title) || resolved?.name || '';
    if (!title) return null;
    return {
        key: resolved?.key ?? slug(title),
        no: resolved?.guaranteed ? resolved.no : 0,
        title: resolved?.guaranteed ? resolved.name : title,
        guaranteed: resolved?.guaranteed !== false,
        text: String(source.text ?? '').trim(),
        at: text(source.at),
    };
}

/** Пустое Creation: шесть гарантированных разделов на месте, текста нет. */
export function blankCreation() {
    return {
        sections: CREATION_SECTIONS.map(section => ({
            key: section.key, no: section.no, title: section.name, guaranteed: true, text: '', at: '',
        })),
        scales: [],
        extra: [],
        history: [],
        snapshots: { at: '', seq: 0 },
    };
}

export function normalizeCreation(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const blank = blankCreation();
    // Свободные разделы приходят из `extra` (как их пишет applySection) и из `sections` — второй источник для старой записи.
    const given = [...(Array.isArray(source.sections) ? source.sections : []), ...(Array.isArray(source.extra) ? source.extra : [])]
        .map(normalizeSection).filter(Boolean);
    const byKey = new Map();
    for (const section of given) byKey.set(section.key, section);
    const sections = blank.sections.map(section => (byKey.has(section.key) && byKey.get(section.key).guaranteed ? byKey.get(section.key) : section));
    // Свободные разделы: всё, что не легло ни в один гарантированный.
    const free = given.filter(section => !section.guaranteed && !blank.sections.some(guaranteed => guaranteed.key === section.key));
    const snapshots = source.snapshots && typeof source.snapshots === 'object' ? source.snapshots : {};
    return {
        sections,
        scales: normalizeScaleSystems(source.scales),
        extra: free,
        history: (Array.isArray(source.history) ? source.history : [])
            .filter(item => item && typeof item === 'object')
            .map(item => ({ at: text(item.at), title: text(item.title), by: text(item.by) || 'god', old: text(item.old), new: text(item.new), comment: text(item.comment) })),
        snapshots: { at: text(snapshots.at), seq: Number(snapshots.seq) || 0 },
    };
}

/** Все разделы вместе: гарантированные, затем свободные. */
export function allSections(creation) {
    const state = normalizeCreation(creation);
    return [...state.sections, ...state.extra];
}

export function findSection(creation, title) {
    const resolved = resolveCreationSection(title);
    if (!resolved) return null;
    return allSections(creation).find(section => section.key === resolved.key) ?? null;
}

/** Чего не хватает: гарантированные разделы без текста и Scales без систем. */
export function missingSections(creation) {
    const state = normalizeCreation(creation);
    const missing = state.sections.filter(section => !text(section.text)).map(section => section.title);
    if (!state.scales.length) missing.push('Scales — no system is written yet');
    return missing;
}

export function isComplete(creation) {
    return missingSections(creation).length === 0;
}

/**
 * Запись раздела: новый текст заменяет прежний, прежний уходит в историю с
 * меткой RP-времени. Пустой текст — раздел остаётся пустым, история тоже
 * пишется: это честная правка.
 */
export function applySection(creation, { title, text: body = '', at = '', by = 'god', comment = '' } = {}) {
    const state = normalizeCreation(creation);
    const resolved = resolveCreationSection(title);
    if (!resolved) return { state, ok: false, error: 'A section needs a title.' };
    const value = String(body ?? '').trim();
    const existing = allSections(state).find(section => section.key === resolved.key);
    const before = text(existing?.text);
    const next = { key: resolved.key, no: resolved.guaranteed ? resolved.no : 0, title: resolved.guaranteed ? resolved.name : (text(title) || resolved.name), guaranteed: resolved.guaranteed, text: value, at: at || existing?.at || '' };
    const entry = { at: text(at), title: next.title, by, old: before, new: value, comment: text(comment) };
    const replace = list => (list.some(section => section.key === next.key)
        ? list.map(section => (section.key === next.key ? next : section))
        : [...list, next]);
    const history = [...state.history, entry].slice(-HISTORY_LIMIT);
    if (resolved.guaranteed) {
        return {
            state: { ...state, sections: state.sections.map(section => (section.key === next.key ? next : section)), history },
            ok: true, section: next,
        };
    }
    return { state: { ...state, extra: replace(state.extra), history }, ok: true, section: next };
}

/** Несколько разделов одним вызовом — в порядке вызова; тот же раздел дважды берёт последнее. */
export function applySections(creation, sections, { at = '', by = 'god', comment = '' } = {}) {
    let state = normalizeCreation(creation);
    const written = [];
    for (const item of Array.isArray(sections) ? sections : []) {
        const applied = applySection(state, { ...item, at, by, comment });
        if (!applied.ok) continue;
        state = applied.state;
        written.push(applied.section.title);
    }
    return { state, written };
}

/** Снимок стабильной части: Creation целиком и номер открытий на момент снимка. */
export function takeCreationSnapshot(creation, { at = '', seq = 0 } = {}) {
    return { ...normalizeCreation(creation), snapshots: { at: text(at), seq: Number(seq) || 0 } };
}

/** Creation → стабильная часть контекста резолвера: разделы целиком, затем Scales. */
export function renderCreation(creation) {
    const state = normalizeCreation(creation);
    const parts = [];
    const written = allSections(state).filter(section => text(section.text));
    if (written.length) {
        parts.push(written.map(section => `### ${section.title}\n${text(section.text)}`).join('\n\n'));
    }
    const scales = renderScales(state.scales);
    if (scales) parts.push(`### Scales — the systems of this world\n${scales}`);
    if (!parts.length) return '';
    return [
        'CREATION — the world the story stands in, and the rules it obeys. The Resolver plays every scene inside this world; what is written here is law.',
        ...parts,
    ].join('\n\n');
}
