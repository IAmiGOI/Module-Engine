import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Badge, EmptyState } from '../../../libraries/shared/widgets.js';

const percent = ratio => `${Math.round((ratio ?? 0) * 100)}%`;

/** Вкладка «Log & cache»: последние запросы, доля общего префикса с предыдущим (кеш провайдера), блок-виновник, советы по порядку. */
export function createLogTab({ call }) {
    const entries = signal([]);
    const stability = signal(null);

    async function refresh() {
        const [log, advice] = await Promise.all([call('promptManager.log'), call('promptManager.stability')]);
        entries.set(log.ok ? log.value : []);
        stability.set(advice.ok ? advice.value : null);
    }

    function tree() {
        return h('div', { class: 'stme-pm-log' },
            Row(Button('Refresh', refresh)),
            computed(() => (stability()?.verdict ? h('div', { class: stability().verdict.verdict === 'good' ? 'stme-pm-ok' : 'stme-pm-advice' }, stability().verdict.text, stability().cachedTokens !== null && stability().cachedTokens !== undefined ? ` The provider reported ${stability().cachedTokens} cached tokens.` : '') : null)),
            computed(() => {
                const advice = stability();
                if (!advice?.recoverableTokens) return null;
                return h('div', { class: 'stme-pm-advice' },
                    h('strong', {}, `${advice.recoverableTokens} stable tokens sit after text that changes every turn.`),
                    h('p', {}, `Changing: ${advice.volatile.join(', ')}. Move these blocks above it (or the changing text lower) to keep them in the provider cache: ${advice.advice.map(item => item.block).join(', ')}.`));
            }),
            computed(() => {
                const list = entries();
                if (!list.length) return EmptyState('No requests yet. Every generation assembled by the Prompt Manager appears here.');
                return h('table', { class: 'stme-pm-table' },
                    h('thead', {}, h('tr', {}, ['Time', 'Preset', 'Tokens', 'Trimmed', 'Shared prefix', 'Changed at'].map(title => h('th', {}, title)))),
                    h('tbody', {}, [...list].reverse().map(item => h('tr', {},
                        h('td', {}, new Date(item.at).toLocaleTimeString()),
                        h('td', {}, item.presetName ?? ''),
                        h('td', {}, `${item.tokens} / ${item.budget}`),
                        h('td', {}, String(item.dropped?.length ?? 0)),
                        h('td', {}, item.cache ? Badge(percent(item.cache.ratio), { tone: item.cache.ratio > 0.8 ? 'ok' : item.cache.ratio > 0.4 ? 'muted' : 'error' }) : '—'),
                        h('td', {}, item.cache?.culprit ? `${item.cache.culprit.block} (${item.cache.culprit.reason})` : '—')))));
            }),
        );
    }
    return { tree, refresh };
}
