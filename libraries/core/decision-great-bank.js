import { lineBody, stampLine, lineIsPast, deadlineFrom, formatInstant } from './decision-bank-time.js';
import { MATERIAL_SECTIONS, SPIRITUAL_SECTIONS, DECREE_SECTIONS, OTHER_SPIRITUAL, ALL_SECTIONS, sectionsOf, otherSection, sectionLabel, resolveSection } from './decision-bank-sections.js';
import { decreeSections } from './decision-decree.js';

/**
 * Great Bank — разделы персонажа вне контекста модели. Чистые правила:
 * форма записи, правка строк «старое → новое», история правок. Ни хранения,
 * ни моделей: состояние приходит и уходит значением.
 *
 * Материальное: 1 внешний вид, 2 имущество, 3 факты из жизни, 4 предметы с
 * собой, 5 одежда, 6 способности, 7 другие предметные факты. Духовное:
 * 1 ценности, 2 предпочтения, 3 проявление эмоций, 4 потребности и цели,
 * 5 речь и мышление, 6 резолвинг. Указ — пять полей, отдельный блок.
 */

export {
    MATERIAL_SECTIONS, SPIRITUAL_SECTIONS, DECREE_SECTIONS, OTHER_SPIRITUAL, ALL_SECTIONS,
    sectionsOf, otherSection, sectionLabel, resolveSection, IMPORTANCE_LEVELS,
} from './decision-bank-sections.js';

const text = value => String(value ?? '').trim();

/** Персонаж пользователя (из персоны): ни Указа, ни важности — его поступки и планы только у пользователя. */
export const isUserCharacter = character => /^persona:/.test(text(character?.sourceKey));
export const USER_CHARACTER_NOTE = "is the user's character: they have no Decree and no standing — their deeds, words and plans are the user's own, and nobody writes them.";
export const bankKey = name => text(name).toLowerCase();

const partFilled = part => Object.values(part ?? {}).some(lines => Array.isArray(lines) && lines.some(line => text(line)));

/**
 * Психологу есть что писать: main/side, разделы готовы, material и spiritual
 * уже написаны, psyche.md ещё пуст. Персонаж пользователя — никогда.
 */
export function needsPsyche(character) {
    if (!text(character?.name) || isUserCharacter(character)) return false;
    if (!['main', 'side'].includes(character.importance)) return false;
    if (character.sectionsReady === false) return false;
    if ((Array.isArray(character.psyche) ? character.psyche : []).some(line => text(line))) return false;
    return partFilled(character.material) && partFilled(character.spiritual);
}

/** Служебные поля записи переживают нормализацию: по ним движок узнаёт пересборку банка. */
const EXTRAS = Object.freeze(['sourceKey', 'textHash', 'sectionsReady', 'fallbackText', 'decreeAt']);

export function normalizeImportance(value) {
    const clean = text(value).toLowerCase();
    if (['main', 'side', 'temporary', 'mass'].includes(clean)) return clean;
    if (clean === 'key') return 'main';
    if (clean === 'minor') return 'side';
    return 'side';
}

/** Пустая запись персонажа: разделы — списки строк. */
export function blankCharacter(name, { importance = 'side', aliases = [] } = {}) {
    return {
        name: text(name),
        aliases: [...new Set((Array.isArray(aliases) ? aliases : []).map(text).filter(Boolean))],
        importance: normalizeImportance(importance),
        material: Object.fromEntries(MATERIAL_SECTIONS.map(section => [section.no, []])),
        spiritual: Object.fromEntries(sectionsOf('spiritual').map(section => [section.no, []])),
        decree: Object.fromEntries(DECREE_SECTIONS.map(section => [section.no, []])),
        // psyche.md — механизмы и темп психики: строки, не разделы. Пишет только Психолог.
        psyche: [],
        // Knowledge — существующая система, привязанная к записи персонажа: форма та же, что у неё была.
        knowledge: { items: [] },
        history: [],
        pending: [],
    };
}

