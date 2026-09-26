import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { buildToolList, isInToolsZone, isOnToolsEdge, computeToolsLayout, TOOLS_PANEL_WIDTH, TOOLS_PANEL_GAP, TOOLS_BUTTON, TOOLS_BUTTON_GAP } from '../../../libraries/shared/message-tools-model.js';

/** Пауза перед скрытием панели, когда курсор ушёл: успеть перейти с плиты на панель через зазор. */
const HIDE_DELAY_MS = 220;
/** Пауза перед перерисовкой после действия: родной обработчик ST успевает обновить сообщение и сохранить чат. */
const REFRESH_DELAY_MS = 180;

const defaultCopy = text => globalThis.navigator?.clipboard?.writeText?.(text);

/**
 * Панель действий сообщения: при наведении на глиф справа от него выезжает небольшое расширение «как продолжение окна» с кнопками родных
 * действий ST (скрыть/показать в промптах, промпт, вложение файла, копирование, свайпы, чекпоинт, ветка; перевод/картинка/озвучка не выводим). Состав кнопок и
 * их порядок — `libraries/shared/message-tools-model.js`; сами действия делают родные обработчики ST (`stChat.triggerNative`), а вьюпорт не теряет
 * ни одной функции родного чата.
 *
 * ОДНА панель на весь вьюпорт (не по экземпляру на сообщение): она едет к глифу под курсором, поэтому DOM и GPU не растут с длиной чата.
 * Лежит в слое хрома, значит вместе с ним едет при прокрутке (сдвиг слоя между кадрами) и позиционируется в тех же координатах кадра.
 * Наведение снимает оверлей (`ui.chatViewport` → `hoverAt`) по координатам события — без запросов к DOM на каждое движение.
 */
