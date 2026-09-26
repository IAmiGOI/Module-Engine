import { effect } from '../reactive.js';
import { resolveMargins, dragMargins, marginsWidth } from '../../../libraries/shared/chat-viewport-overlay-math.js';

/**
 * Заужение с боков: отступ (сигнал) → ширина канваса и положение слоя/ручек, плюс перетаскивание ручек мышью.
 * owner: «нужно ТЯНУТЬ физически. Не ползунком где-то там» — поэтому ручки на краях канваса, а не поле в настройках.
 */
export async function startMarginSync({ callService, callOrThrow, chatViewport, refs, pageWidth, margins, layout, onCommit, publish, win = globalThis }) {
    const { marginLayer, leftHandle, rightHandle } = refs;

    // Живое обновление при перетаскивании — БЕЗ цикла disable/enable. `effect()` вызывается сразу при создании, поэтому
    // первый прогон дублирует уже применённые при включении значения — идемпотентно.
    // Справа от колонки оставлено место под панель действий сообщения (`layout.rightSpace`), поэтому колонка уже на эту величину.
    const columnWidth = page => Math.max(1, marginsWidth(page, resolveMargins(margins(), page, layout?.minMargin ?? 0)) - (layout?.rightSpace ?? 0));
    const stopEffect = effect(() => {
        const page = pageWidth();
        const { left } = resolveMargins(margins(), page, layout?.minMargin ?? 0);
        const width = columnWidth(page);
        chatViewport.setViewport({ viewportWidth: width });
        // Колонка сообщений — для пилюли набора текста (cores/ui/input-bar/): она стоит ровно по ней.
        publish?.('ui.chatViewport.columnChanged', { left: left + (layout?.left ?? 0), width });   // в координатах окна: оверлей начинается правее боковой панели
        callService('dom.setProp', { el: marginLayer, key: 'style', value: { left: `${left}px` } });
        callService('dom.setProp', { el: leftHandle, key: 'style', value: { left: `${left}px` } });
        callService('dom.setProp', { el: rightHandle, key: 'style', value: { left: `${left + width}px` } });
    });

    // `pointermove`/`pointerup` вешаются на window напрямую: у Сервисов нет контракта «подписаться на window», а городить его
    // ради одного эфемерного жеста незачем. Каждая ручка двигает СВОЙ край: левая — левый отступ (тянешь влево — колонка шире влево), правая — правый (тянешь
    // вправо — шире вправо); второй край стоит на месте, поэтому колонку можно и сместить в одну сторону. Первый жест разрывает связь отступов (`linked`).
    let stopDrag = null;
    const startDrag = side => startEvent => {
        startEvent.preventDefault();
        const startClientX = startEvent.clientX;
        const minLeft = layout?.minMargin ?? 0;
        const start = resolveMargins(margins(), pageWidth.peek(), minLeft);
        const onMove = moveEvent => { margins.set(dragMargins(side, start, moveEvent.clientX - startClientX, pageWidth.peek())); };
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
    await callOrThrow('dom.setProp', { el: leftHandle, key: 'on:pointerdown', value: startDrag('left') });
    await callOrThrow('dom.setProp', { el: rightHandle, key: 'on:pointerdown', value: startDrag('right') });

    return { stop: () => { stopEffect(); stopDrag?.(); } };
}