function cleanLines(value) {
    return (Array.isArray(value) ? value : []).map(line => text(line)).filter(Boolean);
}

/** Запись из хранилища — безопасная форма: мусор не ломает проекции. */
export function normalizeCharacter(value, fallbackName = '') {
    if (!value || typeof value !== 'object') return null;
    const name = text(value.name) || text(fallbackName);
    if (!name) return null;
    const blank = blankCharacter(name, { importance: value.importance, aliases: value.aliases });
    const material = value.material && typeof value.material === 'object' ? value.material : {};
    const spiritual = value.spiritual && typeof value.spiritual === 'object' ? value.spiritual : {};
    const decree = value.decree && typeof value.decree === 'object' ? value.decree : {};
    for (const section of MATERIAL_SECTIONS) blank.material[section.no] = cleanLines(material[section.no]);
    for (const section of sectionsOf('spiritual')) blank.spiritual[section.no] = cleanLines(spiritual[section.no]);
    const decreeNumbers = new Set([...DECREE_SECTIONS.map(section => section.no), ...Object.keys(decree).map(Number).filter(Number.isFinite)]);
    for (const no of decreeNumbers) blank.decree[no] = cleanLines(decree[no]);
    blank.psyche = Array.isArray(value.psyche) ? cleanLines(value.psyche) : [];
    const knowledge = value.knowledge && typeof value.knowledge === 'object' ? value.knowledge : {};
    blank.knowledge = { items: (Array.isArray(knowledge.items) ? knowledge.items : []).filter(item => item && typeof item === 'object' && text(item.id) && text(item.fact)) };
    blank.history = (Array.isArray(value.history) ? value.history : [])
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            at: text(item.at), by: text(item.by) || 'director', part: text(item.part), section: Number(item.section) || 0,
            old: text(item.old), new: text(item.new), comment: text(item.comment),
        }));
    blank.pending = (Array.isArray(value.pending) ? value.pending : [])
        .filter(item => item && typeof item === 'object')
        .map(item => ({ at: text(item.at), by: text(item.by) || 'resolver', part: text(item.part), section: Number(item.section) || 0, old: text(item.old), new: text(item.new), comment: text(item.comment) }));
    for (const key of EXTRAS) if (value[key] !== undefined) blank[key] = value[key];
    return blank;
}

export function normalizeGreatBank(value) {
    const out = {};
    for (const [key, record] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
        const character = normalizeCharacter(record, key);
        if (character) out[bankKey(key)] = character;
    }
    return out;
}

/** Персонаж по имени или псевдониму; регистр не важен. */
export function findCharacter(state, name) {
    const wanted = bankKey(name);
    if (!wanted) return null;
    const list = Array.isArray(state) ? state : Object.values(state ?? {});
    return list.find(character => [character.name, ...(character.aliases ?? [])].some(value => bankKey(value) === wanted)) ?? null;
}

/** Персонаж по имени; неизвестного движок создаёт сам — отказов нет. */
export function ensureCharacter(state, name, { importance = 'temporary' } = {}) {
    const found = findCharacter(state, name);
    if (found) return { state, character: found, created: false };
    const key = bankKey(name);
    const character = blankCharacter(name, { importance });
    return { state: { ...state, [key]: character }, character, created: true };
}

const normalizeLine = value => text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Ближайшая строка раздела: без учёта пробелов, регистра и знаков; ниже порога — null. */
export function nearestLine(lines, wanted) {
    const target = normalizeLine(wanted);
    if (!target) return null;
    const list = Array.isArray(lines) ? lines : [];
    const exact = list.findIndex(line => normalizeLine(lineBody(line)) === target);
    if (exact >= 0) return { index: exact, score: 1 };
    const want = new Set(target.split(' '));
    let best = null;
    list.forEach((line, index) => {
        const body = normalizeLine(lineBody(line));
        if (!body) return;
        const have = new Set(body.split(' '));
        const shared = [...want].filter(word => have.has(word)).length;
        const score = shared / Math.max(1, Math.min(want.size, have.size));
        if (score >= 0.5 && (!best || score > best.score)) best = { index, score };
    });
    return best;
}

