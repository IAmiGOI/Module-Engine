const LONG_PRESS_MS = 350;      // касание: удержание без движения поднимает блок (иначе палец листает стол)
const MOVE_TOLERANCE = 8;       // сдвиг больше этого до срабатывания удержания — это прокрутка
const DRAG_THRESHOLD = 5;       // мышь/перо: сдвиг больше этого — перетаскивание, меньше — клик

/**
 * Перестановка блока в потоке: мышь и перо — сразу за порогом сдвига; касание — после удержания (`LONG_PRESS_MS`), пока палец на месте. После срабатывания
 * прокрутку страницы гасим (`touchmove` с `preventDefault`), блок едет за пальцем. Пока жест не сработал, клики блока (открыть чат и т.п.) живут как обычно:
 * `el.__dragged` выставлен только после подъёма. Ничего не знает про раскладку — отдаёт координаты окна в `onStart/onMove/onEnd`.
 */
export function attachReorder(el, { win = globalThis, onStart = () => {}, onMove = () => {}, onEnd = () => {} }) {
    const onDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        const touch = event.pointerType === 'touch';
        const startX = event.clientX;
        const startY = event.clientY;
        let point = { clientX: startX, clientY: startY };
        let active = false;
        let timer = null;
        el.__dragged = false;
        const swallow = moveEvent => { if (moveEvent.cancelable) moveEvent.preventDefault(); };
        const begin = () => {
            active = true;
            el.__dragged = true;
            win.addEventListener('touchmove', swallow, { passive: false });
            win.navigator?.vibrate?.(12);
            onStart(point);
        };
        const move = moveEvent => {
            point = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
            if (!active) {
                const far = Math.hypot(point.clientX - startX, point.clientY - startY);
                if (touch) { if (far > MOVE_TOLERANCE) { win.clearTimeout(timer); finish(false); } return; }
                if (far < DRAG_THRESHOLD) return;
                begin();
            }
            onMove(point);
        };
        function finish(drop) {
            win.clearTimeout(timer);
            win.removeEventListener('pointermove', move);
            win.removeEventListener('pointerup', up);
            win.removeEventListener('pointercancel', up);
            win.removeEventListener('touchmove', swallow);
            el.removeEventListener('contextmenu', swallow);
            const was = active;
            active = false;
            if (was && drop) onEnd(point);
            win.setTimeout?.(() => { el.__dragged = false; }, 0);
        }
        const up = () => finish(true);
        if (touch) {
            timer = win.setTimeout(begin, LONG_PRESS_MS);
            el.addEventListener('contextmenu', swallow);   // долгое нажатие на Android иначе открывает меню
        }
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', up);
        win.addEventListener('pointercancel', up);
    };
    el.addEventListener('pointerdown', onDown);
    return () => el.removeEventListener('pointerdown', onDown);
}
