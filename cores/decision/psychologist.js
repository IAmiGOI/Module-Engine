import { PSYCHOLOGIST_SYSTEM, PSYCHOLOGIST_TASK, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { psychologistWorkerId } from '../../libraries/core/decision-settings.js';
import { needsPsyche } from '../../libraries/core/decision-great-bank.js';
import { psycheLines } from '../../libraries/core/decision-psyche.js';
import { renderPart } from '../../libraries/core/court-bank-files.js';
import { promptText } from '../../libraries/core/prompt-overrides.js';

/** Ответ — несколько строк; запас на размышление не нужен, оно выключено. */
const PSYCHE_MAX_TOKENS = 1600;

/**
 * Психолог: один вызов модели на персонажа, когда его material.md и
 * spiritual.md впервые готовы. Пишет psyche.md — механизмы и темп психики —
 * и больше ничего. Персонажа пользователя не трогает.
 */
export function createPsychologist({ call, store = null, great, getSettings = () => ({}), publishEvent = () => {} }) {
    let running = null;

    function settings() {
        try { return getSettings?.() ?? {}; } catch { return {}; }
    }

    function worldLine() {
        try { return String(store?.chatBrief?.()?.timeline ?? '').trim(); } catch { return ''; }
    }

    async function runOne(character) {
        const workerId = psychologistWorkerId(settings());
        if (!workerId) {
            publishEvent('decision.psyche.skipped', { character: character.name, reason: 'no connection is configured' });
            return { skipped: true, name: character.name };
        }
        const prompt = fillPrompt(PSYCHOLOGIST_TASK, {
            name: character.name,
            material: renderPart(character, 'material'),
            spiritual: renderPart(character, 'spiritual'),
            decree: renderPart(character, 'decree'),
            world: worldLine() || 'unknown',
        });
        publishEvent('decision.psyche.started', { character: character.name });
        let answer;
        try {
            // Без рассуждения: psyche.md — короткий текст, а не разбор (как сводка окна).
            answer = await call('model.generate', { purpose: 'psychologist',
                workerId,
                systemPrompt: promptText(PSYCHOLOGIST_SYSTEM),
                prompt,
                maxTokens: PSYCHE_MAX_TOKENS, temperature: 0, stream: false,
                reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
            });
        } catch (error) {
            publishEvent('decision.psyche.failed', { character: character.name, message: error?.message ?? String(error) });
            return { ok: false, name: character.name, error: error?.message ?? String(error) };
        }
        const lines = psycheLines(answer);
        if (!lines.length) {
            publishEvent('decision.psyche.failed', { character: character.name, message: 'the model returned no lines' });
            return { ok: false, name: character.name, error: 'the model returned no lines' };
        }
        const written = await great.setPsyche({
            character: character.name, lines,
            comment: 'The Psychologist wrote how their mind moves.',
        }).catch(error => ({ ok: false, error: error?.message ?? String(error) }));
        if (written?.ok === false) {
            publishEvent('decision.psyche.failed', { character: character.name, message: written.error });
            return { ok: false, name: character.name, error: written.error };
        }
        publishEvent('decision.psyche.ready', { character: character.name, lines: lines.length });
        return { ok: true, name: character.name, lines: lines.length };
    }

    /** Все, кому psyche.md ещё нужен в этом состоянии; один прогон за раз. */
    function maybeRun(state) {
        if (running) return running;
        const list = Object.values(state ?? {}).filter(needsPsyche);
        if (!list.length) return Promise.resolve({ skipped: true, written: [] });
        running = (async () => {
            const written = [];
            for (const character of list) {
                const result = await runOne(character);
                if (result?.ok) written.push(result.name);
            }
            return { ok: true, written };
        })().finally(() => { running = null; });
        return running;
    }

    return { runOne, maybeRun };
}
