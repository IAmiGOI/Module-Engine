import { signal } from '../reactive.js';
import { Toggle, Card } from '../../../libraries/shared/widgets.js';

/**
 * Карточка «Prompt Manager»: только включение (владелец: «убери кнопку включения PM из самого его окна и помести в
 * настройки движка» — окно PM остаётся редактором пресета, состояние enabled/disabled живёт здесь, рядом с
 * остальными переключателями движка). Читает и пишет ТОЛЬКО через контракты `promptManager.*`, как и само окно.
 */
export function createPromptManagerCard(deps) {
    const { call, collapse } = deps;
    const enabled = signal(true);

    async function loadEnabled() {
        const answer = await call('promptManager.settings');
        if (answer.ok) enabled.set(answer.value.enabled !== false);
    }

    async function setEnabled(value) {
        const answer = await call('promptManager.configure', { patch: { enabled: value } });
        enabled.set(answer.ok ? answer.value.enabled !== false : !value); // отказ — откатываем тумблер обратно
    }

    function promptManagerCard() {
        return Card('Prompt Manager', { ...collapse.bind('card:promptManager'), subtitle: 'Replaces how SillyTavern assembles the request' },
            Toggle('Prompt Manager on', enabled, { hint: 'The editor opens from SillyTavern\'s own "AI Response Configuration" icon.', onChange: setEnabled }),
        );
    }

    return { promptManagerCard, loadEnabled };
}
