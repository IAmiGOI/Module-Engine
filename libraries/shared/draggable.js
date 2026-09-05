/**
 * Перетаскивание — поведение, а не виджет: набор обработчиков, который
 * навешивается на «ручку» (шапку окна) и двигает переданный сигнал позиции.
 *
 * Живёт Библиотекой, потому что нужно любому плавающему окну, а не только
 * трекеру: у Alpha перетаскивались и HUD трекера, и dev-panel, и плеер, и
 * каждый писал это у себя.
 *
 * **Почему это не нарушает «Модуль не трогает DOM».** Обработчик получает
 * настоящее событие и читает у него координаты — ровно так же, как любое поле
 * читает `event.target.value`. Ни одного узла отсюда не ищется и не
 * создаётся; всё, что делает эта Библиотека — считает числа и кладёт их в
 * сигнал, а применяет их уже диффинг через обычный проп `style`.
 *
 * Захват указателя (`setPointerCapture`) — единственный способ не потерять
 * перетаскивание, когда курсор ушёл за пределы ручки: без него окно
 * «прилипает» на месте, стоит дёрнуть мышью чуть быстрее.
 */
export function createDragHandlers(positionSignal, { onDrop } = {}) {
    let origin = null; // { pointerX, pointerY, left, top }

    return {
        'on:pointerdown': event => {
            // Только основная кнопка и только не по кнопкам внутри шапки:
            // иначе «свернуть» превращалось бы в микро-перетаскивание.
            if (event.button !== 0 || event.target?.closest?.('button')) return;
            const saved = positionSignal.peek() ?? {};
            // Пока окно ни разу не двигали, у него нет своих left/top — оно
            // стоит там, куда его поставил CSS (например, прижато к правому
            // нижнему углу). Считать в этот момент позицию нулём значит
            // телепортировать окно в левый верхний угол на первом же движении,
            // поэтому начальную точку берём с экрана. Ручка по договору лежит
            // ВНУТРИ перемещаемого элемента — отсюда и `parentElement`.
            const box = saved.left === undefined ? event.currentTarget?.parentElement?.getBoundingClientRect?.() : null;
            origin = {
                pointerX: event.clientX,
                pointerY: event.clientY,
                left: saved.left ?? Math.round(box?.left ?? 0),
                top: saved.top ?? Math.round(box?.top ?? 0),
            };
            event.currentTarget?.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        },
        'on:pointermove': event => {
            if (!origin) return;
            positionSignal.set({
                left: origin.left + (event.clientX - origin.pointerX),
                top: origin.top + (event.clientY - origin.pointerY),
            });
        },
        'on:pointerup': event => {
            if (!origin) return;
            origin = null;
            event.currentTarget?.releasePointerCapture?.(event.pointerId);
            onDrop?.(positionSignal.peek());
        },
    };
}

/**
 * Держит окно в пределах экрана. Вызывается при восстановлении сохранённой
 * позиции: окно, оставленное у края, после смены размера окна браузера
 * оказалось бы за его пределами и стало бы недостижимым.
 */
export function clampToViewport({ left, top }, { width = 0, height = 0, viewportWidth, viewportHeight } = {}) {
    const maxLeft = Math.max(0, (viewportWidth ?? 0) - width);
    const maxTop = Math.max(0, (viewportHeight ?? 0) - height);
    return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(0, top), maxTop),
    };
}