export function installMessageTools(ctx) {
    const { s, chromeMounts, serviceOrNull, copyText = defaultCopy } = ctx;

    const state = { open: signal(false), x: signal(0), y: signal(0), tools: signal([]), box: signal({ height: 0, width: 0, rows: 1 }) };
    let current = null;      // { header, target } — глиф, для которого показана панель
    let hideTimer = null;
    let shownFor = 0;        // счётчик показов: устаревший асинхронный показ отбрасывается
    let mountedRoot = null;
    let joinedHeader = null; // глиф, чья плита сейчас срощена с панелью

    const cancelHide = () => { clearTimeout(hideTimer); hideTimer = null; };
    const hideNow = () => { cancelHide(); current = null; state.open.set(false); markJoined(null); };
    const scheduleHide = () => { if (hideTimer !== null || !state.open.peek()) return; hideTimer = setTimeout(hideNow, HIDE_DELAY_MS); };

    function buildTree() {
        return h('div', {
            class: 'stme-msg-tools',
            style: computed(() => ({
                transform: `translate(${state.x()}px, ${state.y()}px)`,
                width: `${state.box().width}px`,
                height: `${state.box().height}px`,
                gridTemplateRows: `repeat(${state.box().rows}, ${TOOLS_BUTTON}px)`,
                gap: `${TOOLS_BUTTON_GAP}px`,
                visibility: state.open() ? 'visible' : 'hidden',
                opacity: state.open() ? '1' : '0',
            })),
            'on:pointerenter': () => cancelHide(),
            'on:pointerleave': () => scheduleHide(),
        }, computed(() => state.tools().map(tool => h('button', {
            type: 'button',
            class: `stme-icon-button stme-msg-tools-btn stme-msg-tools-${tool.id}`,
            title: tool.title,
            'aria-label': tool.title,
            key: tool.id,
            // Кнопки не отбирают фокус (правка/поле ввода остаются как были).
            'on:mousedown': event => event.preventDefault(),
            'on:click': () => { runTool(tool); },
        }, h('i', { class: `fa-solid ${tool.icon} fa-fw` })))));
    }

    /** Монтирует панель в слой хрома (вызывается из `attach`, когда контейнер известен). */
    async function mountTools() {
        if (!chromeMounts || !s.chromeContainer || mountedRoot) return;
        const finalUi = chromeMounts.mount('__messageTools', buildTree());
        await chromeMounts.settled('__messageTools');
        mountedRoot = finalUi.getRoot();
        if (mountedRoot) await serviceOrNull('dom.append', { parent: s.chromeContainer, child: mountedRoot });
    }

    async function unmountTools() {
        if (!mountedRoot) return;
        hideNow();
        chromeMounts?.unmount('__messageTools');
        await serviceOrNull('dom.remove', { node: mountedRoot });
        mountedRoot = null;
    }

    async function showFor(span) {
        const ticket = (shownFor += 1);
        const snapshot = s.snapshot;
        if (!snapshot) return;
        const header = span.headerMesid;
        // Как у кнопок шапки глифа: действия про ФИНАЛЬНОЕ сообщение глифа.
        const target = snapshot.glyphFinalByHeader?.get(header) ?? header;
        const message = snapshot.byMesid.get(target);
        if (!message) return;
        const native = await serviceOrNull('stChat.nativeActions', { mesid: target });
        if (ticket !== shownFor) return;                       // за время запроса курсор ушёл на другой глиф
        state.tools.set(buildToolList({ available: new Set(native?.available ?? []), hidden: Boolean(message.isSystem), hasNativeMessage: Boolean(native?.hasNative) }));
        current = { header, target };
        place(span);
        state.open.set(true);
    }

    /** Раскладка по видимой части глифа (не уезжает вниз за короткое сообщение, не обрезается у нижнего края) + сращивание плиты глифа с панелью. */
    function place(span) {
        const box = computeToolsLayout({ glyphTop: span.top, glyphHeight: span.height, viewportHeight: s.viewportHeight, count: state.tools.peek().length });
        state.x.set(s.viewportWidth + TOOLS_PANEL_GAP);
        state.y.set(box.y);
        state.box.set({ height: box.height, width: box.width, rows: box.rows });
        markJoined(span.headerMesid);
    }

    /** Плита глифа под курсором срастается с панелью (у неё пропадает правый контур и скругления); с предыдущего глифа сращивание снимается. */
    function markJoined(header) {
        if (joinedHeader === header) return;
        if (joinedHeader !== null) ctx.setGlyphJoined?.(joinedHeader, false);
        joinedHeader = header;
        if (header !== null) ctx.setGlyphJoined?.(header, true);
    }

    /**
     * Курсор в координатах слоя кадра: `x` — от левого края плиты глифа, `y` — вертикаль КАДРА (с поправкой на живой сдвиг прокрутки — её делает вызывающий).
     * Курсор над глифом или над самой панелью — панель показана для этого глифа; вне зоны — прячется с задержкой.
     */
    async function hoverAt({ x, y } = {}) {
        if (!chromeMounts || !s.attached || !s.enabled || !mountedRoot) return;
        const spans = s.lastGlyphSpans;
        const zone = isInToolsZone({ x, columnWidth: s.viewportWidth, panelWidth: TOOLS_PANEL_WIDTH, gap: TOOLS_PANEL_GAP });
        const span = zone ? spans.find(item => y >= item.top && y < item.top + item.height) : null;
        if (!span) {
            // Курсор в зазоре или над самой панелью (она ниже глифа, если кнопок больше, чем высота плиты) — панель остаётся, если он на её колонке.
            const onPanel = current && x >= s.viewportWidth && zone && y >= state.y.peek() && y < state.y.peek() + state.box.peek().height;
            if (onPanel) cancelHide(); else scheduleHide();
            return;
        }
        const openHere = current?.header === span.headerMesid && state.open.peek();
        // Панель вызывает и держит только правый край плиты (и сама панель справа); середина глифа её не открывает и не удерживает.
        if (!isOnToolsEdge({ x, columnWidth: s.viewportWidth })) { scheduleHide(); return; }
        cancelHide();
        if (openHere) { place(span); return; }
        await showFor(span);
    }

    /** После кадра: панель держится за свой глиф, если он всё ещё на экране, иначе прячется (глиф уехал или чат сменился). */
    function followFrame() {
        if (!current || !state.open.peek()) return;
        const span = s.lastGlyphSpans.find(item => item.headerMesid === current.header);
        if (span) place(span); else hideNow();
    }

    async function copy(target) {
        const message = s.snapshot?.byMesid.get(target);
        if (message) await copyText(String(message.text ?? ''));
    }

    async function runTool(tool) {
        if (!current) return;
        const { header, target } = current;
        if (tool.id === 'copy') { await copy(target); return; }
        let done = false;
        if (tool.viaNative) done = Boolean(await serviceOrNull('stChat.triggerNative', { mesid: target, action: tool.native }));
        // Родной `.mes` не отрисован ST (или кнопку сейчас не показывает) — скрыть/показать всё равно можем сами (`is_system`).
        if (!done && (tool.id === 'hide' || tool.id === 'unhide')) done = Boolean(await serviceOrNull('stChat.setHidden', { mesid: target, hidden: tool.id === 'hide' }));
        if (!done) return;
        // Скрытие меняет сообщение и кнопку (глаз ↔ зачёркнутый): перечитываем чат и заново собираем состав кнопок для того же глифа.
        if (tool.id === 'hide' || tool.id === 'unhide') {
            setTimeout(async () => {
                await ctx.render({ fresh: true });
                const span = s.lastGlyphSpans.find(item => item.headerMesid === header);
                if (span && current?.header === header) await showFor(span);
            }, REFRESH_DELAY_MS);
        }
    }

    /** Состояние панели для диагностики и тестов; `run(id)` — то же, что нажатие кнопки с этим id. */
    const toolsInfo = () => ({
        open: state.open.peek(), x: state.x.peek(), y: state.y.peek(), tools: state.tools.peek().map(tool => tool.id), target: current?.target ?? null,
        run: id => runTool(state.tools.peek().find(tool => tool.id === id)),
    });

    Object.assign(ctx, { toolsInfo, mountTools, unmountTools, hoverAt, hoverLeave: scheduleHide, followFrame, hideTools: hideNow });
}
