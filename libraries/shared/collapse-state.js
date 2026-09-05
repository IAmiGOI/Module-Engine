import { signal } from '../../cores/ui/reactive.js';
import { request } from './request.js';

/**
 * Память о том, что свёрнуто, а что раскрыто — на весь экран сразу.
 *
 * Живёт отдельной Библиотекой, а не внутри виджета, потому что сами виджеты
 * ЧИСТЫЕ: `Card`/`Section` возвращают дерево и не имеют права ни ходить на
 * шину, ни что-то сохранять. Виджету отдаётся готовая пара «сигнал + что
 * делать при переключении», а откуда она взялась — его не касается.
 *
 * Ключ у каждой сворачиваемой штуки свой и СТАБИЛЬНЫЙ (id карточки, id
 * трекера), иначе состояние переезжало бы на соседа при добавлении элемента
 * в список.
 *
 * По умолчанию всё СВЁРНУТО: экран движка целиком не помещается на страницу,
 * и открытым должно быть то, что пользователь открыл сам, а не всё разом.
 */
export function createCollapseState(bus, { namespace, key = 'collapsed', defaultOpen = false } = {}) {
    const states = new Map(); // id -> signal(boolean)
    let stored = {};

    /** Читает сохранённое ОДИН раз, явно — как и остальная персистентность в движке (см. persisted-list.js про гонку с ранним чтением). */
    async function restore() {
        const result = await request(bus, 'storage.settings.get', { params: { namespace, key, fallback: {} } });
        stored = (result.ok ? result.value : null) ?? {};
        // Уже созданные сигналы догоняют прочитанное: bind() мог сработать
        // раньше restore(), и тогда они стоят на значении по умолчанию.
        for (const [id, state] of states) if (id in stored) state.set(Boolean(stored[id]));
        return { ...stored };
    }

    function save() {
        stored = Object.fromEntries([...states].map(([id, state]) => [id, state.peek()]));
        return request(bus, 'storage.settings.set', { params: { namespace, key, value: stored } });
    }

    /**
     * То, что виджет ждёт в `open`/`onToggle`. Сигнал переиспользуется для
     * одного и того же ключа: пересоздай мы его на каждую перерисовку, любое
     * обновление списка схлопывало бы всё обратно.
     */
    function bind(id, { open = defaultOpen } = {}) {
        if (!states.has(id)) states.set(id, signal(id in stored ? Boolean(stored[id]) : open));
        const state = states.get(id);
        return {
            open: state,
            onToggle: next => {
                if (state.peek() === next) return; // эхо от нашей же записи в DOM — не повод писать на диск
                state.set(next);
                save();
            },
        };
    }

    return { restore, bind, save, state: () => ({ ...stored }) };
}
