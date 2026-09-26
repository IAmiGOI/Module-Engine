import { BOTTOM_THRESHOLD, isNearBottom } from '../../../libraries/shared/chat-viewport-overlay-math.js';

/**
 * Прокрутка оверлея: нативный скролл обёртки → окно рендера Ядра Chat Viewport, рост spacer'а по событию рендера,
 * автопрокрутка вниз при росте, запросы Ядра прокрутить. Возвращает `{ state, stop }`; `state.lastTotalHeight` читает
 * синхронизация геометрии (ей нужно знать, был ли чат прижат к низу до сжатия окна).
 */
export async function startScrollSync({ host, callService, callOrThrow, chatViewport, refs, layout, win = globalThis }) {
    const { wrapper, marginLayer, spacer } = refs;
    const state = { lastTotalHeight: chatViewport.totalHeight() };

    // Между нативным скроллом и следующим закоммиченным кадром слой сдвигается на разницу scrollTop синхронно —
    // движение выглядит как обычный скролл, а не рывки по кадрам.
    const syncScrollOffset = () => {
        const delta = wrapper.scrollTop - chatViewport.renderedScrollTop();
        callService('dom.setProp', { el: marginLayer, key: 'style', value: { transform: delta ? `translateY(${-delta}px)` : '' } });
    };

    // Нативное `scroll` стреляет сотни раз в секунду (трекпад), а `render()` читает `stChat.messages` с нуля по ВСЕЙ истории —
    // это и была просадка плавности (найдено живьём). Схлопываем до одного вызова за кадр; `scrollTop` берётся актуальный на кадр.
    let scrollFrame = null;
    const onScroll = () => {
        syncScrollOffset();
        if (scrollFrame !== null) return;
        scrollFrame = win.requestAnimationFrame(() => {
            scrollFrame = null;
            chatViewport.setViewport({ scrollTop: wrapper.scrollTop });
        });
    };
    await callOrThrow('dom.setProp', { el: wrapper, key: 'on:scroll', value: onScroll });

    // Ядро просит прокрутить (например, к финальному сообщению глифа при правке кнопкой из шапки) — прокруткой владеет обёртка.
    const stopScrollRequest = host.events.subscribe('ui.chatViewport.scrollRequest', async payload => {
        if (Number.isFinite(payload?.scrollTop)) { callService('dom.setScrollPosition', { el: wrapper, top: payload.scrollTop }); return; }
        // `by` — сдвиг на разницу: высоты выше окна уточнились, и чтобы содержимое не подпрыгнуло, прокрутка идёт следом.
        if (Number.isFinite(payload?.by) && payload.by !== 0) {
            const position = await callService('dom.scrollPosition', { el: wrapper });
            if (position.ok) callService('dom.setScrollPosition', { el: wrapper, top: Math.max(0, position.value.top + payload.by) });
        }
    });

    // Автопрокрутка вниз (owner: «текст не мотается вниз при стриминге») — только если пользователь был прижат к низу ДО роста
    // (проверка по СТАРОЙ высоте, `scrollTop` текущий) и чат реально вырос. `grew` — найдено живьём: `render.completed` стреляет на
    // КАЖДЫЙ render, включая вызванный самим onScroll; без условия шаг скролла ВВЕРХ короче порога видел «всё ещё близко к низу»
    // и возвращал `scrollTop` обратно — рывок вместо ухода. Если пользователь сам листает вверх, его позицию не трогаем.
    const stopSpacerSync = host.events.subscribe('ui.chatViewport.render.completed', async payload => {
        syncScrollOffset();
        const nextTotalHeight = payload?.totalHeight ?? chatViewport.totalHeight();
        const grew = nextTotalHeight > state.lastTotalHeight;
        const scrollPos = await callService('dom.scrollPosition', { el: wrapper });
        const rawClientSize = await callService('dom.clientSize', { el: wrapper });
        // Оверлей на всё окно: видимая область чата — за вычетом отступов под панели (`layout`), иначе «прижат к низу» считался бы неверно.
        const clientSize = rawClientSize.ok ? { ok: true, value: { ...rawClientSize.value, height: rawClientSize.value.height - layout.top - layout.bottom } } : rawClientSize;
        const wasAtBottom = grew && !payload?.userToggle && scrollPos.ok && clientSize.ok
            && isNearBottom({ scrollTop: scrollPos.value.top, clientHeight: clientSize.value.height, totalHeight: state.lastTotalHeight, threshold: BOTTOM_THRESHOLD });
        state.lastTotalHeight = nextTotalHeight;
        await callService('dom.setProp', { el: spacer, key: 'style', value: { height: `${nextTotalHeight}px` } });
        if (wasAtBottom && clientSize.ok) {
            await callService('dom.setScrollPosition', { el: wrapper, top: Math.max(0, nextTotalHeight - clientSize.value.height) });
        }
    });

    return { state, stop: () => { stopSpacerSync(); stopScrollRequest(); } };
}
