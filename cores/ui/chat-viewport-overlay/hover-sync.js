import { clampSideMargin } from '../../../libraries/shared/chat-viewport-overlay-math.js';

/**
 * Наведение на чат → панель действий сообщения (cores/ui/chat-viewport/message-tools.js). Слушает движение указателя на обёртке и переводит
 * координаты окна в координаты слоя кадра ядра: `x` — от левого края колонки сообщений, `y` — вертикаль кадра (с поправкой на живой сдвиг
 * прокрутки между кадрами). Считает синхронно по данным события и раскладке — без запросов к DOM на каждое движение; не чаще раза за кадр.
 * Тач игнорируется: у пальца нет «наведения» (там панель не показывается).
 */
export async function startHoverSync({ callOrThrow, chatViewport, refs, layout, sideMargin, pageWidth, win = globalThis }) {
    const { wrapper } = refs;
    let frame = null;
    let last = null;

    const columnLeft = () => layout.left + clampSideMargin(sideMargin(), pageWidth.peek(), layout.minMargin ?? 0);
    const apply = () => {
        frame = null;
        if (!last) return;
        const delta = wrapper.scrollTop - chatViewport.renderedScrollTop();
        chatViewport.hoverAt({ x: last.x - columnLeft(), y: last.y - layout.top + delta });
    };
    const onMove = event => {
        if (event.pointerType === 'touch') return;
        last = { x: event.clientX, y: event.clientY };
        if (frame === null) frame = win.requestAnimationFrame(apply);
    };
    const onLeave = () => { last = null; chatViewport.hoverLeave(); };

    await callOrThrow('dom.setProp', { el: wrapper, key: 'on:pointermove', value: onMove });
    await callOrThrow('dom.setProp', { el: wrapper, key: 'on:pointerleave', value: onLeave });
    return {
        stop: () => {
            last = null;
            callOrThrow('dom.setProp', { el: wrapper, key: 'on:pointermove', value: null }).catch(() => {});
            callOrThrow('dom.setProp', { el: wrapper, key: 'on:pointerleave', value: null }).catch(() => {});
        },
    };
}
