import { isDrag } from '../../../libraries/shared/home-model.js';

/**
 * Перетаскивание блока мышью/пером: `pointerdown` на блоке, дальше `pointermove`/`pointerup` на окне (курсор может обогнать блок). Пока сдвиг меньше
 * порога — это клик (`el.__dragged` остаётся `false`, и карточка чата открывается); после порога блок едет за курсором. Касание не перехватываем:
 * на телефоне блоки листаются пальцем, а не таскаются. Ничего не знает про раскладку — считает только сдвиг и сообщает `onMove/onEnd`.
 */
export function attachDrag(el, { win = globalThis, onStart = () => {}, onMove = () => {}, onEnd = () => {} }) {
    const onDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        if (event.pointerType === 'touch') return;
        const startX = event.clientX;
        const startY = event.clientY;
        let dragging = false;
        el.__dragged = false;
        const move = moveEvent => {
            const delta = { dx: moveEvent.clientX - startX, dy: moveEvent.clientY - startY };
            if (!dragging) {
                if (!isDrag(delta)) return;
                dragging = true;
                el.__dragged = true;
                onStart();
            }
            onMove(delta);
        };
        const up = () => {
            win.removeEventListener('pointermove', move);
            win.removeEventListener('pointerup', up);
            win.removeEventListener('pointercancel', up);
            if (dragging) onEnd();
            // Клик после отпускания идёт следом за `pointerup` — флаг сбрасываем позже, чтобы он успел увидеть, что это было перетаскивание.
            win.setTimeout?.(() => { el.__dragged = false; }, 0);
        };
        win.addEventListener('pointermove', move);
        win.addEventListener('pointerup', up);
        win.addEventListener('pointercancel', up);
    };
    el.addEventListener('pointerdown', onDown);
    return () => el.removeEventListener('pointerdown', onDown);
}
