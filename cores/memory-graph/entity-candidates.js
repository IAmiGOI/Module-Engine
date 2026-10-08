import { resolveSubject } from './subjects.js';

/**
 * Кандидаты в сущности по тексту нод — чистые функции (граф не трогают). Это только ПРЕДЛОЖЕНИЕ: создаёт ноду `entity-ops.js`
 * и только после подтверждения моделью (имя ли это конкретного героя/места/группы, а не заголовок, слово или дата).
 *
 * Пока имя героя ни разу не попало в `subjects` ответа модели, у него нет ноды, хотя оно повторяется в содержимом записей
 * («Nyx» в семи записях и ни одной ноды Nyx). Имя собственное — слово(а) с заглавной буквы ВНУТРИ предложения, и почти всегда
 * именно так: обычное слово («Security», «Similar») в том же тексте встречается и со строчной.
 *
 * Лорбук и карточки полны разметки, которая выглядит как «заглавная буква посреди текста» (заголовки `**Present Relevance**`,
 * пункты `-Security in…`, названия `Satsuki Saionji — Backstory`), поэтому текст сначала очищается:
 *  - считается только СОДЕРЖИМОЕ нод (метка — это заголовок, не проза);
 *  - строка-заголовок (`#`, целиком жирная, оканчивается двоеточием, набрана Заглавными Словами) в статистику заглавных не идёт;
 *  - выделенное `**…**`/`*…*`/`__…__` вырезается; маркеры списков в начале строки убираются, а начало строки — это начало предложения;
 *  - месяцы, дни недели, времена года и названия языков/национальностей именами не бывают; слова целиком из заглавных («NOT») — эмфаза.
 */

export const ENTITY_DEFAULTS = Object.freeze({ minMentions: 3, maxCandidates: 2 });

const RUN = /\p{Lu}[\p{L}\p{N}'’]*(?:[ \t]+\p{Lu}[\p{L}\p{N}'’]*)*/gu;
const PROPER_SHARE = 0.9;     // доля вхождений с заглавной внутри предложения, не меньше которой слово считается именем
const MIN_MID_NODES = 2;      // в стольких разных нодах имя должно встретиться ВНУТРИ предложения (не только в начале)
const stripPossessive = token => token.replace(/['’]s$/iu, '').replace(/['’]$/u, '');

/** Слова, которые не бывают именем героя/места, как бы они ни писались: календарь и языки/национальности. */
const NEVER_NAMES = new Set([
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'spring', 'summer', 'autumn', 'fall', 'winter',
    'english', 'american', 'british', 'japanese', 'chinese', 'korean', 'french', 'german', 'russian', 'spanish', 'italian', 'european',
    'asian', 'african', 'western', 'eastern', 'northern', 'southern', 'canadian', 'australian', 'indian', 'mexican', 'brazilian',
]);

/** Слово целиком из заглавных («NOT», «NEVER», «ALWAYS» — эмфаза в лорбуках): не имя. */
const isShouting = token => token.length >= 2 && token === token.toUpperCase() && /\p{Lu}/u.test(token);

const isTitleLike = line => {
    const words = line.split(/\s+/).filter(word => /\p{L}/u.test(word));
    if (words.length < 2 || words.length > 10) return false;
    return words.filter(word => /^\p{Lu}/u.test(word)).length / words.length >= 0.6;
};

