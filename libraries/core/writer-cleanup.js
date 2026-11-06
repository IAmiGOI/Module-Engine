/**
 * Чистка готового ответа писателя от «объявленных» реплик: GLM пишет фразу повествования, пересказывающую
 * реплику («He tells you to sit down and have the page ready…»), и сразу ту же реплику в кавычках. Правило в
 * промпте он не держит, поэтому лишняя фраза убирается механически. Удаляется только предложение без кавычек,
 * с глаголом речи, стоящее в том же абзаце или соседнем с репликой, большая часть значимых слов которого есть
 * в этой реплике. Сюжет не трогается: остаётся сама реплика.
 */

const SPEECH_VERB = /\b(says?|said|tells?|told|asks?|asked|answers?|answered|gives?|gave|grants?|granted|warns?|warned|states?|stated|names?|named|adds?|added|repeats?|repeated|explains?|explained|admits?|admitted|promises?|promised|replies|replied|reply|insists?|insisted)\b/i;
const QUOTE = /"([^"]+)"|“([^”]+)”/g;
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'what', 'when', 'your', 'they', 'them', 'there', 'then', 'than', 'into', 'about', 'because', 'before', 'after', 'would', 'could', 'should', 'just', 'only', 'even', 'were', 'been', 'being', 'does', 'said', 'says', 'tells', 'told', 'gives', 'back', 'him', 'her', 'his', 'hers', 'yours', 'itself', 'himself', 'herself']);

const words = value => (String(value ?? '').toLowerCase().match(/[a-z']{4,}/g) ?? []).filter(word => !STOP.has(word));

function quotesOf(paragraph) {
    const found = [];
    for (const match of String(paragraph ?? '').matchAll(QUOTE)) found.push(match[1] ?? match[2] ?? '');
    return found;
}

function sentencesOf(paragraph) {
    return String(paragraph).match(/[^.!?]+[.!?]+["”)]?\s*|[^.!?]+$/g) ?? [String(paragraph)];
}

/** Повторяет ли предложение реплику: глагол речи и не меньше половины значимых слов (минимум четыре) — из реплики. */
export function announcesLine(sentence, quotes) {
    if (/["“”]/.test(sentence) || !SPEECH_VERB.test(sentence)) return false;
    const own = [...new Set(words(sentence))];
    if (own.length < 4) return false;
    const pool = new Set(quotes.flatMap(words));
    const shared = own.filter(word => pool.has(word)).length;
    return shared >= 4 && shared / own.length >= 0.45;
}

export function dropAnnouncedLines(text) {
    const paragraphs = String(text ?? '').split(/\n{2,}/);
    const cleaned = paragraphs.map((paragraph, index) => {
        const quotes = [...quotesOf(paragraphs[index - 1]), ...quotesOf(paragraphs[index + 1])];
        // Только абзацы чистого повествования: внутри абзаца с репликой предложения реплики при разбиении теряют кавычки.
        if (!quotes.length || /["“”]/.test(paragraph)) return paragraph;
        const kept = sentencesOf(paragraph).filter(sentence => !announcesLine(sentence.trim(), quotes));
        return kept.join('').trim();
    }).filter(paragraph => paragraph.trim());
    return cleaned.join('\n\n');
}
