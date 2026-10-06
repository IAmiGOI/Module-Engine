import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Badge, EmptyState } from '../../../libraries/shared/widgets.js';

/** Вкладка «Preview»: что уйдёт модели по текущему чату — токены по блокам, что обрезано, предупреждения, сами сообщения. */
export function createPreviewTab({ call }) {
    const result = signal(null);
    const busy = signal(false);
    const error = signal('');

    async function refresh() {
        busy.set(true);
        error.set('');
        const answer = await call('promptManager.preview');
        busy.set(false);
        if (!answer.ok) { error.set(answer.error.message); return; }
        result.set(answer.value);
    }

    const tokenTable = data => h('table', { class: 'stme-pm-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Block'), h('th', {}, 'Tokens'))),
        h('tbody', {}, [...data.tokens.byBlock].map(([block, tokens]) => h('tr', {}, h('td', {}, block), h('td', {}, String(tokens))))));

    function tree() {
        return h('div', { class: 'stme-pm-preview' },
            Row(Button('Refresh preview', refresh, { disabled: false }), computed(() => (busy() ? Badge('working…') : null))),
            computed(() => (error() ? EmptyState(error()) : null)),
            computed(() => {
                const data = result();
                if (!data) return EmptyState('Press Refresh to see what would be sent for the current chat.');
                if (data.skipped) return EmptyState(`Nothing to show: ${data.skipped}.`);
                const warnings = [
                    data.macros?.usedRandom ? 'This prompt uses random macros: the prefix cache breaks unless "Freeze random" is on (Settings).' : null,
                    data.macros?.unresolved?.length ? `Unknown macros left as text: ${data.macros.unresolved.join(', ')}` : null,
                    data.budgetInvalid ? `The token budget is not usable: Max response (${data.budgetInvalid.reserved}) leaves ${Math.max(data.budgetInvalid.maxContext - data.budgetInvalid.reserved, 0)} tokens of Max context (${data.budgetInvalid.maxContext}). Trimming is switched off until you fix it in Settings.` : null,
                    data.cutReleased ? 'The budget grew, so the earlier cut of the history was released and the trimming was counted again (the provider cache restarts once).' : null,
                    data.dropped?.length ? `${data.dropped.length} item(s) were trimmed to fit the context.` : null,
                    data.dropped?.some(item => item.reason === 'stable cut') ? 'Some history is cut by an earlier trimming ("stable cut" — it stays the same every turn to keep the cache). If it was caused by a wrong setting, press "Reset trimming" in Settings.' : null,
                ].filter(Boolean);
                return h('div', {},
                    Row(Badge(`${data.tokens.total} / ${data.budget} tokens`, { tone: data.budgetInvalid || data.tokens.total > data.budget ? 'error' : 'ok' })),
                    ...warnings.map(text => h('p', { class: 'stme-pm-warning' }, text)),
                    tokenTable(data),
                    h('details', {}, h('summary', {}, `Messages (${data.messages.length})`),
                        data.messages.map((message, index) => h('div', { class: 'stme-pm-message' }, h('strong', {}, `${index + 1}. ${message.role}`), h('pre', {}, typeof message.content === 'string' ? message.content : JSON.stringify(message.content))))),
                    data.dropped?.length ? h('details', {}, h('summary', {}, 'Trimmed'), data.dropped.map(item => h('div', {}, `${item.block}${item.hid !== undefined ? ` #${item.hid}` : ''} · ${item.tokens} tokens · ${item.reason}`))) : null,
                );
            }),
        );
    }
    return { tree, refresh };
}
