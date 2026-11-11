import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { Button, Row, Segment, Select } from '../../libraries/shared/widgets.js';

/**
 * Вкладка Telemetry окна The Court: каждый вызов модели и классификатора — кто, зачем, модель, токены, цена, время,
 * исход. Данные — контракт `telemetry.query` (ядро телеметрии), фильтры и группировка — там же. Здесь только рисование.
 */
const PERIODS = Object.freeze([
    { value: '1h', label: 'Hour', ms: 3600e3 }, { value: '24h', label: 'Day', ms: 86400e3 },
    { value: '7d', label: 'Week', ms: 7 * 86400e3 }, { value: 'all', label: 'All', ms: 0 },
]);
const GROUPS = Object.freeze([
    { value: 'purpose', label: 'By role' }, { value: 'model', label: 'By model' }, { value: 'turn', label: 'By turn' },
    { value: 'chat', label: 'By chat' }, { value: 'day', label: 'By day' }, { value: 'status', label: 'By status' },
]);
const STATUSES = Object.freeze(['', 'ok', 'error', 'timeout', 'rate-limited', 'empty', 'stopped']);

const money = value => (value === null || value === undefined ? '—' : `$${Number(value).toFixed(Number(value) < 0.01 ? 5 : 4)}`);
const tokens = value => (Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(1)}k` : String(Number(value) || 0));
const seconds = ms => `${(Number(ms) / 1000).toFixed(1)}s`;
const clock = at => new Date(at).toLocaleString();

export function createCourtTelemetry({ call }) {
    const period = signal('24h');
    const group = signal('purpose');
    const purpose = signal('');
    const model = signal('');
    const status = signal('');
    const chat = signal('');
    const turn = signal(null);
    const data = signal(null);
    const busy = signal(false);
    const note = signal('');

    const filters = () => {
        const span = PERIODS.find(item => item.value === period.peek())?.ms ?? 0;
        return {
            from: span ? Date.now() - span : 0, purpose: purpose.peek(), model: model.peek(), status: status.peek(),
            chatId: chat.peek(), turn: turn.peek(),
        };
    };

    async function load() {
        busy.set(true);
        try {
            const result = await call('telemetry.query', { filters: filters(), by: group.peek() });
            data.set(result?.ok === false ? null : (result?.value ?? result));
            note.set(result?.ok === false ? String(result.error?.message ?? 'Telemetry is not available.') : '');
        } catch (error) { note.set(String(error?.message ?? error)); }
        finally { busy.set(false); }
    }

    async function download(format) {
        const result = await call('telemetry.export', { filters: filters(), format });
        const body = String(result?.value ?? result ?? '');
        const url = URL.createObjectURL(new Blob([body], { type: format === 'json' ? 'application/json' : 'text/csv' }));
        const link = Object.assign(globalThis.document.createElement('a'), { href: url, download: `me-telemetry.${format}` });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const optionList = (values, empty) => [{ value: '', label: empty }, ...(values ?? []).map(value => ({ value, label: value }))];

    function totalsNode(total, count) {
        if (!total) return h('div', { class: 'stme-dw-muted' }, count ? 'No calls match the filters.' : 'No calls recorded yet.');
        return h('div', { class: 'stme-tm-totals' },
            h('strong', {}, money(total.cost)), ` · ${total.calls} calls · ${tokens(total.prompt)} in (${tokens(total.cached)} cached) · ${tokens(total.completion)} out`,
            total.reasoning ? ` · ${tokens(total.reasoning)} reasoning` : '',
            ` · median ${seconds(total.medianMs)}`, total.errors ? ` · ${total.errors} failed` : '', total.retries ? ` · ${total.retries} retries` : '',
            total.unpriced ? h('small', { class: 'stme-dw-muted' }, ` · ${total.unpriced} without a price`) : null);
    }

    function summaryNode(rows) {
        return h('table', { class: 'stme-tm-table' },
            h('thead', {}, h('tr', {}, ...['', 'Calls', 'Cost', 'In', 'Cached', 'Out', 'Median', 'Avg', 'Failed'].map(title => h('th', {}, title)))),
            h('tbody', {}, ...(rows ?? []).map(row => h('tr', {},
                h('td', {}, row.key), h('td', {}, String(row.calls)), h('td', {}, money(row.cost)), h('td', {}, tokens(row.prompt)),
                h('td', {}, tokens(row.cached)), h('td', {}, tokens(row.completion)), h('td', {}, seconds(row.medianMs)),
                h('td', {}, seconds(row.avgMs)), h('td', {}, row.errors ? String(row.errors) : '')))));
    }

    function callsNode(calls) {
        return h('table', { class: 'stme-tm-table stme-tm-calls' },
            h('thead', {}, h('tr', {}, ...['When', 'Role', 'Model', 'In', 'Out', 'Cost', 'Time', 'Status', 'Turn'].map(title => h('th', {}, title)))),
            h('tbody', {}, ...(calls ?? []).map(row => h('tr', { class: row.status === 'ok' ? '' : 'stme-tm-bad', title: row.error || '' },
                h('td', {}, clock(row.at)), h('td', {}, row.purpose || row.caller || '—'), h('td', {}, row.model || '—'),
                h('td', {}, tokens(row.prompt)), h('td', {}, tokens(row.completion)),
                h('td', {}, `${money(row.cost)}${row.costSource === 'table' ? '*' : ''}`), h('td', {}, seconds(row.durationMs)),
                h('td', {}, row.attempts > 1 ? `${row.status} ×${row.attempts}` : row.status),
                h('td', {}, row.turn === null ? '' : h('a', { href: '#', 'on:click': event => { event.preventDefault?.(); chat.set(row.chatId); turn.set(row.turn); load(); } }, `#${row.turn}`))))));
    }

    function tree() {
        const value = data();
        const options = value?.options ?? {};
        return h('div', { class: 'stme-tm' },
            Row(
                Segment(PERIODS.map(({ value: v, label }) => ({ value: v, label })), period, { label: 'Period', onChange: () => load() }),
                Select(group, GROUPS, { onChange: () => load() }),
                Select(purpose, optionList(options.purposes, 'Every role'), { onChange: () => load() }),
                Select(model, optionList(options.models, 'Every model'), { onChange: () => load() }),
                Select(status, STATUSES.map(item => ({ value: item, label: item || 'Every status' })), { onChange: () => load() }),
                Select(chat, optionList(options.chats, 'Every chat'), { onChange: () => { turn.set(null); load(); } }),
                turn() !== null ? Button(`Turn #${turn()} ×`, () => { turn.set(null); load(); }) : null,
                Button('Refresh', () => load(), { disabled: busy }),
                Button('CSV', () => download('csv')), Button('JSON', () => download('json')),
                Button('Clear', async () => { if (globalThis.confirm?.('Delete all recorded telemetry?')) { await call('telemetry.reset'); load(); } })),
            note() ? h('div', { class: 'stme-dw-warning' }, note()) : null,
            totalsNode(value?.total, value?.count),
            value?.summary?.length ? summaryNode(value.summary) : null,
            value?.calls?.length ? h('details', { class: 'stme-tm-feed', open: true }, h('summary', {}, `Calls (${value.calls.length}${value.calls.length >= 500 ? ', newest 500' : ''}) — * price from the OpenRouter table`), callsNode(value.calls)) : null);
    }

    return { load, tree: () => computed(tree) };
}
