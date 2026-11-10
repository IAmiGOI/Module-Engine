import { assessAction } from '../../libraries/core/decision-probability.js';
import { ASSESS_SOCIAL_REFUSAL } from '../../libraries/core/decision-prompts.js';
import { difficultyShift } from '../../libraries/core/game-settings.js';
import { findRule, ruleNames, ruleDifficulty, checkSteps, failureOf } from '../../libraries/core/decision-rule-weight.js';

/**
 * Оценка действия: два уровня из списков → таблица вероятностей → бросок
 * движка. Неизвестный уровень — отказ со списком допустимых, не догадка.
 * `why` обязательно: уровни решают шанс, `why` объясняет обстоятельства.
 */
export const ASSESS_KINDS = Object.freeze(['body', 'stealth', 'perception', 'craft', 'magic', 'social']);

export function createAssessHandler({ state, getSettings, getGameSettings = null, getScales = null }) {
    return async args => {
        // Разговор не бросается: убедить, соврать, надавить — и как это примет слушатель — решает директор.
        // Обязательный вид попытки не даёт тихо превратить уговоры в бросок «на подачу».
        const kind = String(args.kind ?? '').trim().toLowerCase();
        if (!ASSESS_KINDS.includes(kind)) return { ok: false, error: `assess needs "kind": one of ${ASSESS_KINDS.join(' / ')}.` };
        if (kind === 'social') return { ok: false, error: ASSESS_SOCIAL_REFUSAL };
        if (!String(args.why ?? '').trim()) {
            return { ok: false, error: 'assess needs "why": the circumstances of the attempt in a sentence or two.' };
        }
        // Размер работы решает цену провала: тонкие лучи маны не бьют отдачей, как волна на весь город.
        const size = String(args.size ?? '').trim().toLowerCase();
        if (kind === 'magic' && !['small', 'medium', 'heavy'].includes(size)) {
            return { ok: false, error: 'A magic attempt needs "size": small (a thin, light working), medium or heavy (a great working that draws hard on the caster). It sets what a failure can cost.' };
        }
        // Попытка через систему мира: трудность — от её правила, а не от ощущения резолвера.
        const systems = typeof getScales === 'function' ? (await getScales()) ?? [] : [];
        let fromRule = null;
        if (systems.length && (kind === 'magic' || String(args.rule ?? '').trim())) {
            const found = findRule(systems, args.rule);
            if (!found) {
                return { ok: false, error: `${String(args.rule ?? '').trim() ? `There is no rule "${String(args.rule).trim()}".` : 'An attempt through a power of the world needs "rule".'} Name the rule it uses, as "System / Rule": ${ruleNames(systems).join('; ')}.` };
            }
            const stepErrors = checkSteps(found.rule, { rises: args.rises, falls: args.falls });
            if (stepErrors.length) return { ok: false, error: `Rule "${found.system.name} / ${found.rule.name}": ${stepErrors.join(' ')}` };
            const strip = list => (Array.isArray(list) ? list : []).map(item => String(item ?? '').replace(/^(rule|scene)\s*:\s*/i, '').trim()).filter(Boolean);
            fromRule = ruleDifficulty(found.rule, { rises: strip(args.rises), falls: strip(args.falls), chosen: args.difficulty });
            if (!fromRule) return { ok: false, error: `The rule "${found.rule.name}" has no weight level — give "difficulty" yourself and name the rule in "why".` };
            fromRule = { ...fromRule, failure: failureOf(found.rule), rule: `${found.system.name} / ${found.rule.name}`, ruleRises: String(found.rule.weight?.rises ?? ''), ruleFalls: String(found.rule.weight?.falls ?? '') };
        }
        state.assessmentCounter += 1;
        const id = `asm_${state.runId}_${state.assessmentCounter}`;
        const settings = getSettings();
        const seed = Number.isFinite(settings.assessSeed) ? settings.assessSeed + state.assessmentCounter : undefined;
        // Сложность игры двигает столбец таблицы для ВСЕХ бросков, включая броски NPC.
        const game = typeof getGameSettings === 'function' ? getGameSettings() : null;
        const result = assessAction({
            character: args.character, action: args.action, difficulty: fromRule ? fromRule.difficulty : args.difficulty, experience: args.experience, why: args.why, seed,
            difficultyShift: difficultyShift(game),
        });
        if (!result.ok) return result;
        // Последствие неудачи — рядом с результатом, последним перед формой: строки промпта модель пропускала, и провал
        // тонкого щупа маны ронял с пятисот метров и полёт, и спутницу.
        const failed = ['clumsy', 'botched'].includes(String(result.degree ?? ''));
        const ONLY = 'It touches only this attempt: whatever the character already holds and keeps going — a working, flight, a grip — stays exactly as it was.';
        const consequence = !failed ? '' : size === 'small'
            ? `This was a small working: failing means only that it does not work or tells nothing. No backlash, no harm, no cost beyond the little that was spent. ${ONLY}`
            : [fromRule?.failure?.[result.degree] ? `What a ${result.degree} attempt costs under this rule${size === 'medium' ? ', in a lighter form for a medium working' : ''}: ${fromRule.failure[result.degree]}` : '', `This is all the failure costs. ${ONLY}`].filter(Boolean).join(' ');
        const base = fromRule ? { ...result, rule: fromRule.rule, ruleBase: fromRule.base, ruleLevels: fromRule.named, rises: fromRule.rises, falls: fromRule.falls } : result;
        const full = consequence ? { ...base, size, consequence } : (size ? { ...base, size } : base);
        state.assessments.set(id, { ...full, id });
        return { ...full, id };
    };
}
