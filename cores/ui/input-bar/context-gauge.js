/**
 * Колесико заполнения контекста резолвера — отдельный круг справа от пилюли набора
 * (в её стиле, но не её часть). По нажатию — окно над кругом: сколько из 300 тыс.,
 * полоса по разделам и список; раздел раскрывается и показывает свой текст.
 * Обычный DOM, как у пилюли (`pill.js`); данные — `decision.contextReport`.
 */
const COLORS = ['#7c9cff', '#5fc9a8', '#f2b35b', '#e57373', '#b48ce6', '#4fb3d9', '#c9a46b', '#8bc34a', '#f48fb1', '#90a4ae'];
const fmt = value => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value));
export const GAUGE_SIZE = 46;
export const GAUGE_GAP = 8;

export function createContextGauge({ document: doc = globalThis.document, load = async () => null } = {}) {
    const make = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
    const root = make('button', 'stme-ctx-gauge');
    root.setAttribute('type', 'button');
    root.setAttribute('aria-label', 'Resolver context');
    const ring = make('span', 'stme-ctx-gauge-ring');
    const label = make('span', 'stme-ctx-gauge-label', '—');
    ring.append(label);
    root.append(ring);
    const popup = make('div', 'stme-ctx-popup');
    popup.hidden = true;
    let report = null;

    const percent = () => (report?.limit ? Math.min(100, Math.round((report.total / report.limit) * 100)) : 0);

    function paintRing() {
        const value = percent();
        ring.style.background = `conic-gradient(var(--stme-accent) ${value * 3.6}deg, color-mix(in srgb, var(--stme-text) 14%, transparent) 0deg)`;
        label.textContent = report ? `${value}` : '—';
        root.setAttribute('title', report ? `Resolver context: ${fmt(report.total)} of ${fmt(report.limit)} tokens (${value}%)` : 'Resolver context: measured from the first turn');
    }

    function paintPopup() {
        popup.replaceChildren();
        if (!report) { popup.append(make('div', 'stme-ctx-empty', 'The context is measured on every turn — it appears after the first one.')); return; }
        const head = make('div', 'stme-ctx-head');
        head.append(make('strong', '', 'Resolver context'), make('span', '', `${fmt(report.total)} / ${fmt(report.limit)} tokens · ${percent()}%`));
        const bar = make('div', 'stme-ctx-bar');
        report.sections.forEach((section, index) => {
            const part = make('span', 'stme-ctx-bar-part');
            part.style.width = `${report.limit ? (section.tokens / report.limit) * 100 : 0}%`;
            part.style.background = COLORS[index % COLORS.length];
            part.title = `${section.label}: ${fmt(section.tokens)}`;
            bar.append(part);
        });
        const list = make('div', 'stme-ctx-list');
        [...report.sections].map((section, index) => ({ section, index })).sort((a, b) => b.section.tokens - a.section.tokens).forEach(({ section, index }) => {
            const item = make('details', 'stme-ctx-section');
            const summary = make('summary');
            const dot = make('span', 'stme-ctx-dot');
            dot.style.background = COLORS[index % COLORS.length];
            summary.append(dot, make('span', 'stme-ctx-name', section.label), make('span', 'stme-ctx-tokens', `${fmt(section.tokens)} · ${(report.limit ? (section.tokens / report.limit) * 100 : 0).toFixed(1)}%`));
            item.append(summary, section.text ? make('pre', 'stme-ctx-text', section.text) : make('div', 'stme-ctx-empty', 'The text is kept only in this page — it appears after the next turn.'));
            list.append(item);
        });
        popup.append(head, bar, list);
    }

    async function refresh() {
        report = await load().catch(() => null);
        paintRing();
        if (!popup.hidden) paintPopup();
    }

    const onDocumentClick = event => { if (!popup.hidden && !popup.contains(event.target) && !root.contains(event.target)) popup.hidden = true; };
    root.addEventListener('click', () => {
        popup.hidden = !popup.hidden;
        if (!popup.hidden) { paintPopup(); refresh(); }
    });
    paintRing();

    return {
        root,
        mount: parent => { parent.append(root, popup); doc.addEventListener('click', onDocumentClick, true); refresh(); },
        /** Круг — сразу справа от пилюли набора, по её нижней линии; окно — над кругом, по правому краю. */
        place: ({ right, bottom = 9 }) => {
            root.style.left = `${right + GAUGE_GAP}px`;
            root.style.bottom = `${bottom}px`;
            popup.style.right = `${Math.max(8, (doc.documentElement?.clientWidth ?? 0) - (right + GAUGE_GAP + GAUGE_SIZE))}px`;
            popup.style.bottom = `${bottom + GAUGE_SIZE + 8}px`;
        },
        refresh,
        dispose: () => { doc.removeEventListener('click', onDocumentClick, true); root.remove(); popup.remove(); },
    };
}
