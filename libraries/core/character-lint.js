/**
 * Проверка карточки персонажа на «стоящие отрицания» — правило владельца: правила описывают, что персонаж ДЕЛАЕТ; отрицание допустимо только рядом с
 * положительной формулировкой, к которой относится («Mira answers in one sentence. (She does not fill silences.)»), и не как приказ («Never…»). Отрицания — средство
 * починки после теста, а не стиль (guide/knowledge/character-rules.md). Чистые функции; ловит форму, а не смысл, поэтому правка отклоняется с точным списком
 * мест, а если человек или тест действительно потребовали отрицание — отправляется заново с `negations_ok`.
 *
 * Что считается нарушением в одной строке текста (прямая речь в кавычках и звёздочки разметки не считаются):
 *  — приказ-запрет в начале предложения: «Never…», «Do not…», «Don't…», «Must not…», «Avoid…»;
 *  — два отрицательных предложения подряд («She does not step back. She does not step forward.», «No stutter. No hesitation.»);
 *  — строка, где отрицание одно и положительного предложения рядом нет.
 */

export const CHECKED_FIELDS = Object.freeze(['description', 'personality', 'scenario', 'mes_example', 'post_history_instructions', 'system_prompt']);

const NEGATION = /\b(?:never|don't|do not|doesn't|does not|didn't|did not|can't|cannot|won't|will not|isn't|is not|aren't|are not|wasn't|was not|haven't|have not|hasn't|has not|no|not|nothing|nobody|none|neither|nor)\b/i;
const PROHIBITION = /^(?:never|do not|don't|must not|avoid)\b/i;
const MAX_REPORTED = 8;

// Прямая речь заменяется меткой Q (с точкой, если речь кончалась знаком конца предложения): граница предложения не пропадает вместе с кавычками.
const stripQuotedSpeech = text => text.replace(/"([^"\n]*)"|“([^”\n]*)”/g, (_whole, plain, curly) => ` Q${/[.!?]\s*$/.test(plain ?? curly ?? '') ? '. ' : ' '}`);
const stripMarkup = text => text.replace(/[*_`#>]+/g, ' ').replace(/^\s*(?:[-•]|\d+[.)])\s+/, '');

/** Предложения строки: по `.`, `!`, `?`, `;`, тире и закрывающей скобке; пустые и без букв отбрасываются. */
function splitSentences(line) {
    return stripMarkup(stripQuotedSpeech(line)).split(/[.!?;]+\s+|[.!?;]+$|\s[—–]\s|\)\s+|\s+\(/).map(part => part.replace(/[()]/g, '').trim()).filter(part => /\p{L}/u.test(part));
}

/** Нарушения в тексте одного поля: `[{ sentence, problem }]`. */
export function computeNegationProblems(text) {
    const problems = [];
    const seen = new Set();
    const report = (sentence, problem) => { const key = `${sentence}|${problem}`; if (!seen.has(key)) { seen.add(key); problems.push({ sentence: sentence.slice(0, 160), problem }); } };
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
        if (/^\s*<START>\s*$/i.test(rawLine) || /^\s*\{\{user\}\}\s*:/i.test(rawLine)) continue;
        const sentences = splitSentences(rawLine.replace(/^\s*(?:\{\{char\}\}|[A-Z][\w' -]{0,30}):\s*/, ''));
        const negative = sentences.map(sentence => NEGATION.test(sentence));
        sentences.forEach((sentence, index) => { if (PROHIBITION.test(sentence)) report(sentence, 'a prohibition written as an order'); });
        for (let index = 0; index < sentences.length - 1; index += 1) {
            if (negative[index] && negative[index + 1]) report(`${sentences[index]}. ${sentences[index + 1]}`, 'two negations in a row');
        }
        if (sentences.length === 1 && negative[0] && !PROHIBITION.test(sentences[0])) report(sentences[0], 'a negation with no positive wording next to it');
    }
    return problems;
}

/** Нарушения во всех проверяемых полях изменения: `[{ field, sentence, problem }]` (не больше MAX_REPORTED). */
export function computeCardNegationProblems(fields) {
    const found = [];
    for (const key of CHECKED_FIELDS) if (typeof fields?.[key] === 'string') for (const item of computeNegationProblems(fields[key])) found.push({ field: key, ...item });
    if (typeof fields?.depth_prompt?.prompt === 'string') for (const item of computeNegationProblems(fields.depth_prompt.prompt)) found.push({ field: 'depth_prompt', ...item });
    return found;
}

/** Текст отказа для Mea: правило, точные места и как поступить. */
export function buildNegationRefusal(problems) {
    const shown = problems.slice(0, MAX_REPORTED);
    const places = shown.map(item => `- ${item.field}: “${item.sentence}” — ${item.problem}`).join('\n');
    const more = problems.length > shown.length ? `\n(and ${problems.length - shown.length} more of the same kind)` : '';
    return `Not written: standing negations. A card says what the character DOES. A negation is allowed only in the same line as the positive wording it belongs to (“Mira answers in one sentence. (She does not fill silences.)”), never as an order (“Never…”, “Do not…”) and never two in a row. Rewrite these places positively and send the change again:\n${places}${more}\nOnly if the user asked for a negation, or a test showed the model doing that very thing, send the same change again with "negations_ok": true.`;
}
