import { normalizeSection } from '../../libraries/core/decision-creation.js';
import { godQuestions } from '../../libraries/core/decision-god.js';

/**
 * Исполнители инструментов God: разделы Creation, система весов, открытие и
 * вопросы Советнику. Состояние меняется только здесь, после ответа модели;
 * повтор вызова не задваивает записи (раздел заменяется, открытие получает
 * новый номер).
 */
export function createCreationHandlers({ creation = null, store = null, state = {}, publishEvent = () => {}, now = () => Date.now() } = {}) {
    return {
        creation_write: async args => {
            if (!creation) return { ok: false, error: 'The Creation is not available.' };
            const sections = (Array.isArray(args?.sections) ? args.sections : [])
                .map(section => normalizeSection({ ...section, at: state.rpLabel ?? '' }))
                .filter(Boolean);
            if (!sections.length) return { ok: false, error: 'A creation_write call needs at least one section with a title and text.' };
            const result = await creation.writeSections({
                sections, at: state.rpLabel ?? '', by: 'god', comment: String(args?.comment ?? '').trim(),
            });
            state.written = [...(state.written ?? []), ...result.sections];
            return { ok: true, at: result.at, sections: result.sections, complete: result.complete, missing: result.missing };
        },

        scale_write: async args => {
            if (!creation) return { ok: false, error: 'The Creation is not available.' };
            const result = await creation.writeScale({
                system: args?.system, principle: args?.principle, payment: args?.payment, rules: args?.rules,
            });
            if (result.ok) state.systems = [...(state.systems ?? []), result.system];
            return result;
        },

        discovery_write: async args => {
            if (!creation) return { ok: false, error: 'The Creation is not available.' };
            return creation.writeDiscovery({
                system: args?.system, rule: args?.rule, text: args?.text, at: state.rpLabel ?? '',
            });
        },

        ask: async args => {
            if (!store?.addGodQuestions) return { ok: false, error: 'The Counsellor is not available.' };
            const questions = godQuestions(args?.questions);
            if (!questions.length) return { ok: false, error: 'ask needs at least one question.' };
            const limit = Math.max(1, Number(state.questionLimit) || 5);
            const asked = Number(state.questionsAsked) || 0;
            const allowed = questions.slice(0, Math.max(0, limit - asked));
            if (!allowed.length) return { ok: false, error: `You have asked ${limit} questions already. Decide the rest yourself and say in the section that it is your decision.` };
            await store.addGodQuestions(allowed, { turn: state.turn ?? null, at: now() });
            state.questionsAsked = asked + allowed.length;
            for (const item of allowed) publishEvent('decision.god.question', { question: item.question, why: item.why });
            return { ok: true, asked: allowed.length, kept: questions.length - allowed.length, asks: allowed.map(item => item.question) };
        },
    };
}
