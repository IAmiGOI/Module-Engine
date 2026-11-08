/**
 * Очередь вопросов Бога и Декларация — чистые правила. Вопросы задаёт God,
 * Советник спрашивает пользователя, а когда закрыт последний вопрос, все
 * ответы уходят Богу одним пакетом. Ни хранения, ни модели.
 */

const text = value => String(value ?? '').trim();

/** Вопросы Бога Советнику: вопрос, что зависит от ответа, номер хода. */
export function normalizeGodQuestions(value) {
    return (Array.isArray(value) ? value : [])
        .filter(item => item && typeof item === 'object' && text(item.question))
        .map(item => ({
            id: text(item.id) || `gq_${Number(item.at) || 0}_${Math.random().toString(36).slice(2, 6)}`,
            question: text(item.question), why: text(item.why),
            at: Number(item.at) || 0, turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
            answer: text(item.answer), answeredAt: Number(item.answeredAt) || 0,
        }));
}

/** Декларация: все ответы на закрытые вопросы, одним пакетом Богу. */
export function normalizeDeclaration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const answers = (Array.isArray(value.answers) ? value.answers : [])
        .filter(item => item && typeof item === 'object' && text(item.answer))
        .map(item => ({ question: text(item.question), answer: text(item.answer), at: Number(item.at) || 0 }));
    return answers.length ? { answers, at: Number(value.at) || 0, delivered: Boolean(value.delivered) } : null;
}

/** Вопрос закрыт: ответ ложится в вопрос, Декларация собирается, когда закрыты все. */
export function answerGodQuestion(questions, { id, answer, at = 0 } = {}) {
    const list = normalizeGodQuestions(questions);
    const wanted = text(id);
    const body = text(answer);
    if (!wanted || !body) return { questions: list, closed: false, declaration: null };
    const next = list.map(item => (item.id === wanted ? { ...item, answer: body, answeredAt: Number(at) || 0 } : item));
    const closed = next.every(item => text(item.answer));
    return {
        questions: next,
        closed,
        declaration: closed ? { answers: next.map(item => ({ question: item.question, answer: item.answer, at: item.answeredAt })), at: Number(at) || 0, delivered: false } : null,
    };
}

/** Вопросы, которые ещё ждут ответа. */
export function openGodQuestions(value) {
    return normalizeGodQuestions(value).filter(item => !text(item.answer));
}

/** Вопросы для строки контекста Советника. */
export function renderGodQuestions(value) {
    return normalizeGodQuestions(value)
        .filter(item => !text(item.answer))
        .map(item => `- [${item.id}] ${item.question}${item.why ? ` — ${item.why}` : ''}`)
        .join('\n');
}
