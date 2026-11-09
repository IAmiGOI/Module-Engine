import { assessAction } from '../../libraries/core/decision-probability.js';
import { ASSESS_SOCIAL_REFUSAL } from '../../libraries/core/decision-prompts.js';
import { difficultyShift } from '../../libraries/core/game-settings.js';
import { modesAllowRolls } from '../../libraries/core/turn-modes.js';

/**
 * Оценка действия: два уровня из списков → таблица вероятностей → бросок
 * движка. Неизвестный уровень — отказ со списком допустимых, не догадка.
 * `why` обязательно: уровни решают шанс, `why` объясняет обстоятельства.
 */
export const ASSESS_KINDS = Object.freeze(['body', 'stealth', 'perception', 'craft', 'magic', 'social']);

export function createAssessHandler({ state, getSettings, getGameSettings = null }) {
    return async args => {
        // Разговор не бросается: убедить, соврать, надавить — и как это примет слушатель — решает директор.
        // Обязательный вид попытки не даёт тихо превратить уговоры в бросок «на подачу».
        if (state.modes?.chosen && !modesAllowRolls(state.modes.chosen)) return { ok: false, error: 'Nothing is rolled this turn: decide it from the characters. Leave assessId out.' };
        const kind = String(args.kind ?? '').trim().toLowerCase();
        if (!ASSESS_KINDS.includes(kind)) return { ok: false, error: `assess needs "kind": one of ${ASSESS_KINDS.join(' / ')}.` };
        if (kind === 'social') return { ok: false, error: ASSESS_SOCIAL_REFUSAL };
        if (!String(args.why ?? '').trim()) {
            return { ok: false, error: 'assess needs "why": the circumstances of the attempt in a sentence or two.' };
        }
        state.assessmentCounter += 1;
        const id = `asm_${state.runId}_${state.assessmentCounter}`;
        const settings = getSettings();
        const seed = Number.isFinite(settings.assessSeed) ? settings.assessSeed + state.assessmentCounter : undefined;
        // Сложность игры двигает столбец таблицы для ВСЕХ бросков, включая броски NPC.
        const game = typeof getGameSettings === 'function' ? getGameSettings() : null;
        const result = assessAction({
            character: args.character, action: args.action, difficulty: args.difficulty, experience: args.experience, why: args.why, seed,
            difficultyShift: difficultyShift(game),
        });
        if (!result.ok) return result;
        state.assessments.set(id, { ...result, id });
        return { ...result, id };
    };
}
