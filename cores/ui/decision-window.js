import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, DockButton, Button, Toggle, TextArea, TextInput, Row, Field } from '../../libraries/shared/widgets.js';
import { createFeedState, applyFeedEvent, filterFeed } from '../../libraries/core/decision-feed.js';

/**
 * Окно директора: лента по циклам, как у кодинг-агента. Читает лог и архив
 * через контракты `decision.*`, живые шаги — через события хода. Чистая
 * модель ленты — в `libraries/core/decision-feed.js`; здесь только рисование
 * и поле сообщения. Ни анимации, ни `requestAnimationFrame`.
 */
const UI_NAMESPACE = 'core.ui.decisionWindow';
const WINDOW_KEY = 'window';
const DOCK_KEY = 'dock';
const DEFAULT_SIZE = { width: 760, height: 660 };
const PAGE = 30;

const text = value => String(value ?? '').trim();
const safeJson = value => { try { return JSON.stringify(value ?? null, null, 2); } catch { return String(value ?? ''); } };
const firstLine = value => text(value).split('\n')[0].slice(0, 160);

function clockLabel(minutes) {
    if (!Number.isFinite(Number(minutes))) return '';
    const total = Math.max(0, Math.round(Number(minutes)));
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function cycleMeta(entry) {
    const parts = [];
    if (clockLabel(entry.clockMinutes)) parts.push(`RP ${clockLabel(entry.clockMinutes)}`);
    if (Number.isFinite(entry.turn) && entry.turn !== null) parts.push(`turn ${entry.turn}`);
    if (entry.at) parts.push(new Date(Number(entry.at)).toLocaleTimeString());
    if (entry.running) parts.push('live');
    if (entry.rejected) parts.push('rejected');
    return parts.join(' · ');
}

function usageLine(row) {
    const tokens = row.total || row.prompt + row.completion;
    const seconds = row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(1)} s` : '';
    return `${tokens} tokens (${row.prompt} in / ${row.completion} out, ${row.cached} cached)${seconds}`;
}

function callNode(row) {
    return h('div', { class: `stme-dw-call${row.error ? ' stme-dw-error' : ''}` },
        h('div', { class: 'stme-dw-call-head' },
            h('code', {}, row.name || '?'),
            h('span', { class: 'stme-dw-call-detail' }, row.pending ? 'running…' : (row.error ? 'rejected' : (row.durationMs ? `${row.durationMs} ms` : 'ok')))),
        h('div', { class: 'stme-dw-comment' }, row.comment || '(no comment)'),
        row.pending ? null : h('details', { class: 'stme-dw-fold' },
            h('summary', {}, 'Arguments'),
            h('pre', {}, safeJson(row.args))),
        row.error ? h('div', { class: 'stme-dw-error-text' }, row.error) : h('details', { class: 'stme-dw-fold' },
            h('summary', {}, 'Result'),
            h('pre', {}, safeJson(row.result))));
}

function assessNode(row) {
    const odds = Number.isFinite(row.probability) ? `${Math.round(row.probability * 100)}%` : '—';
    const roll = Number.isFinite(row.roll) ? `roll ${row.roll}` : '';
    return h('div', { class: `stme-dw-assess${row.error ? ' stme-dw-error' : ''}` },
        h('div', { class: 'stme-dw-assess-line' },
            h('strong', {}, row.character || 'someone'), ` · ${row.action || '—'}`,
            h('span', { class: 'stme-dw-assess-odds' }, ` ${odds}${roll ? ` · ${roll}` : ''}${row.degree ? ` · ${row.degree}` : ''}${row.words ? ` — ${row.words}` : ''}`)),
        h('small', { class: 'stme-dw-muted' }, `${row.difficulty || '—'} / ${row.experience || '—'}${row.comment ? ` · ${row.comment}` : ''}`));
}

function formNode(row) {
    return h('div', { class: 'stme-dw-form' },
        h('div', { class: 'stme-dw-block-title' }, 'The form'),
        h('table', { class: 'stme-dw-table' },
            h('thead', {}, h('tr', {}, ['Character', 'Decision', 'Action', 'Outcome'].map(title => h('th', {}, title)))),
            h('tbody', {}, ...row.characters.map(character => h('tr', {},
                h('td', {}, character.name), h('td', {}, character.decision),
                h('td', {}, character.action), h('td', {}, character.outcome))))),
        h('div', { class: 'stme-dw-scene' },
            [row.place ? `place: ${row.place}` : '', row.timeBefore || row.timeAfter ? `time: ${row.timeBefore || '?'} → ${row.timeAfter || '?'}` : '',
                Number.isFinite(Number(row.minutes)) ? `${row.minutes} min` : ''].filter(Boolean).join(' · ')),
        h('div', {}, h('strong', {}, 'Resolution: '), row.resolution),
        h('div', {}, h('strong', {}, "User's result: "), row.userResult));
}

function rowNode(row) {
    if (row.kind === 'thinking') return h('details', { class: 'stme-dw-thinking' }, h('summary', {}, firstLine(row.text)), h('pre', {}, row.text));
    if (row.kind === 'assess') return assessNode(row);
    if (row.kind === 'call') return callNode(row);
    if (row.kind === 'form') return formNode(row);
    if (row.kind === 'push') return h('details', { class: 'stme-dw-push' }, h('summary', {}, 'Push — what the writer received'), h('pre', {}, row.text));
    if (row.kind === 'report') return h('details', { class: 'stme-dw-report' }, h('summary', {}, `Researcher: ${firstLine(row.task) || 'report'}`), h('pre', {}, row.text));
    if (row.kind === 'warning') return h('div', { class: 'stme-dw-warning' }, `⚠ ${row.text}`);
    if (row.kind === 'usage') return h('div', { class: 'stme-dw-usage' }, usageLine(row));
    if (row.kind === 'message') return h('div', { class: 'stme-dw-message' }, h('strong', {}, 'You: '), row.text);
    if (row.kind === 'answer') return h('div', { class: 'stme-dw-answer' }, row.text);
    return null;
}

function cycleNode(entry, now) {
    const classes = ['stme-dw-cycle', entry.running ? 'stme-dw-live' : '', entry.rejected ? 'stme-dw-rejected' : ''].filter(Boolean).join(' ');
    const waiting = entry.waiting && entry.waitingSince ? `thinking… ${Math.max(0, Math.round((now - entry.waitingSince) / 1000))} s` : '';
    return h('div', { class: classes },
        h('div', { class: 'stme-dw-head' }, h('strong', {}, entry.title), h('span', { class: 'stme-dw-meta' }, cycleMeta(entry))),
        entry.detail ? h('div', { class: 'stme-dw-detail' }, entry.detail) : null,
        waiting ? h('div', { class: 'stme-dw-waiting' }, waiting) : null,
        ...entry.rows.map(rowNode));
}

export function createDecisionWindowCore(host, { mount } = {}) {
    const call = (contract, params) => request(host.own, contract, { params });

    const visible = signal(false);
    const collapsed = signal(false);
    const position = signal({});
    const size = signal({ ...DEFAULT_SIZE });
    const dockPosition = signal({ left: 18, top: 120 });
    const feed = signal(createFeedState());
    const showThinking = signal(true);
    const onlyTurns = signal(false);
    const onlyPassive = signal(false);
    const search = signal('');
    const limit = signal(PAGE);
    const draft = signal('');
    const busy = signal(false);
    const note = signal('');
    const now = signal(Date.now());
    const costCounter = signal(true);
    let timer = null;
    const subscriptions = [];

    const filtered = computed(() => filterFeed(feed(), {
        showThinking: showThinking(), onlyTurns: onlyTurns(), onlyPassive: onlyPassive(), showUsage: costCounter(), search: search(),
    }));
    const all = computed(() => filtered().cycles);
    const shown = computed(() => all().slice(-limit()));
    const hiddenCount = computed(() => Math.max(0, all().length - shown().length));

    async function refresh() {
        const [log, archive, settings] = await Promise.all([call('decision.log'), call('decision.archive'), call('decision.settings')]);
        costCounter.set(settings.ok ? settings.value?.costCounter !== false : true);
        feed.set(createFeedState({
            cycles: log.ok && Array.isArray(log.value) ? log.value : [],
            archive: archive.ok && Array.isArray(archive.value) ? archive.value : [],
        }));
        scheduleScroll(true);
    }

    function feedElement() {
        return globalThis.document?.querySelector?.('.stme-dw-feed') ?? null;
    }

    function scheduleScroll(stick = false) {
        const element = feedElement();
        const atBottom = stick || !element || element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        setTimeout(() => {
            const target = feedElement();
            if (target && atBottom) target.scrollTop = target.scrollHeight;
        }, 0);
    }

    function subscribe() {
        const names = [
            'decision.cycle.started', 'decision.cycle.step', 'decision.cycle.thinking', 'decision.tool.called',
            'decision.tool.result', 'decision.cycle.form', 'decision.cycle.finished', 'decision.cycle.failed',
            'decision.cycle.ended', 'decision.message.added',
        ];
        for (const name of names) {
            subscriptions.push(host.events.subscribe(name, payload => {
                feed.set(applyFeedEvent(feed.peek(), name, payload ?? {}));
                scheduleScroll();
            }));
        }
    }

    async function send() {
        const value = text(draft.peek());
        if (!value || busy.peek()) return;
        busy.set(true);
        note.set('');
        try {
            const answer = await call('decision.message', { text: value });
            if (answer.ok) draft.set('');
            else note.set(answer.error?.message ?? 'The message was not sent.');
        } catch (error) {
            note.set(error?.message ?? String(error));
        } finally {
            busy.set(false);
            scheduleScroll(true);
        }
    }

    function body() {
        return h('div', { class: 'stme-panel stme-dw-window-body' },
            h('div', { class: 'stme-dw-toolbar' },
                Toggle('Thinking', showThinking),
                Toggle('Turns only', onlyTurns),
                Toggle('Passive only', onlyPassive),
                TextInput(search, { placeholder: 'Search the feed' })),
            h('div', { class: 'stme-dw-feed', 'on:scroll': () => {} },
                hiddenCount() > 0
                    ? h('div', { class: 'stme-dw-more' }, Button(`Load ${Math.min(PAGE, hiddenCount())} older`, () => limit.update(value => value + PAGE)))
                    : null,
                ...shown().map(entry => cycleNode(entry, now()))),
            computed(() => (filtered().archive.length
                ? h('details', { class: 'stme-dw-archive' }, h('summary', {}, `Archived arcs (${filtered().archive.length})`),
                    ...filtered().archive.map(entry => cycleNode(entry, now())))
                : null)),
            h('div', { class: 'stme-dw-compose' },
                h('div', { class: 'stme-dw-compose-title' }, 'Message the director'),
                TextArea(draft, { placeholder: 'Direction for the story, not an order…', rows: 2 }),
                Row(Button('Send', send, { disabled: busy }), h('small', { class: 'stme-dw-muted' }, 'Goes only to the director log. The chat never sees it.')),
                note() ? h('div', { class: 'stme-dw-warning' }, note()) : null));
    }

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: UI_NAMESPACE, key: WINDOW_KEY,
            value: { visible: visible.peek(), collapsed: collapsed.peek(), position: position.peek(), size: size.peek() },
        });
    }

    async function loadWindowState() {
        const [stored, dock] = await Promise.all([
            call('storage.settings.get', { namespace: UI_NAMESPACE, key: WINDOW_KEY, fallback: {} }),
            call('storage.settings.get', { namespace: UI_NAMESPACE, key: DOCK_KEY, fallback: null }),
        ]);
        const saved = (stored.ok ? stored.value : null) ?? {};
        visible.set(Boolean(saved.visible));
        collapsed.set(Boolean(saved.collapsed));
        const savedSize = saved.size ?? {};
        size.set({ width: savedSize.width > 0 ? savedSize.width : DEFAULT_SIZE.width, height: savedSize.height > 0 ? savedSize.height : DEFAULT_SIZE.height });
        position.set(saved.position ?? { left: Math.max(24, (globalThis.innerWidth ?? 1600) - DEFAULT_SIZE.width - 24), top: 60 });
        if (dock.ok && dock.value?.left !== undefined) dockPosition.set(dock.value);
    }

    const drag = createDragHandlers(position, {
        onDrop: dropped => {
            position.set(clampToViewport(dropped, { ...size.peek(), viewportWidth: globalThis.innerWidth ?? 1600, viewportHeight: globalThis.innerHeight ?? 900 }));
            saveWindowState();
        },
    });
    const dockDrag = createDragHandlers(dockPosition, {
        onDrop: dropped => {
            dockPosition.set(dropped);
            call('storage.settings.set', { namespace: UI_NAMESPACE, key: DOCK_KEY, value: dropped });
        },
        onClick: () => toggle(),
    });

    function tree() {
        return h('div', { class: 'stme-dw-root' },
            computed(() => (visible() ? FloatingPanel('Director', {
                position, size, collapsed, className: 'stme-dw-window', minWidth: 420, minHeight: 300,
                drag,
                onToggle: value => { collapsed.set(value); saveWindowState(); },
                onClose: () => { visible.set(false); saveWindowState(); },
                onResize: next => { size.set(next); saveWindowState(); },
            }, computed(() => body())) : null)),
            DockButton(h('span', { class: 'stme-dw-dock-icon', title: 'Open the director log' }, '◎'), { position: dockPosition, drag: dockDrag, title: 'Director log' }));
    }

    function startTimer() {
        if (timer || !globalThis.document) return;
        timer = setInterval(() => {
            if (!visible.peek()) return;
            const waiting = Object.values(feed.peek().live ?? {}).some(entry => entry.waiting);
            if (waiting) now.set(Date.now());
        }, 1000);
    }

    function stopTimer() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function show() { visible.set(true); saveWindowState(); refresh(); startTimer(); }
    function hide() { visible.set(false); saveWindowState(); stopTimer(); }
    function toggle() { if (visible.peek()) hide(); else show(); }

    async function open() {
        await loadWindowState();
        subscribe();
        await refresh();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        host.events.subscribe('decisionWindow.openRequested', () => toggle());
        return finalUi;
    }

    return {
        tree, open, show, hide, toggle, refresh, send, filtered, feed, now, draft, showThinking, onlyTurns, search,
        isVisible: () => visible.peek(),
        stop() { stopTimer(); for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
