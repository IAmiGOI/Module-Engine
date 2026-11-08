import { renderPart } from './court-bank-files.js';
import { normalizeImportanceWord, normalizePetitions } from './decision-counsellor.js';
import { findCharacter, normalizeGreatBank } from './decision-great-bank.js';
import { libraryLevelsSection } from './decision-library.js';
import {
    DIRECTOR_DECREE_SYSTEM, DIRECTOR_DECREE_TASK, DIRECTOR_THINK_DECREE,
    REPORTS_HEADER, NO_REPORTS, LAST_DECREES_HEADER, TOUCHED_BANKS_HEADER, DIRECTOR_RP_HEADER,
} from './decision-prompts.js';

/**
 * Полу-слепой Director (часть 19): чистые правила. Что считать поводом,
 * кого касается отчёт, какие пять отчётов и какой CoT он видит. Ни модели,
 * ни хранения — ядро `cores/decision/director.js` только собирает из этого
 * контекст и ведёт цикл.
 */

const text = value => String(value ?? '').trim();
const keyOf = value => text(value).toLowerCase();
const unique = list => [...new Set((Array.isArray(list) ? list : []).map(text).filter(Boolean))];
const REPORT_LIMIT = 5;
const COT_LIMIT = 5;

const QUEUE_STATUS = new Set(['queued', 'delivered']);

/** Очередь Telegrams: у старых записей статуса нет — они считаются непрочитанными. */
export function queuedTelegrams(telegrams) {
    return (Array.isArray(telegrams) ? telegrams : [])
        .filter(item => item && typeof item === 'object' && text(item.text) && !['read', 'dismissed'].includes(text(item.status)));
}

/** Персонажи Main Cast без Указа — они получают его сразу. */
export function mainWithoutDecree(state) {
    const bank = normalizeGreatBank(state);
    return Object.values(bank)
        .filter(character => character.importance === 'main')
        .filter(character => ![1, 2, 3, 4, 5].some(no => (character.decree?.[no] ?? []).some(line => text(line))))
        .map(character => character.name);
}

/** Main Cast целиком — запасной круг для Телеграммы, где имя не названо прямо. */
export function mainCharacters(state) {
    return Object.values(normalizeGreatBank(state))
        .filter(character => character.importance === 'main')
        .map(character => character.name);
}

/** Имена, которые встречаются в тексте (по банку и псевдонимам, без регистра). */
export function namedCharacters(value, state) {
    const lower = keyOf(value);
    if (!lower) return [];
    return Object.values(normalizeGreatBank(state))
        .filter(character => [character.name, ...(character.aliases ?? [])].some(name => keyOf(name) && lower.includes(keyOf(name))))
        .map(character => character.name);
}

/**
 * Повод разбудить Director. Все поводы одного пробуждения обрабатываются
 * одним вызовом: Petition берёт все сразу, к ним добавляются Telegram,
 * Main Cast без Указа, повышения и конец дня.
 * @returns {{ wake: object, characters: string[], day: boolean, reasons: object[] } | null}
 */
export function directorReason({ petitions = [], telegrams = [], banks = {}, worldReady = true } = {}) {
    const queued = normalizePetitions(petitions).filter(item => QUEUE_STATUS.has(item.status));
    const telegramsOpen = queuedTelegrams(telegrams);
    const nameState = banks?.great ?? banks;
    const cast = worldReady ? mainWithoutDecree(nameState) : [];
    const promoted = queued.filter(item => item.promote && ['main', 'side'].includes(item.promote.level));
    const day = queued.filter(item => item.prepareNewDay);
    const reasons = [];
    if (queued.length) reasons.push({ type: 'petition', names: unique(queued.map(item => item.character)) });
    for (const telegram of telegramsOpen) {
        const named = namedCharacters(telegram.text, nameState);
        reasons.push({ type: 'telegram', text: text(telegram.text), names: named.length ? named : mainCharacters(nameState) });
    }
    if (cast.length) reasons.push({ type: 'cast', names: cast });
    if (promoted.length) reasons.push({ type: 'promotion', names: unique(promoted.map(item => item.character)) });
    if (day.length) reasons.push({ type: 'day', names: unique(day.map(item => item.character)) });
    if (!reasons.length) return null;

    const characters = unique([
        ...queued.map(item => item.character),
        ...cast,
        ...promoted.map(item => item.character),
        ...day.map(item => item.character),
        ...reasons.flatMap(reason => reason.names ?? []),
    ]);
    const urgent = reasons.find(reason => reason.type === 'day')
        ?? reasons.find(reason => reason.type === 'telegram')
        ?? reasons.find(reason => reason.type === 'petition')
        ?? reasons[0];
    const labels = {
        day: 'The Director prepares the new day',
        telegram: 'A Telegram reaches the Director',
        petition: 'Petitions reach the Director',
        cast: 'A Main Cast character has no Decree',
        promotion: 'A promotion needs a Decree',
    };
    const detail = [
        queued.length ? `${queued.length} petition(s): ${unique(queued.map(item => item.character)).join(', ')}` : '',
        telegramsOpen.length ? `${telegramsOpen.length} telegram(s)` : '',
        cast.length ? `Main Cast without a Decree: ${cast.join(', ')}` : '',
        promoted.length ? `promoted: ${unique(promoted.map(item => item.character)).join(', ')}` : '',
        day.length ? 'prepare the new day' : '',
    ].filter(Boolean).join('; ');
    return {
        wake: { type: 'director', label: labels[urgent.type], detail },
        characters,
        day: day.length > 0,
        reasons,
    };
}

/**
 * Последние отчёты: Petition (с отрывком Ведомости) и Telegram. Один отчёт —
 * одна запись; старые выпадают первыми.
 */
