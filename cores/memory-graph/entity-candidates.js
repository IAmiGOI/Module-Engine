import { resolveSubject } from './subjects.js';

/**
 * Обнаружение сущностей без модели — чистые функции (граф не трогают).
 *
 * Пока имя героя ни разу не попало в `subjects` ответа модели, у него нет ноды, хотя оно повторяется в содержимом десятков записей
 * («Nyx» в семи записях и ни одной ноды Nyx). Здесь смотрим на сам текст нод: имя собственное — слово(а) с заглавной буквы
 * ВНУТРИ предложения и почти всегда именно так («Nyx» никогда не пишется со строчной); обычное слово («She», «This», «The»)
 * в тексте то же самое слово и со строчной, поэтому именем не считается — по статистике самого текста, без списков слов
 * и без привязки к языку. Кандидат — имя, которое встречается минимум в `minMentions` РАЗНЫХ нодах и ещё не разрешается
 * ни в какую существующую (`resolveSubject`: метка, псевдоним, слово метки).
 */

export const ENTITY_DEFAULTS = Object.freeze({ minMentions: 3, maxCandidates: 2 });

const RUN = /\p{Lu}[\p{L}\p{N}'’]*(?:[ \t]+\p{Lu}[\p{L}\p{N}'’]*)*/gu;
const OPENERS = new Set(['"', '“', '«', '„', '‘']);
const PROPER_SHARE = 0.6; // доля вхождений с заглавной внутри предложения, не меньше которой слово считается именем
const stripPossessive = token => token.replace(/['’]s$/iu, '').replace(/['’]$/u, '');

/** Начинается ли предложение в позиции `index` текста: начало текста, после `.!?…` / переноса строки / открывающей кавычки. */
function startsSentence(text, index) {
    let cursor = index - 1;
    while (cursor >= 0 && text[cursor] === ' ') cursor -= 1;
    if (cursor < 0) return true;
    const mark = text[cursor];
    return '.!?…:\n'.includes(mark) || OPENERS.has(mark);
}

/** Слова текста, написанные со строчной (для статистики «как часто это слово пишут не с заглавной»). */
function lowercaseWords(text) {
    return [...text.matchAll(/\p{Ll}[\p{L}\p{N}'’]*/gu)].map(match => stripPossessive(match[0]).toLowerCase());
}

/** Все «пробеги» слов с заглавной в тексте: `[{ tokens: ['Tea', 'Party'], initial }]`. */
function capitalRuns(text) {
    const runs = [];
    for (const match of text.matchAll(RUN)) {
        const tokens = match[0].split(/[ \t]+/).map(stripPossessive).filter(Boolean);
        if (tokens.length) runs.push({ tokens, initial: startsSentence(text, match.index) });
    }
    return runs;
}

/**
 * `nodes` — все ноды графа (`{ id, label, content, kind }`). Возвращает `[{ name, nodeIds }]` — кандидаты в сущности, самые
 * упоминаемые первыми; пусто — новых имён нет.
 */
export function findEntityCandidates(nodes, { minMentions = ENTITY_DEFAULTS.minMentions, maxCandidates = ENTITY_DEFAULTS.maxCandidates } = {}) {
    const list = Object.values(nodes).filter(node => node && (node.label || node.content));
    const texts = list.map(node => { const text = `${node.label ?? ''}. ${node.content ?? ''}`; return { id: node.id, runs: capitalRuns(text), plain: lowercaseWords(text) }; });

    // Слово «собственное», если оно встречается с заглавной ВНУТРИ предложения и такие вхождения составляют основную часть всех его
    // вхождений (со строчной оно почти не пишется). Заглавная только в начале предложения — ничего не доказывает.
    const capitalMid = new Map();
    const lower = new Map();
    for (const { runs, plain } of texts) {
        for (const run of runs) if (!run.initial) for (const token of run.tokens) { const key = token.toLowerCase(); capitalMid.set(key, (capitalMid.get(key) ?? 0) + 1); }
        for (const word of plain) lower.set(word, (lower.get(word) ?? 0) + 1);
    }
    const proper = new Set([...capitalMid].filter(([word, count]) => count / (count + (lower.get(word) ?? 0)) >= PROPER_SHARE).map(([word]) => word));

    const mentions = new Map(); // нормализованное имя → { name, nodeIds:Set }
    for (const { id, runs } of texts) {
        for (const run of runs) {
            let tokens = run.tokens;
            while (tokens.length && !proper.has(tokens[0].toLowerCase())) tokens = tokens.slice(1);
            while (tokens.length && !proper.has(tokens.at(-1).toLowerCase())) tokens = tokens.slice(0, -1);
            if (!tokens.length) continue;
            const name = tokens.join(' ');
            if (name.length < 3) continue;
            const key = name.toLowerCase();
            const entry = mentions.get(key) ?? { name, nodeIds: new Set() };
            entry.nodeIds.add(id);
            mentions.set(key, entry);
        }
    }

    const byId = new Map(list.map(node => [node.id, node]));
    const known = Object.fromEntries(byId); // для resolveSubject
    return [...mentions.values()]
        .filter(entry => entry.nodeIds.size >= minMentions)
        .filter(entry => !resolveSubject(entry.name, known))
        .sort((a, b) => b.nodeIds.size - a.nodeIds.size || a.name.localeCompare(b.name))
        .slice(0, maxCandidates)
        .map(entry => ({ name: entry.name, nodeIds: [...entry.nodeIds] }));
}
