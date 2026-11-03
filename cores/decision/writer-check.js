import { splitSentences, violatedIds, writerCheckQuestions, writerCheckState, WRITER_CHECK_IDS } from '../../libraries/core/decision-writer-check.js';
import { WRITER_AGENCY_QUESTION, WRITER_RESOLUTION_QUESTION, fillPrompt } from '../../libraries/core/decision-prompts.js';

/**
 * Проверка текста писателя классификатором: срез хода, два утверждения,
 * порог и поиск цитаты по предложениям. Сеть — через `classifier.decide`;
 * ошибки и отсутствие подключения — честный пропуск, не исключение.
 */
export function createWriterChecker({ call, getSettings, banks = null }) {
    function settings() {
        return getSettings()?.classifier ?? {};
    }

    function persona() {
        const name = String(banks?.persona?.()?.name ?? '').trim();
        return name || 'the user';
    }

    async function decideCalls(calls, signal) {
        if (!Array.isArray(calls) || !calls.length) return { ok: false, answers: {}, error: 'No classifier questions.' };
        const config = settings();
        const connectionId = String(config.connectionId ?? '').trim();
        try {
            const result = await call('classifier.decide', {
                calls: calls.map(entry => ({ ...entry, ...(connectionId ? { connectionId } : {}) })),
                ...(signal ? { signal } : {}),
            });
            const answers = result && typeof result === 'object' ? result.answers ?? {} : {};
            const error = String(result?.error ?? '');
            if (!Object.keys(answers).length) return { ok: false, answers: {}, failed: result?.failed ?? [], error: error || 'The classifier gave no answer.' };
            return { ok: true, answers, failed: result?.failed ?? [], error };
        } catch (error) {
            return { ok: false, answers: {}, failed: [], error: error?.message ?? String(error) };
        }
    }

    async function check({ reply, push, userMessage, resolution, signal }) {
        const state = writerCheckState({ push, userMessage, reply });
        const questions = writerCheckQuestions({ user: persona(), resolution });
        const result = await decideCalls([{ state, questions }], signal);
        if (!result.ok) return { ...result, violated: [] };
        const threshold = Number(settings().threshold) || 0.85;
        return { ...result, violated: violatedIds(result.answers, threshold) };
    }

    /** Предложение с самой высокой вероятностью нарушения; пустая строка — не нашлось. */
    async function quote({ reply, push, userMessage, resolution, id, signal }) {
        const sentences = splitSentences(reply);
        if (!sentences.length || !WRITER_CHECK_IDS.includes(id)) return '';
        const question = id === 'user_agency'
            ? fillPrompt(WRITER_AGENCY_QUESTION, { user: persona() })
            : fillPrompt(WRITER_RESOLUTION_QUESTION, { resolution });
        const calls = sentences.map((sentence, index) => ({
            state: writerCheckState({ push, userMessage, reply: sentence }),
            questions: { [`quote_${index}`]: question },
        }));
        const result = await decideCalls(calls, signal);
        if (!result.ok) return '';
        let best = '';
        let chance = -Infinity;
        sentences.forEach((sentence, index) => {
            const value = Number(result.answers?.[`quote_${index}`]);
            if (Number.isFinite(value) && value > chance) { chance = value; best = sentence; }
        });
        return best;
    }

    return { check, quote };
}
