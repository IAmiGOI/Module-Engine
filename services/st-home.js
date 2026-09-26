/**
 * Сервис главного экрана ST — единственное место, знающее про разметку родного стартового экрана (`.welcomePanel` в `#chat`, шаблон
 * `welcomePanel.html`, скрипт `welcome-screen.js`). Наш экран (cores/ui/home/) рисует СВОИ блоки, но данные берёт отсюда, а действия делает
 * нажатием родных элементов: у ST всю работу (открыть чат, закрепить, переименовать с диалогом, удалить с подтверждением, временный чат)
 * делают обработчики кликов на этих кнопках — мы их не переписываем (тот же принцип, что `stChat.triggerNative`).
 *
 * Пока экран открыт, родная панель остаётся в DOM (её лишь прячет CSS), поэтому читать из неё безопасно. Когда ST её перерисовывает
 * (закрепили чат — `refreshWelcomeScreen`), узлы новые, а ключ чата (`avatar|group` + файл) тот же — действие ищет узел заново по ключу.
 *
 * `document` инжектируется (тесты) — по умолчанию берётся глобальный В МОМЕНТ вызова, а не при регистрации.
 */

/** Родные кнопки быстрых действий: id из `libraries/shared/home-model.js` → селектор. Часть — значки верхней панели ST (их клик открывает ящик). */
export const HOME_NATIVE_BUTTONS = Object.freeze({
    temporaryChat: '.welcomePanel .openTemporaryChat',
    characters: '#rightNavDrawerIcon',
    api: '#API-status-top',
    extensions: '#extensionsMenuButton',
});

const CHAT_ACTION_SELECTORS = Object.freeze({ pin: '.pinChat', rename: '.renameChat', delete: '.deleteChat' });

const text = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
export const homeChatKey = ({ avatar = '', group = '', file = '' }) => `${avatar || group}|${file}`;

/** Один родной элемент `.recentChat` → нейтральная форма. Чистая функция над элементом (`getAttribute`/`querySelector`). */
export function readRecentChat(item) {
    const avatar = item.getAttribute('data-avatar') ?? '';
    const group = item.getAttribute('data-group') ?? '';
    const file = item.getAttribute('data-file') ?? '';
    return {
        key: homeChatKey({ avatar, group, file }),
        avatar, group, file,
        isGroup: Boolean(group) && !avatar,
        character: text(item.querySelector('.characterName')),
        chatName: file,
        date: text(item.querySelector('.chatDate')),
        dateFull: item.querySelector('.chatDate')?.getAttribute?.('title') ?? '',
        message: text(item.querySelector('.chatMessage')),
        count: text(item.querySelector('.counterBlock small')),
        size: text(item.querySelector('.fileSize')),
        thumbnail: item.querySelector('.avatar img')?.getAttribute?.('src') ?? '',
        pinned: Boolean(item.querySelector('.pinChat.active')) || Boolean(item.querySelector('.recentChatPinned')),
    };
}

export function registerStHomeService(bus, { document: doc, getContext = () => null, importScript = () => import('/script.js') } = {}) {
    const dom = () => doc ?? globalThis.document;
    const items = () => [...(dom()?.querySelectorAll?.('#chat .welcomePanel .recentChat') ?? [])];

    /** `{ welcome, chats }` — открыт ли родной стартовый экран и его недавние чаты. */
    function state() {
        const panel = dom()?.querySelector?.('#chat .welcomePanel');
        return { welcome: Boolean(panel), chats: panel ? items().map(readRecentChat) : [] };
    }

    /** Действие над чатом с ключом `key`: `open` (клик по карточке), `pin`, `rename`, `delete`. `false` — такого чата (или кнопки) уже нет. */
    function chatAction({ key, action } = {}) {
        const item = items().find(node => readRecentChat(node).key === key);
        if (!item) return false;
        const target = action === 'open' ? item : item.querySelector(CHAT_ACTION_SELECTORS[action] ?? '');
        if (!target) return false;
        target.click();
        return true;
    }

    /** Нажимает родную кнопку быстрого действия. `false` — кнопки сейчас нет. */
    function quick({ native } = {}) {
        const selector = HOME_NATIVE_BUTTONS[native];
        const button = selector ? dom()?.querySelector?.(selector) : null;
        if (!button) return false;
        button.click();
        return true;
    }

    /**
     * Персонажи ST (не группы) для выбора карточки: `[{ avatar, name, thumbnail, image }]` по имени. `thumbnail` — серверная миниатюра ST (мелкая, для списков),
     * `image` — исходный файл карточки без пережатия (для крупного аватара на столе; ту же причину описывает `stChat` про `/characters/<file>`).
     */
    function characters() {
        const context = getContext();
        const list = Array.isArray(context?.characters) ? context.characters : [];
        return list
            .filter(character => character?.avatar)
            .map(character => ({ avatar: character.avatar, name: character.name ?? '', thumbnail: context.getThumbnailUrl?.('avatar', character.avatar) ?? `/characters/${character.avatar}`, image: `/characters/${encodeURIComponent(character.avatar)}` }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Открывает ПОСЛЕДНИЙ чат персонажа — так же, как выбор его в списке ST (`selectCharacterById` загружает чат, на который указывает карточка). */
    async function openCharacter({ avatar } = {}) {
        const context = getContext();
        const id = Array.isArray(context?.characters) ? context.characters.findIndex(character => character?.avatar === avatar) : -1;
        if (id < 0 || typeof context.selectCharacterById !== 'function') return false;
        // `switchMenu: false` — не выезжает панель персонажа, нужен только сам чат.
        await context.selectCharacterById(id, { switchMenu: false });
        return true;
    }

    /** Импорт карточки: открывает родной выбор файла ST (кнопка «Import Character from File») — сам импорт, разбор форматов и обновление списка делает ST. */
    function importCharacter() {
        const button = dom()?.querySelector?.('#character_import_button');
        if (!button) return false;
        button.click();
        return true;
    }

    /**
     * Удаляет персонажа родной функцией ST `deleteCharacter` (она закрывает открытый чат, чистит теги/настройки и шлёт `characterDeleted`; своя реализация всё
     * это потеряла бы). Подтверждение — на вызывающем: сама функция ST его не спрашивает. `false` — такого персонажа нет или удаление не удалось.
     */
    async function deleteCharacter({ avatar, deleteChats = true } = {}) {
        const context = getContext();
        if (!Array.isArray(context?.characters) || !context.characters.some(character => character?.avatar === avatar)) return false;
        const script = await importScript();
        if (typeof script?.deleteCharacter !== 'function') return false;
        return Boolean(await script.deleteCharacter(avatar, { deleteChats: Boolean(deleteChats) }));
    }

    const unregisters = [
        bus.register('stHome.importCharacter', () => importCharacter(), { loadMetric: () => 0 }),
        bus.register('stHome.deleteCharacter', params => deleteCharacter(params), { loadMetric: () => 0 }),
        bus.register('stHome.characters', () => characters(), { loadMetric: () => 0 }),
        bus.register('stHome.openCharacter', params => openCharacter(params), { loadMetric: () => 0 }),
        bus.register('stHome.state', () => state(), { loadMetric: () => 0 }),
        bus.register('stHome.chatAction', params => chatAction(params), { loadMetric: () => 0 }),
        bus.register('stHome.quick', params => quick(params), { loadMetric: () => 0 }),
        /** Контейнер, за которым наблюдают: ST перерисовывает стартовый экран (открытие/закрытие чата, закрепление). */
        bus.register('stHome.container', () => dom()?.getElementById?.('chat') ?? null, { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
