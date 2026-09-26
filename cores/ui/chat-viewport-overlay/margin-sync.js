import { effect } from '../reactive.js';
import { clampSideMargin, computeViewportWidth } from '../../../libraries/shared/chat-viewport-overlay-math.js';

/**
 * Заужение с боков: отступ (сигнал) → ширина канваса и положение слоя/ручек, плюс перетаскивание ручек мышью.
 * owner: «нужно ТЯНУТЬ физически. Не ползунком где-то там» — поэтому ручки на краях канваса, а не поле в настройках.
 */
export async function startMarginSync({ callService, callOrThrow, chatViewport, refs, pageWidth, sideMargin, layout, onCommit, publish, win = globalThis }) {
    const { marginLayer, leftHandle, rightHandle } = refs;

    // Живое обновление при перетаскивании — БЕЗ цикла disable/enable. `effect()` вызывается сразу при создании, поэтому
    // первый прогон дублирует уже применённые при включении значения — идемпотентно.
    const stopEffect = effect(() => {
        const page = pageWidth();
        const margin = clampSideMargin(sideMargin(), page, layout?.minMargin ?? 0);
        // Справа от колонки оставлено место под панель действий сообщения (`layout.rightSpace`), поэтому колонка уже на эту величину.
    const width = Math.max(1, computeViewportWidth(page, margin) - (layout?.rightSpace ?? 0));
        chatViewport.setViewport({ viewportWidth: width });
        // Колонка сообщений — для пилюли набора текста (cores/ui/input-bar/): она стоит ровно по ней.
        publish?.('ui.chatViewport.columnChanged', { left: margin + (layout?.left ?? 0), width });   // в координатах окна: оверлей начинается правее боковой панели
        callService('dom.setProp', { el: marginLayer, key: 'style', value: { left: `${margin}px` } });
        callService('dom.setProp', { el: leftHandle, key: 'style', value: { left: `${margin}px` } });
        callService('dom.setProp', { el: rightHandle, key: 'style', value: { left: `${margin + width}px` } });
    });

    // `pointermove`/`pointerup` вешаются на window напрямую: у Сервисов нет контракта «подписаться на window», а городить его
    // ради одного эфемерного жеста незачем. Левая ручка тянется вправо (внутрь), правая — влево (тоже внутрь): знак `dx` разный.
    let stopDrag = null;
    const startDrag = handleSign => startEvent => {
        startEvent.preventDefault();
        const startClientX = startEvent.clientX;
        const startMargin = clampSideMargin(sideMargin(), pageWidth.peek(), layout?.minMargin ?? 0);
        const onMove = moveEvent => {
            const dx = (moveEvent.clientX - startClientX) * handleSign;
            sideMargin.set(clampSideMargin(startMargin + dx, pageWidth.peek(), layout?.minMargin ?? 0));
        };
        const onUp = () => {
            win.removeEventListener('pointermove', onMove);
            win.removeEventListener('pointerup', onUp);
            stopDrag = null;
            onCommit?.();
        };
        win.addEventListener('pointermove', onMove);
        win.addEventListener('pointerup', onUp);
        stopDrag = onUp;
    };
    await callOrThrow('dom.setProp', { el: leftHandle, key: 'on:pointerdown', value: startDrag(1) });
    await callOrThrow('dom.setProp', { el: rightHandle, key: 'on:pointerdown', value: startDrag(-1) });

    return { stop: () => { stopEffect(); stopDrag?.(); } };
}
