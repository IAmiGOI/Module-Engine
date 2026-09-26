import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { Row, Card, Badge } from '../../../libraries/shared/widgets.js';

/** Карточка «Engine»: что реально подключено сейчас. */
export function createStatusCard(deps) {
    const { collapse, contracts, generationStage, eventCount } = deps;

    function statusCard() {
        return Card('Engine', { ...collapse.bind('card:engine'), subtitle: 'What is actually wired right now' },
            Row(
                computed(() => Badge(`${contracts().length} contracts`, { tone: 'muted' })),
                computed(() => Badge(`generation: ${generationStage()}`, { tone: generationStage() === 'idle' ? 'muted' : 'ok' })),
                computed(() => Badge(`${eventCount()} events seen`, { tone: 'muted' })),
            ),
            h('div', { class: 'stme-contract-list' },
                computed(() => contracts().map(entry => h('code', { key: entry.contract, class: 'stme-contract' }, entry.contract))),
            ),
        );
    }

    return { statusCard };
}