export function sectionLines(character, part, no) {
    return character?.[part]?.[no] ?? [];
}

function setSectionLines(character, part, no, lines) {
    const next = { ...character, material: { ...character.material }, spiritual: { ...character.spiritual }, decree: { ...character.decree } };
    if (part === 'material') next.material[no] = lines;
    else if (part === 'spiritual') next.spiritual[no] = lines;
    else next.decree[no] = lines;
    return next;
}

/**
 * Номер без названия части выбирается по строке: Material и Spiritual
 * нумеруются с единицы, и `section: 4` сам по себе не говорит, какой это
 * раздел. Находится — в той части, где строка есть; нет ни в одной — в той,
 * где этот раздел уже наполнен, иначе в предметной.
 */
function resolveForEdit(edit, character) {
    const target = resolveSection(edit.section);
    if (!target.bareNumber || target.kind !== 'section') return target;
    const wanted = text(edit.old);
    if (wanted) {
        for (const part of ['material', 'spiritual']) {
            const lines = character?.[part]?.[target.no];
            if (lines && nearestLine(lines, wanted)) return { ...target, part };
        }
    }
    const filled = ['material', 'spiritual'].find(part => (character?.[part]?.[target.no] ?? []).length);
    return filled ? { ...target, part: filled } : target;
}

/** Одна правка: строка заменяется, дописывается или удаляется; срок переводится в метку. */
/** Строка в часть, которая была пуста до этого вызова, — устоявшаяся константа персонажа: без метки RP-времени. */
const markLine = (line, at, until, stamp) => (stamp ? stampLine(line, at, until) : (lineBody(line) ? (until ? `${lineBody(line)} [until ${until}]` : lineBody(line)) : ''));
const partEmpty = (character, part) => !Object.values(character?.[part] ?? {}).some(lines => (lines ?? []).length);

function applyOne(character, edit, { at, nowValue, by, comment, timeOfDay = null, stamp = true }) {
    const target = resolveForEdit(edit, character);
    const old = text(edit.old);
    const next = text(edit.new);
    if (target.kind === 'knowledge') {
        return { character, change: { kind: 'knowledge', character: character.name, old, new: next, comment } };
    }
    // Указ хранится отдельно и инструмента ещё нет (фаза 4): правка не теряется, но и не пишется.
    if (target.kind === 'decree') {
        return { character, change: { kind: 'decree', character: character.name, pending: true, old, new: next, comment } };
    }
    const { part, no } = target;
    if (by === 'resolver' && part === 'spiritual') {
        const item = { at, by, part, section: no, old, new: next, comment };
        return {
            character: { ...character, pending: [...character.pending, item] },
            change: { kind: 'section', character: character.name, part, section: no, pending: true, old, new: next, comment },
        };
    }
    const lines = [...sectionLines(character, part, no)];
    const timeWords = text(edit.until) || text(edit.for);
    const untilValue = timeWords ? deadlineFrom(nowValue, timeWords, timeOfDay ?? undefined) : null;
    const until = untilValue === null ? '' : formatInstant(untilValue);
    let before = '';
    if (!old) {
        if (next) lines.push(markLine(next, at, until, stamp));
    } else {
        const found = nearestLine(lines, old);
        if (found) {
            before = lineBody(lines[found.index]);
            if (next) lines[found.index] = markLine(next, at, until, stamp);
            else lines.splice(found.index, 1);
        } else if (next) {
            lines.push(markLine(next, at, until, stamp));
        }
    }
    const updated = setSectionLines(character, part, no, lines);
    return {
        character: { ...updated, history: [...updated.history, { at, by, part, section: no, old: before, new: next, comment }] },
        change: { kind: 'section', character: character.name, part, section: no, pending: false, old: before, new: next, line: next ? markLine(next, at, until, stamp) : '' },
    };
}

