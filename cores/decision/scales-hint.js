import { scalesHintState, scalesHintQuestions, scalesHintSystems, scalesHintBlock } from '../../libraries/core/decision-scales-hint.js';

/**
 * Подсказка резолверу перед ходом: классификатор (`classifier.decide`, режим
 * Noul) получает три последних сообщения и по утверждению на каждую систему
 * Scales. Найденные системы возвращаются блоком карточек правил; без
 * подключения, без ключа или при сбое ход идёт без блока.
 */
export function createScalesHint({ call, getSettings, creation = null, publishEvent = () => {} }) {
    async function connections() {
        try {
            const list = await call('classifier.connections.get');
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    return async function scalesHintFor(chat = []) {
        const connectionId = String(getSettings?.()?.scalesHint?.connectionId ?? '').trim();
        if (!connectionId) return null;
        let systems = [];
        try {
            await creation?.load?.();
            systems = creation?.state?.()?.scales ?? [];
        } catch { systems = []; }
        if (!Array.isArray(systems) || !systems.length) return null;
        const connection = (await connections()).find(item => String(item?.id ?? '').trim() === connectionId);
        if (!connection?.apiKey) return null;

        try {
            const result = await call('classifier.decide', {
                calls: [{
                    purpose: 'scales hint',
                    state: { player_message: scalesHintState(chat) },
                    questions: scalesHintQuestions(systems),
                    connectionId,
                }],
            });
            const answers = result?.answers && typeof result.answers === 'object' ? result.answers : {};
            const error = String(result?.error ?? '');
            if (error) {
                publishEvent('decision.scales.hint.failed', { connectionId, error });
                return null;
            }
            if (!Object.keys(answers).length) {
                publishEvent('decision.scales.hint.failed', { connectionId, error: 'The classifier gave no answer.' });
                return null;
            }
            const hinted = scalesHintSystems(systems, answers);
            const found = hinted.map(item => ({ name: item.name, chance: Math.round(item.chance * 100) / 100 }));
            if (found.length) publishEvent('decision.scales.hint', { connectionId, systems: found });
            return { text: scalesHintBlock(hinted), systems: found };
        } catch (error) {
            publishEvent('decision.scales.hint.failed', { connectionId, error: error?.message ?? String(error) });
            return null;
        }
    };
}