/** Строка — заголовок/подпись, а не проза: в статистику «заглавная посреди предложения» она не идёт. */
function isHeadingLine(raw) {
    const line = raw.trim();
    if (!line) return true;
    if (/^#{1,6}\s/.test(line)) return true;
    if (/^[*_]{2,}[^*_]+[*_]{2,}\s*:?\s*$/.test(line)) return true;                // вся строка выделена
    if (/:\s*$/.test(line) && line.split(/\s+/).length <= 8) return true;            // «Notable quirks:»
    const bare = line.replace(/^[\s\-*•>#]+/, '').replace(/[*_`]/g, '').trim();
    return line.length < 90 && !/[.!?]["”’']?$/.test(bare) && isTitleLike(bare);   // «Satsuki Saionji — Backstory»
}

/** Предложения прозы из текста ноды: без разметки, заголовков и выделений; начало строки — начало предложения. */
function proseSentences(content) {
    const sentences = [];
    for (const raw of String(content ?? '').split(/\r?\n/)) {
        if (isHeadingLine(raw)) continue;
        const line = raw
            .replace(/^[\s\-*•>]+/, '')
            .replace(/(\*{1,3}|_{2,3})[^*_\n]*?\1/g, ' ')   // выделенные фрагменты вырезаем целиком
            .replace(/[*_`#]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        if (!line) continue;
        for (const part of line.split(/(?<=[.!?…])\s+/)) if (part.trim()) sentences.push(part.trim());
    }
    return sentences;
}

/** Слова текста, написанные со строчной (для статистики «как часто это слово пишут не с заглавной»). */
const lowercaseWords = text => [...text.matchAll(/\p{Ll}[\p{L}\p{N}'’]*/gu)].map(match => stripPossessive(match[0]).toLowerCase());

/** Заглавные «пробеги» одного предложения: `[{ tokens, initial }]`; первый пробег, начинающийся с первого символа, — «начальный». */
function capitalRuns(sentence) {
    const runs = [];
    for (const match of sentence.matchAll(RUN)) {
        const tokens = match[0].split(/[ \t]+/).map(stripPossessive).filter(Boolean);
        if (tokens.length) runs.push({ tokens, initial: match.index === 0 });
    }
    return runs;
}

/**
 * `nodes` — все ноды графа (`{ id, label, content, kind }`). Возвращает `[{ name, nodeIds, contexts }]` — кандидаты в сущности,
 * самые упоминаемые первыми (`contexts` — до 3 коротких отрывков для подтверждения моделью); пусто — новых имён нет.
 * `ignore` — имена, которые уже отклонены (нижний регистр).
 */
export function findEntityCandidates(nodes, { minMentions = ENTITY_DEFAULTS.minMentions, maxCandidates = ENTITY_DEFAULTS.maxCandidates, ignore = [] } = {}) {
    const list = Object.values(nodes).filter(node => node && (node.label || node.content));
    const skip = new Set([...ignore].map(name => String(name).toLowerCase()));
    const texts = list.map(node => {
        const sentences = proseSentences(node.content);
        return { id: node.id, sentences, runs: sentences.map(capitalRuns), plain: lowercaseWords(String(node.content ?? '')) };
    });

    // Слово «собственное», если с заглавной ВНУТРИ предложения оно встречается минимум дважды и почти только так (не в календаре и не в языках).
    const capitalMid = new Map();
    const lower = new Map();
    for (const { runs, plain } of texts) {
        for (const sentenceRuns of runs) for (const run of sentenceRuns) if (!run.initial) for (const token of run.tokens) {
            if (isShouting(token)) continue;
            const key = token.toLowerCase();
            capitalMid.set(key, (capitalMid.get(key) ?? 0) + 1);
        }
        for (const word of plain) lower.set(word, (lower.get(word) ?? 0) + 1);
    }
    const proper = new Set([...capitalMid]
        .filter(([word, count]) => count >= 2 && !NEVER_NAMES.has(word) && count / (count + (lower.get(word) ?? 0)) >= PROPER_SHARE)
        .map(([word]) => word));

    const mentions = new Map(); // нормализованное имя → { name, nodeIds:Set, midIds:Set, contexts:[] }
    for (const { id, sentences, runs } of texts) {
        runs.forEach((sentenceRuns, index) => {
            for (const run of sentenceRuns) {
                let tokens = run.tokens;
                while (tokens.length && !proper.has(tokens[0].toLowerCase())) tokens = tokens.slice(1);
                while (tokens.length && !proper.has(tokens.at(-1).toLowerCase())) tokens = tokens.slice(0, -1);
                if (!tokens.length) continue;
                const name = tokens.join(' ');
                if (name.length < 3 || tokens.some(token => NEVER_NAMES.has(token.toLowerCase()))) continue;
                const key = name.toLowerCase();
                const entry = mentions.get(key) ?? { name, nodeIds: new Set(), midIds: new Set(), contexts: [] };
                entry.nodeIds.add(id);
                if (!run.initial) entry.midIds.add(id);
                if (entry.contexts.length < 3 && !entry.contexts.some(text => text === sentences[index])) entry.contexts.push(sentences[index].slice(0, 200));
                mentions.set(key, entry);
            }
        });
    }

    const known = Object.fromEntries(list.map(node => [node.id, node]));
    return [...mentions.values()]
        .filter(entry => entry.nodeIds.size >= minMentions && entry.midIds.size >= MIN_MID_NODES && !skip.has(entry.name.toLowerCase()))
        .filter(entry => !resolveSubject(entry.name, known))
        .sort((a, b) => b.nodeIds.size - a.nodeIds.size || a.name.localeCompare(b.name))
        .slice(0, maxCandidates)
        .map(entry => ({ name: entry.name, nodeIds: [...entry.nodeIds], contexts: entry.contexts }));
}
