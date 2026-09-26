import { characterBlockId } from '../../../libraries/shared/home-model.js';

/**
 * Карточки персонажей на рабочем столе: список файлов аватаров в состоянии стола (`state.cards`) и три контракта Шины для тех, кто им управляет
 * (виджет «Characters» и любой другой): `desktop.cards.add { avatar }`, `desktop.cards.remove { avatar }`, `desktop.cards.list`. Изменение — сохранение,
 * перерисовка и событие `ui.home.cardsChanged`, чтобы подписчики (виджет) обновили свои галочки.
 */
export function createCardsApi({ host, state, save, requestRender, emit }) {
    const changed = () => { void save(); requestRender(); emit?.('ui.home.cardsChanged', { cards: [...state.cards] }); };

    function add(avatar) {
        if (typeof avatar !== 'string' || !avatar || state.cards.includes(avatar)) return false;
        state.cards.push(avatar);
        changed();
        return true;
    }

    function remove(avatar) {
        if (!state.cards.includes(avatar)) return false;
        state.cards = state.cards.filter(item => item !== avatar);
        delete state.saved[characterBlockId(avatar)];
        changed();
        return true;
    }

    const cleanups = [];
    if (host?.own?.register) {
        cleanups.push(host.own.register('desktop.cards.add', params => add(params?.avatar)));
        cleanups.push(host.own.register('desktop.cards.remove', params => remove(params?.avatar)));
        cleanups.push(host.own.register('desktop.cards.list', () => [...state.cards]));
    }
    return { add, remove, list: () => [...state.cards], dispose: () => { for (const cleanup of cleanups) cleanup?.(); } };
}