export function lastReports({ petitions = [], telegrams = [], limit = REPORT_LIMIT } = {}) {
    const list = [
        ...normalizePetitions(petitions).map(item => ({
            kind: 'petition', at: Number(item.at) || 0, character: item.character, problem: item.problem,
            excerpt: item.excerpt, promote: item.promote, day: item.prepareNewDay, status: item.status,
        })),
        ...queuedTelegrams(telegrams).map(item => ({
            kind: 'telegram', at: Number(item.at) || 0,
            problem: text(item.text), excerpt: '', blocked: Boolean(item.blocked),
        })),
    ].sort((a, b) => a.at - b.at);
    return list.slice(-Math.max(1, Number(limit) || REPORT_LIMIT));
}

/** Отчёт → строки контекста. */
export function renderReports(reports) {
    const list = Array.isArray(reports) ? reports : [];
    if (!list.length) return NO_REPORTS;
    return list.map(item => {
        if (item.kind === 'telegram') return `[Telegram] ${item.blocked ? '(blocks the next turn) ' : ''}${item.problem}`;
        const promote = item.promote ? `\nPromotion offered: ${item.promote.level} — ${item.promote.reason}` : '';
        const day = item.day ? '\nMarked: prepare the new day.' : '';
        return `[Petition] ${item.character}\n${item.problem}${promote}${day}${item.excerpt ? `\nLedger:\n${item.excerpt}` : ''}`;
    }).join('\n\n');
}

/** CoT самого Director за последние пять запусков — только он, без Указов и истории. */
export function lastDecreeThoughts(cycles, { limit = COT_LIMIT } = {}) {
    return (Array.isArray(cycles) ? cycles : [])
        .filter(cycle => cycle && ['decree', 'director_decree'].includes(cycle.event) && !cycle.rejected && text(cycle.thinking))
        .slice(-Math.max(1, Number(limit) || COT_LIMIT))
        .map(cycle => text(cycle.thinking));
}

export function renderThoughts(thoughts) {
    const list = Array.isArray(thoughts) ? thoughts.filter(Boolean) : [];
    return list.length ? `${LAST_DECREES_HEADER}\n\n${list.map(item => `---\n${item}`).join('\n')}` : '';
}

/** Уровни только затронутых персонажей. */
export function levelsFor(library, names) {
    const wanted = new Set((Array.isArray(names) ? names : []).map(keyOf));
    if (!wanted.size) return libraryLevelsSection(library);
    const filtered = Object.fromEntries(Object.entries(library && typeof library === 'object' ? library : {})
        .filter(([key, record]) => wanted.has(keyOf(key)) || wanted.has(keyOf(record?.name))));
    return libraryLevelsSection(filtered);
}

/** Полная проекция Great Bank затронутых; запись ищется по имени и псевдониму. */
export function touchedBankText(state, names) {
    const bank = normalizeGreatBank(state);
    const files = [];
    for (const name of unique(names)) {
        const character = findCharacter(bank, name);
        if (!character) continue;
        // Ровно как файлы инструментов `view` / `edit`: «old» в правке совпадает дословно.
        for (const part of ['material', 'spiritual', 'decree']) files.push(`### Characters/${character.name}/${part}.md\n${renderPart(character, part)}`);
        // Не разобранный банк — исходная карточка или запись лорбука: по ней Director пишет material.md и spiritual.md.
        if (String(character.fallbackText ?? '').trim()) files.push(`### Characters/${character.name}/card.md\n${String(character.fallbackText).trim()}`);
    }
    return files.join('\n\n');
}

/**
 * Контекст Director: система → банки затронутых и их уровни → собственный CoT
 * за пять запусков → последние пять отчётов → RP-время → задание.
 */
export function buildDirectorContext({ banks = {}, library = {}, characters = [], reports = [], thoughts = [], rpTime = '', reason = '', storySettings = '' } = {}) {
    const names = unique([...(Array.isArray(characters) ? characters : []), ...reports.flatMap(item => (item.kind === 'petition' ? [item.character] : []))]);
    const bankText = touchedBankText(banks, names);
    const levels = levelsFor(library, names);
    const task = `${fill(DIRECTOR_DECREE_TASK, { reason: reason || 'a report reached you' })}\n\n${DIRECTOR_THINK_DECREE}`;
    const messages = [{ role: 'system', content: DIRECTOR_DECREE_SYSTEM }];
    if (text(storySettings)) messages.push({ role: 'system', content: text(storySettings) });
    messages.push({ role: 'system', content: `${TOUCHED_BANKS_HEADER}\n\n${bankText || 'No data bank exists for the characters this report touches.'}` });
    if (levels) messages.push({ role: 'system', content: levels });
    const thoughtText = renderThoughts(thoughts);
    if (thoughtText) messages.push({ role: 'system', content: thoughtText });
    messages.push({ role: 'system', content: `${REPORTS_HEADER}\n\n${renderReports(reports)}` });
    messages.push({ role: 'system', content: `${DIRECTOR_RP_HEADER} ${rpTime || 'unknown'}` });
    messages.push({ role: 'user', content: task });
    return { messages, prompt: messages.map(message => message.content).join('\n\n') };
}

function fill(template, values) {
    return String(template).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match));
}

/** Решения по предложениям резолвера — безопасная форма. */
export function pendingDecisions(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && text(item.character))
        .map(item => ({ character: text(item.character), index: Math.max(0, Number(item.index) || 0), accept: item.accept !== false }));
}

/** Повышения из Petition — безопасная форма. */
export function importanceItems(value) {
    const levels = new Set(['main', 'side', 'temporary', 'mass']);
    return (Array.isArray(value) ? value : [])
        .map(item => ({ character: text(item?.character), importance: normalizeImportanceWord(item?.importance ?? item?.level) }))
        .filter(item => item.character && levels.has(item.importance));
}