/**
 * Один Указ → запись персонажа. Движок ставит метку RP-времени на строки;
 * прежние строки уходят в историю. Тот же Указ историю не плодит — только
 * обновляет метку времени.
 * @returns {{ state, character, changed: boolean, history: object[] }}
 */
export function applyDecree(state, decree, { at = '', comment = '', by = 'director', importance = 'temporary' } = {}) {
    let next = normalizeGreatBank(state);
    const ensured = ensureCharacter(next, decree?.character, { importance });
    next = ensured.state;
    const character = findCharacter(next, decree?.character);
    if (!character) return { state: next, character: null, changed: false, history: [] };
    if (isUserCharacter(character)) return { state: next, character, changed: false, history: [], refused: true };
    const sections = decreeSections(decree);
    const history = [];
    const decreeState = {};
    // Первый Указ персонажа — без меток времени: это то, каков он есть, а не новость хода.
    const firstDecree = partEmpty(character, 'decree');
    let changed = false;
    for (const section of DECREE_SECTIONS) {
        const before = character.decree?.[section.no] ?? [];
        const after = sections[section.no] ?? [];
        const same = before.map(line => lineBody(line)).join('\n') === after.map(line => lineBody(line)).join('\n');
        if (same) {
            decreeState[section.no] = before;
            continue;
        }
        changed = true;
        history.push({
            at, by, part: 'decree', section: section.no,
            old: before.map(line => lineBody(line)).join('\n'), new: after.join('\n'), comment,
        });
        decreeState[section.no] = after.map(line => (text(line) ? markLine(line, at, '', !firstDecree) : line)).filter(line => text(line));
    }
    const updated = {
        ...character,
        decree: decreeState,
        decreeAt: changed ? at : (character.decreeAt ?? at),
        history: [...character.history, ...history],
    };
    return { state: { ...next, [bankKey(character.name)]: updated }, character: updated, changed, history };
}

/** Несколько Указов одним вызовом; дубли имён отбрасываются разбором выше. */
export function applyDecrees(state, decrees, { at = '', comment = '', by = 'director' } = {}) {
    let next = state;
    const applied = [];
    for (const decree of Array.isArray(decrees) ? decrees : []) {
        const result = applyDecree(next, decree, { at, comment, by });
        next = result.state;
        applied.push({ character: result.character?.name ?? decree.character, changed: result.changed });
    }
    return { state: next, applied, at };
}

/**
 * Несколько правок одним вызовом, в том числе по разным персонажам.
 * @returns {{ state, changes: object[], created: string[], at: string }}
 */
export function applyEdits(state, { edits = [], comment = '', by = 'director', at = '', nowValue = 0, importance = 'temporary', timeOfDay = null } = {}) {
    let next = normalizeGreatBank(state);
    const start = next;
    const changes = [];
    const created = [];
    for (const edit of Array.isArray(edits) ? edits : []) {
        const name = text(edit?.character);
        if (!name) continue;
        const ensured = ensureCharacter(next, name, { importance });
        next = ensured.state;
        if (ensured.created) created.push(ensured.character.name);
        const character = findCharacter(next, name);
        // Пустая до вызова часть (первая запись банка) — без меток времени; дальнейшие правки — с метками.
        const target = resolveSection(edit?.section);
        const before = findCharacter(start, name);
        const stamp = !(target && target.part && (!before || partEmpty(before, target.part)));
        const applied = applyOne(character, edit, { at, nowValue, by, comment, timeOfDay, stamp });
        next = { ...next, [bankKey(character.name)]: applied.character };
        changes.push(applied.change);
    }
    return { state: next, changes, created, at: text(at) };
}

/** Разрешён ли раздел роли: резолвер правит предметным и знаниями. */
export function canEdit(by, part) {
    if (by !== 'resolver') return true;
    return part === 'material';
}

/** Строка раздела истекла к моменту — в проекциях помечается прошлым. */
export const lineExpired = (line, nowValue) => lineIsPast(line, nowValue);
