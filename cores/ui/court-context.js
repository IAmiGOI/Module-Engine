import { h } from './tree.js';
import { signal, computed } from './reactive.js';

/**
 * Колесико заполнения контекстного окна резолвера (как у кодинговых моделей):
 * процент от лимита (300 тыс. токенов) в маленьком кольце, по нажатию — полная
 * картина по разделам; каждый раздел раскрывается и показывает свой текст.
 * Данные — `decision.contextReport`, обновление — событие `decision.context.report`.
 */
const COLORS = ['#7c9cff', '#5fc9a8', '#f2b35b', '#e57373', '#b48ce6', '#4fb3d9', '#c9a46b', '#8bc34a', '#f48fb1', '#90a4ae'];
const fmt = value => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value));

export function createCourtContext({ call, subscribe }) {
    const report = signal(null);
    const open = signal(false);

    async function refresh() {
        const answer = await call('decision.contextReport').catch(() => null);
        report.set(answer?.ok && answer.value ? answer.value : null);
    }

    const percent = computed(() => {
        const value = report();
        return value?.limit ? Math.min(100, Math.round((value.total / value.limit) * 100)) : 0;
    });

    function ring() {
        return h('button', {
            type: 'button', class: 'stme-ctx-ring-button', 'on:click': () => { open.set(!open.peek()); if (open.peek()) refresh().catch(() => {}); },
            title: computed(() => (report() ? `Resolver context: ${fmt(report().total)} of ${fmt(report().limit)} tokens` : 'Resolver context: shown after the first turn')),
        },
        h('span', { class: 'stme-ctx-ring', style: computed(() => `background: conic-gradient(var(--stme-accent, #7c9cff) ${percent() * 3.6}deg, var(--stme-level-2, #333) 0deg)`) },
            h('span', { class: 'stme-ctx-ring-hole' })),
        h('span', { class: 'stme-ctx-ring-label' }, computed(() => (report() ? `${percent()}%` : '—'))));
    }

    function panel() {
        const value = report();
        if (!value) return h('div', { class: 'stme-ctx-panel' }, h('div', { class: 'stme-court-empty' }, 'The context is measured on every turn — it appears after the first one.'));
        const sections = [...value.sections].sort((a, b) => b.tokens - a.tokens);
        const share = tokens => (value.limit ? (tokens / value.limit) * 100 : 0);
        return h('div', { class: 'stme-ctx-panel' },
            h('div', { class: 'stme-ctx-head' },
                h('strong', {}, 'Resolver context'),
                h('span', {}, `${fmt(value.total)} / ${fmt(value.limit)} tokens · ${percent()}%`),
                value.turn !== null && value.turn !== undefined ? h('span', { class: 'stme-dw-muted' }, `turn ${value.turn}`) : null),
            h('div', { class: 'stme-ctx-bar' }, ...value.sections.map((section, index) => h('span', {
                key: section.id, class: 'stme-ctx-bar-part', title: `${section.label}: ${fmt(section.tokens)}`,
                style: `width: ${share(section.tokens)}%; background: ${COLORS[index % COLORS.length]}`,
            }))),
            h('div', { class: 'stme-ctx-list' }, ...sections.map(section => {
                const index = value.sections.findIndex(item => item.id === section.id);
                return h('details', { class: 'stme-ctx-section', key: section.id },
                    h('summary', {},
                        h('span', { class: 'stme-ctx-dot', style: `background: ${COLORS[index % COLORS.length]}` }),
                        h('span', { class: 'stme-ctx-name' }, section.label),
                        h('span', { class: 'stme-ctx-tokens' }, `${fmt(section.tokens)} · ${(share(section.tokens)).toFixed(1)}%`)),
                    section.text
                        ? h('pre', { class: 'stme-ctx-text' }, section.text)
                        : h('div', { class: 'stme-dw-muted' }, 'The text is kept only in this page — it appears after the next turn.'));
            })));
    }

    const unsubscribe = typeof subscribe === 'function' ? subscribe('decision.context.report', () => { refresh().catch(() => {}); }) : null;
    refresh().catch(() => {});
    return { ring, panel: () => (open() ? panel() : null), open, refresh, stop: () => unsubscribe?.() };
}
