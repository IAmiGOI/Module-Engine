import { normalizeDecrees } from '../../libraries/core/decision-decree.js';
import { importanceItems, pendingDecisions } from '../../libraries/core/decision-director.js';

/**
 * Исполнитель `decree`: несколько Указов, повышения из Petition и решения по
 * предложениям резолвера — одним вызовом. Состояние меняется только здесь,
 * после успешного ответа модели; повтор того же вызова не задваивает записи
 * (равный Указ историю не плодит, снятое предложение повторно не находится).
 */
export function createDecreeHandler({ banks = null, state = {}, publishEvent = () => {} } = {}) {
    return { decree: async args => {
        if (!banks?.great?.setDecree) return { ok: false, error: 'The Great Bank is not available.' };
        const decrees = normalizeDecrees(args?.decrees);
        const importance = importanceItems(args?.importance);
        const pending = pendingDecisions(args?.pending);
        if (!decrees.length && !importance.length && !pending.length) {
            return { ok: false, error: 'A decree call needs at least one Decree, one importance change or one pending decision.' };
        }
        const result = decrees.length
            ? await banks.great.setDecree({ decrees, comment: String(args?.comment ?? '').trim() })
            : { ok: true, at: '', decrees: [] };
        const levels = [];
        for (const item of importance) {
            const answer = await banks.great.setImportance(item);
            levels.push({ character: item.character, importance: item.importance, ok: answer.ok !== false, ...(answer.error ? { error: answer.error } : {}) });
        }
        const decisions = [];
        for (const item of pending) {
            const answer = await banks.great.resolvePending(item);
            decisions.push({ character: item.character, accept: item.accept, ok: answer.ok !== false, ...(answer.error ? { error: answer.error } : {}) });
        }
        state.decreeIssued = true;
        state.decreeNames = [...new Set([...(state.decreeNames ?? []), ...decrees.map(item => item.character)])];
        publishEvent('decision.decree', {
            at: result.at, characters: decrees.map(item => item.character),
            importance: levels.length, pending: decisions.length,
        });
        return {
            ok: true, at: result.at,
            decrees: result.decrees ?? [],
            ...(levels.length ? { importance: levels } : {}),
            ...(decisions.length ? { pending: decisions } : {}),
        };
    } };
}
