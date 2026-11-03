import { h } from './tree.js';
import { computed, signal } from './reactive.js';

/**
 * Плашка сборки дата-банков: выезжает справа сверху, пока банки строятся,
 * и уезжает через несколько секунд после конца. Живёт вне окна директора —
 * видна и при закрытом окне. Данные — `decision.banks`; «строится сейчас» —
 * по событию `decision.bank.started`, до `ready`/`failed`.
 */
const HIDE_AFTER_MS = 5000;
const text = value => String(value ?? '').trim();

export function createBankProgressView({ host, call, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
    const records = signal([]);
    const building = signal(new Set());
    const shown = signal(false);
    const collapsed = signal(false);
    const subscriptions = [];
    let hideTimer = null;

    const counts = computed(() => {
        const list = records();
        const now = building();
        return {
            total: list.length,
            ready: list.filter(record => record.status === 'ready').length,
            failed: list.filter(record => record.status === 'error').length,
            queued: list.filter(record => (record.status === 'pending' || record.status === 'short') && !now.has(record.sourceKey)).length,
            active: list.filter(record => now.has(record.sourceKey)),
        };
    });

    function busy() {
        const value = counts.peek();
        return value.active.length > 0 || value.queued > 0;
    }

    function settle() {
        if (busy()) {
            if (hideTimer) { clearTimer(hideTimer); hideTimer = null; }
            shown.set(true);
            return;
        }
        if (!shown.peek() || hideTimer) return;
        hideTimer = setTimer(() => { hideTimer = null; if (!busy()) shown.set(false); }, HIDE_AFTER_MS);
    }

    async function refresh() {
        try {
            const result = await call('decision.banks');
            records.set(result?.ok && Array.isArray(result.value) ? result.value : []);
        } catch { /* плашка — подсказка, её сбой ход не трогает */ }
        settle();
    }

    function mark(sourceKey, on) {
        const next = new Set(building.peek());
        if (on) next.add(sourceKey); else next.delete(sourceKey);
        building.set(next);
    }

    function subscribe() {
        subscriptions.push(host.events.subscribe('decision.bank.started', payload => { mark(text(payload?.sourceKey), true); shown.set(true); refresh(); }));
        for (const name of ['decision.bank.ready', 'decision.bank.failed', 'decision.bank.short', 'decision.bank.timeline', 'decision.bank.edited', 'decision.bank.timeout']) {
            subscriptions.push(host.events.subscribe(name, payload => { if (payload?.sourceKey) mark(text(payload.sourceKey), false); refresh(); }));
        }
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { building.set(new Set()); shown.set(false); refresh(); }));
        refresh();
    }

    function row(record, state) {
        return h('div', { class: `stme-bp-row stme-bp-${state}` },
            h('span', { class: 'stme-bp-dot' }),
            h('span', { class: 'stme-bp-name' }, text(record.name) || 'Character'),
            h('span', { class: 'stme-bp-state' }, state === 'active' ? 'building…' : state === 'failed' ? 'failed' : 'queued'));
    }

    function panel() {
        const value = counts();
        const percent = value.total ? Math.round((value.ready / value.total) * 100) : 0;
        const failed = records().filter(record => record.status === 'error');
        const queued = records().filter(record => (record.status === 'pending' || record.status === 'short') && !building().has(record.sourceKey));
        return h('div', { class: `stme-bp${shown() ? ' stme-bp-open' : ''}`, role: 'status', 'aria-live': 'polite' },
            h('div', { class: 'stme-bp-head', 'on:click': () => collapsed.set(!collapsed.peek()) },
                h('span', { class: 'stme-bp-title' }, 'Character banks'),
                h('span', { class: 'stme-bp-count' }, `${value.ready} / ${value.total}`),
                h('span', { class: 'stme-bp-toggle' }, collapsed() ? '▸' : '▾')),
            h('div', { class: 'stme-bp-bar' }, h('div', { class: 'stme-bp-fill', style: { width: `${percent}%` } })),
            collapsed() ? null : h('div', { class: 'stme-bp-list' },
                ...value.active.map(record => row(record, 'active')),
                ...queued.slice(0, 6).map(record => row(record, 'queued')),
                queued.length > 6 ? h('div', { class: 'stme-bp-more' }, `+${queued.length - 6} more queued`) : null,
                ...failed.map(record => row(record, 'failed')),
                !value.active.length && !queued.length ? h('div', { class: 'stme-bp-done' }, value.failed ? `Done — ${value.failed} failed` : 'All banks are ready') : null));
    }

    return {
        tree: () => (records().length ? panel() : null),
        subscribe, refresh,
        stop: () => { if (hideTimer) clearTimer(hideTimer); for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
        state: () => ({ shown: shown.peek(), counts: counts.peek() }),
    };
}
