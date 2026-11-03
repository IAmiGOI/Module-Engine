import { assessAction } from '../../libraries/core/decision-probability.js';

/**
 * Оценка действия: два уровня из списков → таблица вероятностей → бросок
 * движка. Неизвестный уровень — отказ со списком допустимых, не догадка.
 * `why` обязательно: уровни решают шанс, `why` объясняет обстоятельства.
 */
export function createAssessHandler({ state, getSettings }) {
    return async args => {
        if (!String(args.why ?? '').trim()) {
            return { ok: false, error: 'assess needs "why": the circumstances of the attempt in a sentence or two.' };
        }
        state.assessmentCounter += 1;
        const id = `asm_${state.runId}_${state.assessmentCounter}`;
        const settings = getSettings();
        const seed = Number.isFinite(settings.assessSeed) ? settings.assessSeed + state.assessmentCounter : undefined;
        const result = assessAction({
            character: args.character, action: args.action, difficulty: args.difficulty, experience: args.experience, why: args.why, seed,
        });
        if (!result.ok) return result;
        state.assessments.set(id, { ...result, id });
        return { ...result, id };
    };
}
