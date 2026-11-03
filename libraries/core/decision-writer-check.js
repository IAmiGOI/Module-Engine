import {
    WRITER_AGENCY_QUESTION, WRITER_RESOLUTION_QUESTION, WRITER_REWRITE_PROMPT,
    WRITER_REASON_AGENCY, WRITER_REASON_RESOLUTION, fillPrompt,
} from './decision-prompts.js';

/**
 * Проверка ответа писателя — чистые функции: срез, утверждения, строки
 * причин и промпт переписывания. Модель и сеть снаружи; здесь только тексты
 * из `PROMPTS.md`, раздел 13, и их подстановки.
 */

export const WRITER_CHECK_IDS = Object.freeze(['user_agency', 'past_resolution']);
const MAX_SENTENCES = 60;

const text = value => String(value ?? '').trim();

export function writerCheckState({ push = '', userMessage = '', reply = '' } = {}) {
    return { push: text(push), user_message: text(userMessage), reply: text(reply) };
}

export function writerCheckQuestions({ user = 'the user', resolution = '' } = {}) {
    return {
        user_agency: fillPrompt(WRITER_AGENCY_QUESTION, { user }),
        past_resolution: fillPrompt(WRITER_RESOLUTION_QUESTION, { resolution }),
    };
}

/** Предложения оборванного текста — для поиска цитаты и для одного запроса классификатора. */
export function splitSentences(value) {
    const clean = text(value).replace(/\s+/g, ' ');
    if (!clean) return [];
    const found = clean.match(/[^.!?…]+[.!?…]+["'»)]?|[^.!?…]+$/g) ?? [];
    return found.map(item => item.trim()).filter(Boolean).slice(0, MAX_SENTENCES);
}

/** Какие утверждения превысили порог; порядок — как в `WRITER_CHECK_IDS`. */
export function violatedIds(answers, threshold) {
    const limit = Number(threshold);
    return WRITER_CHECK_IDS.filter(id => Number.isFinite(Number(answers?.[id])) && Number(answers[id]) >= limit);
}

/** Строка причины без цитаты, если цитата не нашлась: `: ""` просто убирается. */
export function reasonLine(id, { quote = '', user = 'the user', resolution = '' } = {}) {
    const template = id === 'user_agency' ? WRITER_REASON_AGENCY : WRITER_REASON_RESOLUTION;
    const filled = fillPrompt(template, { user, quote: text(quote), resolution });
    return text(quote) ? filled : filled.replace(/:\s*""/, '');
}

export function rewriteReasons({ ids = [], quote = '', user = 'the user', resolution = '' } = {}) {
    return ids.map(id => reasonLine(id, { quote, user, resolution })).filter(Boolean).join('\n');
}

export function rewritePrompt({ reasons = '', attempt = 1 } = {}) {
    return fillPrompt(WRITER_REWRITE_PROMPT, { reasons: text(reasons), attempt });
}
