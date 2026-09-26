import { BOTTOM_THRESHOLD, INPUT_PANEL_GAP, isNearBottom } from '../../../libraries/shared/chat-viewport-overlay-math.js';

/**
 * Геометрия оверлея следует за страницей. Оверлей лежит на всё окно; «видимая область» чата — то, что между верхней панелью ST и
 * панелью ввода (`#form_sheld`): нижний отступ `layout.bottom` = расстояние от верха панели ввода до низа окна, ширина — ширина `body`.
 * Раньше размер фиксировался один раз при включении: когда текст в поле ввода растёт на несколько строк, панель поднимается
 * (родной `#chat` скрыт и оттеснить её не может), а когда Chrome показывает и убирает свою панель или окно меняет размер,
 * канвас и чат оставались прежнего размера.
 *
 * Синхронизации не накладываются: пока идёт одна, новая только помечает «повторить» — иначе гонка замеров и записей.
 */
export async function startGeometrySync({ host, callService, chatViewport, refs, body, layout, initial, pageWidth, scrollState, win = globalThis }) {
    const { wrapper, stickyLayer } = refs;
    // «Панель ввода» — собственная пилюля набора (`.stme-input-bar`, cores/ui/input-bar/), пока она включена, иначе родной `#form_sheld`.
    // Ищется на КАЖДОЙ синхронизации: пилюля появляется/исчезает вместе с оверлеем и растёт вместе с текстом (событие `ui.inputBar.changed`).
    const findInputPanel = async () => {
        for (const [selector, gap] of [['.stme-input-bar', INPUT_PANEL_GAP], ['#form_sheld', 0]]) {
            const found = await callService('dom.querySelector', { el: body, selector });
            if (found.ok && found.value) return { el: found.value, gap };
        }
        return null;
    };
    const initialPanel = (await findInputPanel())?.el ?? null;
    let currentHeight = initial.height;
    let lastBodyWidth = initial.pageWidth;
    let syncing = false;
    let syncAgain = false;

    const syncWidth = async () => {
        const bodySize = await callService('dom.clientSize', { el: body });
        if (!(bodySize.ok && bodySize.value.width > 0 && bodySize.value.width !== lastBodyWidth)) return;
        lastBodyWidth = bodySize.value.width;
        await callService('dom.setProp', { el: wrapper, key: 'style', value: { width: `${bodySize.value.width - layout.left}px` } });
        const wrapperSize = await callService('dom.clientSize', { el: wrapper });
        if (wrapperSize.ok && wrapperSize.value.width > 0) pageWidth.set(wrapperSize.value.width);
    };

    const syncHeight = async () => {
        const wrapperSize = await callService('dom.clientSize', { el: wrapper });
        if (!(wrapperSize.ok && wrapperSize.value.height > 0)) return;
        const fullHeight = wrapperSize.value.height;
        let nextBottom = layout.bottom;
        const panel = await findInputPanel();
        if (panel) {
            const panelRect = await callService('dom.measureRect', { el: panel.el });
            // `gap` — воздух между последним сообщением и собственной пилюлей набора (у родной панели ввода его нет).
            if (panelRect.ok && panelRect.value.height > 0) nextBottom = Math.max(0, Math.round(fullHeight - panelRect.value.top + panel.gap));
        }
        const nextHeight = Math.max(120, fullHeight - layout.top - nextBottom);
        if (nextHeight === currentHeight && nextBottom === layout.bottom) return;
        const scrollPos = await callService('dom.scrollPosition', { el: wrapper });
        const previousHeight = currentHeight;
        const wasAtBottom = scrollPos.ok && isNearBottom({
            scrollTop: scrollPos.value.top, clientHeight: previousHeight, totalHeight: scrollState.lastTotalHeight, threshold: BOTTOM_THRESHOLD,
        });
        currentHeight = nextHeight;
        layout.bottom = nextBottom;
        await callService('dom.setProp', { el: wrapper, key: 'style', value: { paddingBottom: `${nextBottom}px` } });
        await callService('dom.setProp', { el: stickyLayer, key: 'style', value: { height: `${nextHeight}px`, marginBottom: `${-nextHeight}px` } });
        if (wasAtBottom && scrollPos.ok) {
            // Чат прижат к низу — сохраняем это: содержимое едет вверх вместе с поднявшейся панелью.
            await callService('dom.setScrollPosition', { el: wrapper, top: Math.max(0, scrollPos.value.top + (previousHeight - nextHeight)) });
        }
        chatViewport.setViewport({ viewportHeight: nextHeight, scrollTop: wrapper.scrollTop });
    };

    const syncNow = async () => {
        if (syncing) { syncAgain = true; return; }
        syncing = true;
        try {
            do {
                syncAgain = false;
                await syncWidth();
                await syncHeight();
            } while (syncAgain);
        } finally {
            syncing = false;
        }
    };

    let resizeFrame = null;
    const onWindowResize = () => {
        if (resizeFrame !== null) return;
        resizeFrame = win.requestAnimationFrame(() => { resizeFrame = null; syncNow(); });
    };
    win.addEventListener('resize', onWindowResize);
    await callService('dom.observeResize', { el: body, handler: syncNow });
    if (initialPanel) await callService('dom.observeResize', { el: initialPanel, handler: syncNow });
    const stopInputBar = host?.events?.subscribe?.('ui.inputBar.changed', () => { syncNow(); });

    return {
        syncNow,
        stop: () => {
            win.removeEventListener('resize', onWindowResize);
            stopInputBar?.();
            callService('dom.unobserveResize', { el: body, handler: syncNow });
            if (initialPanel) callService('dom.unobserveResize', { el: initialPanel, handler: syncNow });
        },
    };
}
