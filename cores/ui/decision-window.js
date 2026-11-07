import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, DockButton, Button, Toggle, TextArea, TextInput, Row, Field } from '../../libraries/shared/widgets.js';
import { createFeedState, applyFeedEvent, filterFeed } from '../../libraries/core/decision-feed.js';
import { createBanksView } from './decision-banks-view.js';
import { writerCheckNode, formCheckNode } from './decision-check-nodes.js';
import { rowNode, cycleNode, text, firstLine, safeJson } from './decision-window-rows.js';
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
const DEFAULT_SIZE = { width: 760, height: 660 };
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
    const search = signal('');
    const limit = signal(PAGE);
    const draft = signal('');
    const busy = signal(false);
    const note = signal('');
    const now = signal(Date.now());
    const costCounter = signal(true);
    const showRolls = signal(true);
    const banksView = createBanksView({ call });
    const questionView = createQuestionView({ host, call });
    const bankProgress = createBankProgressView({ host, call });
    let timer = null;
    const subscriptions = [];
    const filtered = computed(() => filterFeed(feed(), {
        showThinking: showThinking(), onlyTurns: onlyTurns(), onlyPassive: onlyPassive(), showUsage: costCounter(), showRolls: showRolls(), search: search(),
    }));
    const all = computed(() => filtered().cycles);
    const shown = computed(() => all().slice(-limit()));
    const hiddenCount = computed(() => Math.max(0, all().length - shown().length));
    const archiveOpen = signal(false);
    // Готовый цикл — тот же объект записи, пока он не изменился: тот же узел, и рендерер его не трогает.
    // Живой (с таймером ожидания) строится заново — его запись и так новая на каждое событие.
    const nodeCache = new WeakMap();
    const nodeFor = entry => {
        if (entry.running || entry.waiting) return cycleNode(entry, now);
        if (!nodeCache.has(entry)) nodeCache.set(entry, cycleNode(entry, now));
        return nodeCache.get(entry);
    };
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
        await banksView.refresh();
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
            'decision.cycle.ended', 'decision.message.added', 'decision.writer.check', 'decision.form.check',
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
        for (const name of ['decision.bank.ready', 'decision.bank.failed', 'decision.bank.short', 'decision.bank.edited', 'decision.bank.timeout']) {
            subscriptions.push(host.events.subscribe(name, () => banksView.refresh()));
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
            banksView.section(),
            h('div', { class: 'stme-dw-feed', 'on:scroll': () => {} },
                hiddenCount() > 0
                    ? h('div', { class: 'stme-dw-more' }, Button(`Load ${Math.min(PAGE, hiddenCount())} older`, () => limit.update(value => value + PAGE)))
                    : null,
                ...shown().map(nodeFor)),
            computed(() => (filtered().archive.length
                // Архив строится, только когда его раскрыли: десятки циклов с мыслями перестраивались на каждое событие хода.
                ? h('details', { class: 'stme-dw-archive', 'on:toggle': event => archiveOpen.set(Boolean(event?.target?.open)) }, h('summary', {}, `Archived arcs (${filtered().archive.length})`),
                    ...(archiveOpen() ? filtered().archive.map(nodeFor) : []))
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
            computed(() => questionView.tree()),
            computed(() => bankProgress.tree()),
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
        questionView.subscribe();
        bankProgress.subscribe();
        await refresh();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        host.events.subscribe('decisionWindow.openRequested', () => toggle());
        return finalUi;
    }

    return {
        tree, open, show, hide, toggle, refresh, send, filtered, feed, now, draft, showThinking, onlyTurns, search,
        isVisible: () => visible.peek(),
        stop() { stopTimer(); questionView.stop(); bankProgress.stop(); for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
