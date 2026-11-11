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


const PALETTE = Object.freeze(['#5b8def', '#e8a33d', '#46b37b', '#c75dd0', '#e05a5a', '#8a8f99', '#3fb6c4']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 760, H = 150, PAD = { l: 52, r: 8, t: 8, b: 20 };

/** SVG-узел из строки: графики рисуются разметкой, без библиотек. */
function svgNode(markup) {
    const holder = globalThis.document?.createElement?.('div');
    if (!holder) return null;
    holder.innerHTML = markup;
    return holder.firstElementChild;
}
const esc = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const tick = (at, bucketMs) => {
    const d = new Date(at);
    return bucketMs >= 86400e3 ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Столбики по времени, сложенные по рядам. */
function stackedBars({ buckets = [], series = [] } = {}, { bucketMs, format = v => String(v), title = '' } = {}) {
    if (!buckets.length) return '';
    const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
    const max = Math.max(...totals, 0) || 1;
    const bw = (W - PAD.l - PAD.r) / buckets.length;
    const y = v => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max);
    let bars = '';
    buckets.forEach((at, i) => {
        let base = 0;
        series.forEach((s, k) => {
            const v = s.values[i] || 0;
            if (!v) return;
            bars += `<rect x="${(PAD.l + i * bw + 0.5).toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" fill="${PALETTE[k % PALETTE.length]}"><title>${esc(s.key)} · ${esc(tick(at, bucketMs))}: ${esc(format(v))}</title></rect>`;
            base += v;
        });
    });
    const step = Math.max(1, Math.ceil(buckets.length / 8));
    const labels = buckets.map((at, i) => (i % step ? '' : `<text x="${(PAD.l + i * bw).toFixed(1)}" y="${H - 5}" class="stme-tm-axis">${esc(tick(at, bucketMs))}</text>`)).join('');
    return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${W} ${H}" class="stme-tm-chart" role="img" aria-label="${esc(title)}">
<text x="4" y="${PAD.t + 8}" class="stme-tm-axis">${esc(format(max))}</text><text x="4" y="${H - PAD.b}" class="stme-tm-axis">0</text>
<line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" class="stme-tm-grid"/>${bars}${labels}</svg>`;
}

/** Линии долей (0…1) по времени: пустые корзины — разрыв линии. */
function rateLines({ buckets = [], series = [] } = {}, { bucketMs, title = '' } = {}) {
    if (!buckets.length) return '';
    const bw = (W - PAD.l - PAD.r) / Math.max(1, buckets.length - 1);
    const y = v => PAD.t + (H - PAD.t - PAD.b) * (1 - v);
    const lines = series.map((s, k) => {
        let d = '', open = false;
        s.values.forEach((v, i) => {
            if (v === null || v === undefined) { open = false; return; }
            d += `${open ? 'L' : 'M'}${(PAD.l + i * bw).toFixed(1)},${y(v).toFixed(1)}`; open = true;
        });
        const dots = s.values.map((v, i) => (v === null || v === undefined ? '' : `<circle cx="${(PAD.l + i * bw).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" fill="${PALETTE[k % PALETTE.length]}"><title>${esc(s.key)} · ${esc(tick(buckets[i], bucketMs))}: ${Math.round(v * 100)}% cached</title></circle>`)).join('');
        return `<path d="${d}" fill="none" stroke="${PALETTE[k % PALETTE.length]}" stroke-width="1.5"/>${dots}`;
    }).join('');
    return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${W} ${H}" class="stme-tm-chart" role="img" aria-label="${esc(title)}">
<text x="4" y="${PAD.t + 8}" class="stme-tm-axis">100%</text><text x="4" y="${H - PAD.b}" class="stme-tm-axis">0%</text>
<line x1="${PAD.l}" y1="${y(0.5)}" x2="${W - PAD.r}" y2="${y(0.5)}" class="stme-tm-grid"/><line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" class="stme-tm-grid"/>${lines}</svg>`;
}

/** Горизонтальные полосы: медиана и p90 времени по ролям. */
function latencyBars(rows = []) {
    if (!rows.length) return '';
    const max = Math.max(...rows.map(r => r.p90), 1);
    const rowH = 18, h = rows.length * rowH + 8, x0 = 150, w = W - x0 - 60;
    const items = rows.map((r, i) => {
        const yy = 4 + i * rowH;
        return `<text x="4" y="${yy + 12}" class="stme-tm-axis">${esc(r.key)}</text>
<rect x="${x0}" y="${yy + 2}" width="${(w * r.p90 / max).toFixed(1)}" height="12" fill="${PALETTE[1]}" opacity="0.45"><title>p90 ${(r.p90 / 1000).toFixed(1)}s</title></rect>
<rect x="${x0}" y="${yy + 2}" width="${(w * r.p50 / max).toFixed(1)}" height="12" fill="${PALETTE[0]}"><title>median ${(r.p50 / 1000).toFixed(1)}s</title></rect>
<text x="${x0 + w + 4}" y="${yy + 12}" class="stme-tm-axis">${(r.p50 / 1000).toFixed(1)}s / ${(r.p90 / 1000).toFixed(1)}s</text>`;
    }).join('');
    return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${W} ${h}" class="stme-tm-chart" role="img" aria-label="Latency by role">${items}</svg>`;
}

function legend(series) {
    return h('div', { class: 'stme-tm-legend' }, ...(series ?? []).map((s, k) => h('span', {}, h('i', { style: `background:${PALETTE[k % PALETTE.length]}` }), s.key)));
}

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


    function statsNode(stats) {
        if (!stats?.calls) return null;
        const pct = value => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);
        const cells = [
            ['Cache hit', pct(stats.cacheRate)], ['Median / p90', `${seconds(stats.p50Ms)} / ${seconds(stats.p90Ms)}`],
            ['Per turn', stats.costPerTurn === null ? '—' : `${money(stats.costPerTurn)} · ${stats.callsPerTurn.toFixed(1)} calls`],
            ['Turns', String(stats.turns)], ['Per call', `${tokens(stats.promptPerCall)} in · ${tokens(stats.completionPerCall)} out`],
            ['Failed', pct(stats.errorRate)],
        ];
        return h('div', { class: 'stme-tm-stats' }, ...cells.map(([label, v]) => h('div', {}, h('small', { class: 'stme-dw-muted' }, label), h('strong', {}, v))));
    }

    function chart(title, markup, series) {
        const node = svgNode(markup);
        return node ? h('div', { class: 'stme-tm-panel' }, h('div', { class: 'stme-tm-title' }, title), node, series ? legend(series) : null) : null;
    }

    function chartsNode(charts) {
        return h('div', { class: 'stme-tm-charts' },
            chart('Cost over time, by role', stackedBars(charts.cost, { bucketMs: charts.bucketMs, format: money, title: 'Cost' }), charts.cost?.series),
            chart('Tokens over time', stackedBars(charts.tokens, { bucketMs: charts.bucketMs, format: tokens, title: 'Tokens' }), charts.tokens?.series),
            chart('Calls over time, by role', stackedBars(charts.calls, { bucketMs: charts.bucketMs, format: v => String(v), title: 'Calls' }), charts.calls?.series),
            chart('Cache hit rate, by role', rateLines(charts.cache, { bucketMs: charts.bucketMs, title: 'Cache' }), charts.cache?.series),
            chart('Latency by role — median and p90', latencyBars(charts.latency), null));
    }

    function alertsNode(alerts, settings) {
        const toggle = h('label', { class: 'stme-tm-toggle' },
            h('input', { type: 'checkbox', checked: settings?.alerts !== false, 'on:change': async event => { await call('telemetry.settings.set', { alerts: Boolean(event?.target?.checked) }); load(); } }),
            ' Notify on cache misses');
        return h('details', { class: 'stme-tm-feed', open: Boolean(alerts?.length) },
            h('summary', {}, `Cache misses (${alerts?.length ?? 0})`), toggle,
            alerts?.length ? h('table', { class: 'stme-tm-table' },
                h('thead', {}, h('tr', {}, ...['When', 'Role', 'Model', 'Input', 'Lost to the miss', 'Was cached', 'Since', 'Turn'].map(t => h('th', {}, t)))),
                h('tbody', {}, ...alerts.map(a => h('tr', { class: 'stme-tm-bad' },
                    h('td', {}, clock(a.at)), h('td', {}, a.purpose || '—'), h('td', {}, a.model || '—'), h('td', {}, tokens(a.prompt)),
                    h('td', {}, tokens(a.lostTokens)), h('td', {}, `${Math.round((a.wasRate ?? 0) * 100)}%`), h('td', {}, `${Math.round(a.sinceMs / 60000)} min`),
                    h('td', {}, a.turn === null || a.turn === undefined ? '' : `#${a.turn}`)))))
                : h('div', { class: 'stme-dw-muted' }, 'No cache misses in this period.'));
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
            statsNode(value?.stats),
            value?.charts ? chartsNode(value.charts) : null,
            alertsNode(value?.alerts, value?.settings),
            value?.summary?.length ? summaryNode(value.summary) : null,
            value?.calls?.length ? h('details', { class: 'stme-tm-feed', open: true }, h('summary', {}, `Calls (${value.calls.length}${value.calls.length >= 500 ? ', newest 500' : ''}) — * price from the OpenRouter table`), callsNode(value.calls)) : null);
    }

    return { load, tree: () => computed(tree) };
}
