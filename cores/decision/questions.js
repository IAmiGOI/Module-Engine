import { ASK_USER_ANSWERED, ASK_USER_LIMIT, ASK_USER_NOT_ALLOWED, ASK_USER_SKIPPED, fillPrompt } from '../../libraries/core/decision-prompts.js';

/**
 * Очередь вопросов `ask_user`: инструмент ждёт ответа, тост показывает
 * первый вопрос, ввод ST закрыт, пока очередь не пуста. Ответ — вариант,
 * свой текст или «Skip».
 */
export function createQuestionQueue({ callService = null, publishEvent, now = () => Date.now() } = {}) {
    const pending = new Map();
    const order = [];
    let counter = 0;
    let locked = false;

    function lock(value) {
        if (locked === value) return;
        locked = value;
        if (typeof callService !== 'function') return;
        Promise.resolve(callService('stInput.setLocked', { locked: value })).catch(() => {});
    }

    function first() {
        return order.length ? pending.get(order[0]) ?? null : null;
    }

    function view(entry) {
        return entry ? { id: entry.id, question: entry.question, options: [...entry.options], why: entry.why, index: order.indexOf(entry.id) + 1, total: order.length } : null;
    }

    /**
     * @returns {Promise<{ text: string, asked: boolean }>}
     */
    function ask({ question, options, why = '', allowed = false, asked = 0, limit = 5 } = {}) {
        const body = String(question ?? '').trim();
        const choices = (Array.isArray(options) ? options : []).map(item => String(item ?? '').trim()).filter(Boolean);
        if (!allowed) return Promise.resolve({ text: ASK_USER_NOT_ALLOWED, asked: false });
        if (Number(asked) >= Number(limit)) return Promise.resolve({ text: fillPrompt(ASK_USER_LIMIT, { max_questions: limit }), asked: false });
        if (!body || choices.length < 2 || choices.length > 4) {
            return Promise.resolve({ text: 'ask_user needs a question and two to four concrete options.', asked: false });
        }
        counter += 1;
        const id = `question_${now().toString(36)}_${counter}`;
        const promise = new Promise(resolve => {
            pending.set(id, { id, question: body, options: choices, why: String(why ?? '').trim(), resolve, at: now() });
            order.push(id);
        });
        lock(true);
        publishEvent('decision.question.asked', view(pending.get(id)));
        return promise;
    }

    function answer({ id, answer = '', skipped = false } = {}) {
        const entry = pending.get(String(id ?? ''));
        if (!entry) return { ok: false, error: 'There is no such question.' };
        pending.delete(entry.id);
        const index = order.indexOf(entry.id);
        if (index >= 0) order.splice(index, 1);
        const skippedQuestion = skipped === true || !String(answer ?? '').trim();
        const text = skippedQuestion ? ASK_USER_SKIPPED : fillPrompt(ASK_USER_ANSWERED, { answer: String(answer).trim() });
        entry.resolve({ text, asked: true, answer: skippedQuestion ? '' : String(answer).trim(), skipped: skippedQuestion });
        if (!order.length) lock(false);
        publishEvent('decision.question.answered', { id: entry.id, answer: skippedQuestion ? '' : String(answer).trim(), skipped: skippedQuestion, at: now() });
        return { ok: true };
    }

    /** Смена чата: открытые вопросы старого чата снимаются как пропущенные, ввод открывается. */
    function cancelAll() {
        for (const entry of [...pending.values()]) {
            pending.delete(entry.id);
            entry.resolve({ text: ASK_USER_SKIPPED, asked: true, answer: '', skipped: true });
            publishEvent('decision.question.answered', { id: entry.id, answer: '', skipped: true, at: now() });
        }
        order.length = 0;
        lock(false);
    }

    return {
        ask, answer, cancelAll,
        pending: () => view(first()),
        count: () => order.length,
        locked: () => locked,
    };
}
