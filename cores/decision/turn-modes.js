import { modeScene, modePrompt, parseModeAnswer, chooseModes } from '../../libraries/core/turn-modes.js';

/**
 * Выбор режимов хода перед Resolver: короткий запрос к воркеру Resolver (или к своему, если задан в
 * настройках `modes.workerId`). Сбой, нет воркера или режимы не включены (`modes.enabled`) — `null`:
 * ход идёт по общему шаблону. Источник сменный: потом сюда встанет локальная модель DataGen.
 */
export function createModePicker({ call, getSettings }) {
    return async function pickModes(chat, signal = null) {
        const settings = getSettings() ?? {};
        if (settings.modes?.enabled !== true) return null;
        const workerId = String(settings.modes?.workerId || settings.decider?.workerId || '').trim();
        if (!workerId) return null;
        const scene = modeScene(chat);
        if (!scene) return null;
        try {
            const answer = await call('model.generate', {
                workerId, maxTokens: 200, temperature: 0, stream: false, reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
                messages: [{ role: 'system', content: modePrompt() }, { role: 'user', content: scene }],
                // Спекулятивную ветку отменяют вместе с остальными её запросами.
                ...(signal ? { signal } : {}),
            });
            const answers = parseModeAnswer(answer);
            if (!Object.keys(answers).length) return null;
            return { scene, answers, chosen: chooseModes(answers), source: `llm:${workerId}` };
        } catch {
            return null;
        }
    };
}
