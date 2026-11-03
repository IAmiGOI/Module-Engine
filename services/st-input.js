/**
 * Блокировка родного ввода ST, пока директор ждёт ответа на ask_user.
 * Ядро не трогает DOM напрямую: оно зовёт `stInput.setLocked`, а этот
 * тонкий Сервис — единственное место с `document`.
 */
export function registerStInputService(bus, { document: doc = globalThis.document } = {}) {
    const previous = new Map();
    const byId = id => doc?.getElementById?.(id) ?? null;

    function setLocked({ locked } = {}) {
        const value = Boolean(locked);
        for (const id of ['send_textarea', 'send_but']) {
            const element = byId(id);
            if (!element) continue;
            // send_but в ST — div: `disabled` его не останавливает, поэтому клики закрыты через pointer-events.
            if (value) {
                if (!previous.has(id)) previous.set(id, { disabled: Boolean(element.disabled), pointerEvents: element.style?.pointerEvents ?? '', opacity: element.style?.opacity ?? '' });
                element.disabled = true;
                if (element.style) { element.style.pointerEvents = 'none'; element.style.opacity = '0.4'; }
            } else {
                const before = previous.get(id) ?? { disabled: false, pointerEvents: '', opacity: '' };
                element.disabled = before.disabled;
                if (element.style) { element.style.pointerEvents = before.pointerEvents; element.style.opacity = before.opacity; }
                previous.delete(id);
            }
        }
        return { ok: true, locked: value };
    }

    return bus.register('stInput.setLocked', setLocked);
}
