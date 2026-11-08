import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, DockButton, Button, Toggle, TextArea, TextInput, Row, Segment, Select } from '../../libraries/shared/widgets.js';
import { LANES, LANE_IDS, turnsIn } from '../../libraries/core/court-lanes.js';
import { createCourtLanes } from './court-lanes-view.js';
import { createCourtPreparation } from './court-preparation.js';
import { createCourtFiles } from './court-files.js';
import { createCourtContext } from './court-context.js';
import { createFeedState, applyFeedEvent, filterFeed } from '../../libraries/core/decision-feed.js';
import { writerCheckNode, formCheckNode } from './decision-check-nodes.js';
import { text } from './decision-window-rows.js';
import { createQuestionView } from './decision-questions.js';
import { createBankProgressView } from './decision-bank-progress.js';

/**
 * Окно директора: лента по циклам, как у кодинг-агента. Читает лог и архив
 * через контракты `decision.*`, живые шаги — через события хода. Чистая
 * модель ленты — в `libraries/core/decision-feed.js`; здесь только рисование
 * и поле сообщения. Ни анимации, ни `requestAnimationFrame`.
 */
const UI_NAMESPACE = 'core.ui.decisionWindow';
const WINDOW_KEY = 'window';
const DOCK_KEY = 'dock';
const DEFAULT_SIZE = { width: 1180, height: 700 };
const PAGE = 30;

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
    // The Court: все пять дорожек или одна; ход — фильтр по всем дорожкам сразу (часть 21).
    const mode = signal('all');
    const turnFilter = signal('');
    const limits = Object.fromEntries(LANE_IDS.map(id => [id, signal(PAGE)]));
    const search = signal('');
    const draft = signal('');
    const busy = signal(false);
    const note = signal('');
    const now = signal(Date.now());
    const costCounter = signal(true);
    const showRolls = signal(true);
    const questionView = createQuestionView({ host, call });
    const bankProgress = createBankProgressView({ host, call });
    let timer = null;
    const subscriptions = [];
    const filtered = computed(() => filterFeed(feed(), {
        showThinking: showThinking(), onlyTurns: onlyTurns(), onlyPassive: onlyPassive(), showUsage: costCounter(), showRolls: showRolls(), search: search(),
    }));
    const all = computed(() => filtered().cycles);
    const archiveOpen = signal(false);
    const files = createCourtFiles({ call });
    // Путь файла в ленте — кнопка: открывает этот файл во вкладке Files.
    const openFile = path => { setMode('files'); files.openPath(path).catch(() => {}); };
    // Плашка подготовки и Canon — над дорожками, пока игра не открыта.
    const preparation = createCourtPreparation({
        call,
        subscribe: (name, handler) => host.events.subscribe(name, handler),
        onOpenCounsellor: () => setMode('counsellor'),
    });
    // Колесико заполнения контекста резолвера — в панели инструментов; по нажатию — разделы.
    const contextGauge = createCourtContext({ call, subscribe: (name, handler) => host.events.subscribe(name, handler) });
    const court = createCourtLanes({
        entries: all, mode, turn: turnFilter, now, limits, openFile,
        header: () => preparation.tree(),
    });
    const archiveLimits = Object.fromEntries(LANE_IDS.map(id => [id, signal(PAGE)]));
    const archiveCourt = createCourtLanes({ entries: computed(() => filtered().archive), mode, turn: () => '', now, limits: archiveLimits });
    const turnOptions = computed(() => [{ value: '', label: 'All turns' }, ...turnsIn(all()).reverse().map(turn => ({ value: String(turn), label: `Turn ${turn}` }))]);
    let reloadAsked = false;
    async function refresh() {
        let [log, archive, settings, game] = await Promise.all([call('decision.log'), call('decision.archive'), call('decision.settings'), call('decision.gameSettings')]);
        // Пустой журнал при открытом чате — чаще всего ядро прочитало память раньше ST: один раз попросить перечитать.
        if (!reloadAsked && log.ok && Array.isArray(log.value) && !log.value.length) {
            reloadAsked = true;
            await call('decision.reload').catch(() => null);
            [log, archive] = await Promise.all([call('decision.log'), call('decision.archive')]);
        }
        costCounter.set(settings.ok ? settings.value?.costCounter !== false : true);
        showRolls.set(game.ok ? game.value?.values?.showRolls !== 'hidden' : true);
        feed.set(createFeedState({
            cycles: log.ok && Array.isArray(log.value) ? log.value : [],
            archive: archive.ok && Array.isArray(archive.value) ? archive.value : [],
            live: feed.peek().live,
        }));
        scheduleScroll(true);
    }

    const feedElements = () => [...(globalThis.document?.querySelectorAll?.('.stme-court-feed') ?? [])];

    // Каждая дорожка прокручивается вниз, только если и так стояла внизу: читающего выше не дёргаем.
    function scheduleScroll(stick = false) {
        const atBottom = new Map(feedElements().map(element => [element.closest('[data-lane]')?.dataset?.lane, stick || element.scrollHeight - element.scrollTop - element.clientHeight < 120]));
        setTimeout(() => {
            for (const element of feedElements()) {
                const lane = element.closest('[data-lane]')?.dataset?.lane;
                if (atBottom.get(lane) ?? true) element.scrollTop = element.scrollHeight;
            }
        }, 0);
    }

    function subscribe() {
        const names = [
            'decision.cycle.started', 'decision.cycle.step', 'decision.cycle.thinking', 'decision.tool.called',
            'decision.tool.result', 'decision.cycle.form', 'decision.cycle.finished', 'decision.cycle.failed',
            'decision.cycle.ended', 'decision.message.added', 'decision.writer.check', 'decision.form.check',
            'decision.cycle.writing',
        ];
        for (const name of names) {
            subscriptions.push(host.events.subscribe(name, payload => {
                feed.set(applyFeedEvent(feed.peek(), name, payload ?? {}));
                scheduleScroll();
            }));
        }
        // Смена чата: ядро перечитало память — лента и банки этого чата сразу, без переоткрытия окна. Живые циклы старого чата не тащим.
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { reloadAsked = false; feed.set(createFeedState({ cycles: [], archive: [] })); }));
        subscriptions.push(host.events.subscribe('decision.reloaded', () => { refresh().catch(() => {}); }));
        subscriptions.push(host.events.subscribe('decision.gameSettings.changed', payload => {
            showRolls.set(payload?.values?.showRolls !== 'hidden');
        }));
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

    function onKey(event) {
        const key = String(event?.key ?? '');
        if ((event.ctrlKey || event.metaKey) && /^[0-5]$/.test(key)) {
            event.preventDefault?.();
            setMode(key === '0' ? 'all' : LANE_IDS[Number(key) - 1]);
        } else if (key === '/' && !/input|textarea/i.test(event.target?.tagName ?? '')) {
            event.preventDefault?.();
            globalThis.document?.querySelector?.('.stme-court-search input, input.stme-court-search')?.focus?.();
        } else if (key === 'Escape' && !/input|textarea/i.test(event.target?.tagName ?? '')) hide();
    }

    function setMode(value) {
        mode.set(value);
        saveWindowState();
        if (value === 'files') files.load().catch(() => {});
        else scheduleScroll(true);
    }

    function body() {
        return h('div', { class: 'stme-panel stme-dw-window-body', tabindex: '-1', 'on:keydown': onKey },
            h('div', { class: 'stme-dw-toolbar' },
                Segment([{ value: 'all', label: 'All five' }, ...LANES.map(lane => ({ value: lane.id, label: lane.label })), { value: 'files', label: 'Files' }], mode, { label: 'Lanes', onChange: setMode }),
                Select(turnFilter, () => turnOptions(), { onChange: () => scheduleScroll(true) }),
                h('span', { class: 'stme-court-search' }, TextInput(search, { placeholder: 'Search  (/)' })),
                Toggle('Thinking', showThinking),
                contextGauge.ring()),
            computed(() => contextGauge.panel()),
            computed(() => (mode() === 'files' ? files.tree() : court.tree())),
            computed(() => (filtered().archive.length
                // Архив строится, только когда его раскрыли.
                ? h('details', { class: 'stme-dw-archive', 'on:toggle': event => archiveOpen.set(Boolean(event?.target?.open)) }, h('summary', {}, `Archived arcs (${filtered().archive.length})`),
                    ...(archiveOpen() ? [archiveCourt.tree()] : []))
                : null)),
            h('div', { class: 'stme-dw-compose' },
                h('div', { class: 'stme-dw-compose-title' }, 'Message the Counsellor'),
                TextArea(draft, { placeholder: 'A wish about the story, or a question — the Counsellor answers…', rows: 2 }),
                Row(Button('Send', send, { disabled: busy }), h('small', { class: 'stme-dw-muted' }, 'Goes only to the Counsellor. The chat never sees it.')),
                note() ? h('div', { class: 'stme-dw-warning' }, note()) : null));
    }

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: UI_NAMESPACE, key: WINDOW_KEY,
            value: { visible: visible.peek(), collapsed: collapsed.peek(), position: position.peek(), size: size.peek(), mode: mode.peek() },
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
        if (saved.mode === 'all' || saved.mode === 'files' || LANE_IDS.includes(saved.mode)) mode.set(saved.mode);
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
            computed(() => (visible() ? FloatingPanel('The Court', {
                position, size, collapsed, className: 'stme-dw-window', minWidth: 420, minHeight: 300,
                drag,
                onToggle: value => { collapsed.set(value); saveWindowState(); },
                onClose: () => { visible.set(false); saveWindowState(); },
                onResize: next => { size.set(next); saveWindowState(); },
            }, computed(() => body())) : null)),
            computed(() => questionView.tree()),
            computed(() => bankProgress.tree()),
            DockButton(h('span', { class: 'stme-dw-dock-icon', title: 'Open The Court' }, '◎'), { position: dockPosition, drag: dockDrag, title: 'The Court' }));
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
        questionView.subscribe();
        bankProgress.subscribe();
        preparation.start();
        await refresh();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        host.events.subscribe('decisionWindow.openRequested', () => toggle());
        return finalUi;
    }

    return {
        tree, open, show, hide, toggle, refresh, send, filtered, feed, now, draft, showThinking, onlyTurns, search, mode, turnFilter, court, files,
        isVisible: () => visible.peek(),
        stop() { stopTimer(); questionView.stop(); bankProgress.stop(); preparation.stop(); for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
