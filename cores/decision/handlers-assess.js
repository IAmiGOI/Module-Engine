import { assessAction } from '../../libraries/core/decision-probability.js';
import { ASSESS_SOCIAL_REFUSAL } from '../../libraries/core/decision-prompts.js';
import { difficultyShift } from '../../libraries/core/game-settings.js';
import { findRule, ruleDifficulty, checkSteps, failureOf, ruleCard, freeformRules, methodFits } from '../../libraries/core/decision-rule-weight.js';

/**
 * Оценка действия: два уровня из списков → таблица вероятностей → бросок
 * движка. Неизвестный уровень — отказ со списком допустимых, не догадка.
 * `why` обязательно: уровни решают шанс, `why` объясняет обстоятельства.
 */
export const ASSESS_KINDS = Object.freeze(['body', 'stealth', 'perception', 'craft', 'magic', 'social']);

export function createAssessHandler({ state, getSettings, getGameSettings = null, getScales = null, userName = () => '' }) {
    return async args => {
        // Разговор не бросается: убедить, соврать, надавить — и как это примет слушатель — решает директор.
        // Обязательный вид попытки не даёт тихо превратить уговоры в бросок «на подачу».
        const kind = String(args.kind ?? '').trim().toLowerCase();
        if (!ASSESS_KINDS.includes(kind)) return { ok: false, error: `assess needs "kind": one of ${ASSESS_KINDS.join(' / ')}.` };
        if (kind === 'social') return { ok: false, error: ASSESS_SOCIAL_REFUSAL };
        if (!String(args.why ?? '').trim()) {
            return { ok: false, error: 'assess needs "why": the circumstances of the attempt in a sentence or two.' };
        }
        // Размер работы решает цену провала: тонкие лучи маны не бьют отдачей, как волна на весь город. Не указан — средний.
        const sizeRaw = String(args.size ?? '').trim().toLowerCase();
        const size = kind === 'magic' ? (['small', 'medium', 'heavy'].includes(sizeRaw) ? sizeRaw : 'medium') : '';
        // Попытка через систему мира: трудность — от её правила. Движок не отказывает, а исправляет: отказы гоняли
        // резолвер по кругу, и ход не укладывался в срок.
        const systems = typeof getScales === 'function' ? (await getScales()) ?? [] : [];
        let fromRule = null;
        const notes = [];
        if (systems.length && (kind === 'magic' || String(args.rule ?? '').trim())) {
            let found = findRule(systems, args.rule);
            const freeform = freeformRules(systems).map(name => findRule(systems, name)).filter(Boolean);
            // Способ персонажа пользователя — его собственное сообщение. Если Needs выбранного правила его не описывают,
            // это его своя техника: правило свободной работы. Радар из лучей уходил в «волну маны» с её ценой и трудностью.
            const isUser = String(userName() ?? '').trim().toLowerCase() === String(args.character ?? '').trim().toLowerCase();
            const message = String(state.userMessage ?? '');
            const isFreeform = rule => /imagin|imagery|freeform|visuali[sz]/i.test(`${rule?.name} ${(rule?.needs ?? []).join(' ')}`);
            if (isUser && message && freeform.length && (!found || (!isFreeform(found.rule) && methodFits(found.rule.needs, message) < 0.25))) {
                if (found) notes.push(`The user's own words do not describe the Needs of "${found.system.name} / ${found.rule.name}" — rolled under "${freeform[0].system.name} / ${freeform[0].rule.name}", the rule for a technique built from their own understanding.`);
                found = freeform[0];
            }
            if (!found && freeform.length && kind === 'magic') found = freeform[0];
            if (found) {
                const strip = list => (Array.isArray(list) ? list : []).map(item => String(item ?? '').trim()).filter(Boolean);
                const keep = side => strip(args[side]).filter(item => {
                    const errors = checkSteps(found.rule, { [side]: [item] });
                    if (errors.length) notes.push(`not counted — ${errors[0]}`);
                    return !errors.length;
                }).map(item => item.replace(/^(rule|scene)\s*:\s*/i, '').trim());
                fromRule = ruleDifficulty(found.rule, { rises: keep('rises'), falls: keep('falls'), chosen: args.difficulty });
                if (fromRule) {
                    fromRule = { ...fromRule, card: ruleCard(found.system, found.rule), limit: (Array.isArray(found.rule.limit) ? found.rule.limit : [found.rule.limit]).filter(Boolean).join(' '), scaling: (Array.isArray(found.rule.scaling) ? found.rule.scaling : [found.rule.scaling]).filter(Boolean).join(' '), failure: failureOf(found.rule), rule: `${found.system.name} / ${found.rule.name}` };
                }
            }
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
        const base = fromRule ? { ...result, rule: fromRule.rule, ruleBase: fromRule.base, ruleLevels: fromRule.named, rises: fromRule.rises, falls: fromRule.falls, ruleText: fromRule.card, ...(notes.length ? { notes } : {}) } : result;
        const full = consequence ? { ...base, size, consequence } : (size ? { ...base, size } : base);
        state.assessments.set(id, { ...full, id });
        return { ...full, id };
    };
}
