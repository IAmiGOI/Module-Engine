import { h } from './tree.js';
import { computed } from './reactive.js';
import { Button } from '../../libraries/shared/widgets.js';
import { LANES, lanesFrom, workingLanes } from '../../libraries/core/court-lanes.js';
import { cycleNode } from './decision-window-rows.js';

/**
 * Дорожки окна The Court: по колонке на роль (или одна в фокусе), строка
 * состояния и кеш узлов — неизменившаяся запись не перерисовывается (часть 21).
 */
const PAGE = 30;
const sameRows = (a, b) => a.length === b.length && a.every((row, index) => row === b[index]);

export function createCourtLanes({ entries, mode, turn, now, limits, openFile = null, header = null }) {
    const cache = new Map();
    const nodeFor = (part, open) => {
        if (part.running || part.waiting) return cycleNode(part, now, { open: true, openFile });
        const key = `${part.id}|${part.lane}|${open ? 1 : 0}`;
        const hit = cache.get(key);
        if (hit && sameRows(hit.rows, part.rows) && hit.title === part.title && hit.rejected === part.rejected) return hit.node;
        const node = cycleNode(part, now, { open, openFile });
        cache.set(key, { rows: part.rows, title: part.title, rejected: part.rejected, node });
        return node;
    };
    const lanes = computed(() => lanesFrom(entries(), { turn: turn() || null }));

    function laneNode(lane) {
        const list = lanes()[lane.id] ?? [];
        const limit = limits[lane.id]();
        const shown = list.slice(-limit);
        const hidden = list.length - shown.length;
        const working = workingLanes(entries()).includes(lane.id);
        return h('section', { class: `stme-court-lane stme-court-lane-${lane.id}${working ? ' stme-court-working' : ''}`, 'data-lane': lane.id },
            h('header', { class: 'stme-court-lane-head' },
                h('span', { class: 'stme-court-lane-title' }, lane.label),
                working ? h('span', { class: 'stme-court-pulse', title: `${lane.label} is working` }) : null,
                h('span', { class: 'stme-court-lane-count' }, String(list.length))),
            h('div', { class: 'stme-dw-feed stme-court-feed' },
                hidden > 0 ? h('div', { class: 'stme-dw-more' }, Button(`Load ${Math.min(PAGE, hidden)} older`, () => limits[lane.id].update(value => value + PAGE))) : null,
                shown.length ? null : h('div', { class: 'stme-court-empty' }, lane.empty),
                ...shown.map((part, index) => nodeFor(part, index === shown.length - 1))));
    }

    function statusNode() {
        const all = entries();
        const working = workingLanes(all).map(id => LANES.find(lane => lane.id === id)?.label).filter(Boolean);
        let queues = null;
        let telegram = null;
        for (const entry of all) {
            for (const row of entry.rows ?? []) {
                if (row.kind === 'queues') queues = row;
                if (row.kind === 'telegram') telegram = row.blocked ? row : null;
                if (row.kind === 'call' && row.name === 'decree' && !row.error) telegram = null;
            }
        }
        const waitingPetitions = (queues?.petitions ?? []).filter(item => item.status === 'queued').length;
        const waitingPrayers = (queues?.prayers ?? []).filter(item => item.status === 'queued').length;
        const parts = [
            working.length ? `${working.join(', ')} working` : 'Everyone rests',
            `${waitingPetitions} Petition${waitingPetitions === 1 ? '' : 's'} waiting`,
            `${waitingPrayers} Prayer${waitingPrayers === 1 ? '' : 's'} waiting`,
        ];
        return h('div', { class: `stme-court-status${telegram ? ' stme-court-telegram' : ''}` },
            ...parts.map(part => h('span', {}, part)),
            telegram ? h('span', { class: 'stme-court-telegram-note' }, 'A Telegram holds the next turn until the Director answers') : null);
    }

    function tree() {
        const visible = mode() === 'all' ? LANES : LANES.filter(lane => lane.id === mode());
        return h('div', { class: 'stme-court' },
            header ? header() : null,
            statusNode(),
            h('div', { class: `stme-court-lanes${mode() === 'all' ? ' stme-court-all' : ' stme-court-one'}` }, ...visible.map(laneNode)));
    }

    return { tree, lanes };
}
