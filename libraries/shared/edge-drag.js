/**
 * Перетаскивание элемента, ПРИЖАТОГО к краю экрана, вдоль этого края —
 * поведение, а не виджет: набор обработчиков для зоны пилюли-дока
 * (`addLauncherDock` в index.js).
 *
 * Живёт Библиотекой по той же причине, что и [draggable.js](./draggable.js):
 * свободное перемещение окон уже было там, а движение ВДОЛЬ КРАЯ — отдельный
 * контракт со своими правилами (одна ось, клэмп по вьюпорту, порог «драг или
 * клик», сохранение места) — и второй потребитель его потребует снова.
 *
 * Правила контракта:
 *  - **Одна ось.** Двигается только `bottom`, прижатие к краю не разрывается —
 *    в отличие от свободных окон, здесь пользователь тянет «по рельсе».
 *  - **Порог 4px** до старта перетаскивания: без него пара пикселей дрожи
 *    руки превращала клик по кнопке в микро-драг, а отпускание кнопки после
 *    драга досылает `click`, который гасится (`suppressClick` — включается
 *    ТОЛЬКО когда перетаскивание реально было).
 *  - **Pointer Events, но не touch:** на тач-поверхности у дока свой контракт
 *    «тап раскрывает» (index.js, ветка isMobileSurface), pointer-драг пальцем
 *    конфликтовал бы с ним — поэтому touch-события игнорируются.
 *  - **Место сохраняется через переданный `storage`** (по договору —
 *    `localStorage`): пилюля живёт мимо дерева Ядер и до storage-Сервиса
 *    движка не добирается. Чтение защитное — битая запись не роняет
 *    инициализацию.
 */
const DRAG_THRESHOLD_PX = 4;

export function createEdgeDrag({
    storage, getViewportHeight, getHeight, getBottom, setBottom,
}) {
    let drag = null;
    let suppressClick = false;

    /** Восстановить сохранённое место. Битая/чужая запись = «места нет», элемент остаётся там, где его поставил CSS. */
    function restore() {
        const saved = Number(storage.getItem());
        if (!Number.isFinite(saved) || saved <= 0) return;
        const maxBottom = Math.max(0, getViewportHeight() - getHeight());
        setBottom(Math.min(saved, maxBottom));
    }

    return {
        restore,
        /** `true`, если только что было перетаскивание — для гашения досланного `click`. */
        get suppressClick() { return suppressClick; },
        'on:pointerdown': event => {
            if (event.pointerType === 'touch' || event.button !== 0) return;
            drag = {
                startY: event.clientY,
                // Текущий отступ снизу приходит ЗВОНИТЕЛЕМ (getBottom): сам
                // элемент этой Библиотеке не показан — читать rect она не умеет
                // и не должна (тот же договор «только числа», что у draggable.js).
                startBottom: getBottom(),
                moved: false,
            };
            event.currentTarget?.setPointerCapture?.(event.pointerId);
        },
        'on:pointermove': event => {
            if (!drag) return;
            const dy = event.clientY - drag.startY;
            // До порога движение НЕ считается драгом: это ещё клик.
            if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
            drag.moved = true;
            const maxBottom = Math.max(0, getViewportHeight() - getHeight());
            // Движение ВВЕРХ мыши (dy < 0) увеличивает отступ снизу — потому
            // вычитание, а не сложение.
            drag.bottom = Math.min(Math.max(0, drag.startBottom - dy), maxBottom);
            setBottom(drag.bottom);
        },
        'on:pointerup': event => {
            if (!drag) return;
            event.currentTarget?.releasePointerCapture?.(event.pointerId);
            if (drag.moved) {
                // Гасим клик, который браузер досыплет ПОСЛЕ отпускания:
                // иначе «перетащил док» означало бы «и заодно нажал кнопку».
                // Реальный drag — единственное условие: клик БЕЗ движения
                // должен оставаться кликом.
                suppressClick = true;
                setTimeout(() => { suppressClick = false; }, 0);
                storage.setItem?.(String(drag.bottom));
            }
            drag = null;
        },
        'on:pointercancel': () => { drag = null; },
    };
}
