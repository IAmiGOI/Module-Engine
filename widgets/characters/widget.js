/**
 * Виджет «Characters» — управление персонажами прямо с рабочего стола Module Engine: импорт карточки, добавление персонажа на стол (карточкой-ярлыком на его
 * последний чат) и удаление. Самодостаточный файл (ничего не импортирует): к движку ходит только через `host.request` по контрактам из `rights`,
 * события слушает через `host.subscribe`.
 *
 *  - Импорт открывает РОДНОЙ выбор файла ST (`stHome.importCharacter`): разбор форматов и обновление списка делает сам ST, виджет обновляется по его событию.
 *  - Удаление — родная `deleteCharacter` ST через `stHome.deleteCharacter` (закрывает чат, чистит теги, шлёт события) и НЕ мгновенное: первая нажатая
 *    корзина только спрашивает («✓ — да, ✕ — отмена»), сброс через 6 секунд без ответа. Вместе с персонажем удаляются его чаты (как в диалоге ST по умолчанию),
 *    об этом написано в самой строке подтверждения.
 *  - Нажатие на саму строку открывает ПОСЛЕДНИЙ чат персонажа (`stHome.openCharacter`, как у карточки на столе).
 *  - Над списком — строка поиска по имени (DOM-поле рабочего стола, `search`); поиск сбрасывает страницу на первую.
 *  - Список — по 5 на страницу (стрелки в шапке). Текст рисует WebGL, аватары и кнопки строк — DOM рабочего стола (`rows()`).
 */

const PAGE_SIZE = 5;
const CONFIRM_TIMEOUT_MS = 6000;
const AVATAR_X = 58;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Чистые куски состояния — для тестов и чтобы `create` оставался коротким. */
export const pageCount = total => Math.max(1, Math.ceil(total / PAGE_SIZE));
export const pageSlice = (list, page) => list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

export default {
    id: 'characters',
    title: 'Characters',
    description: 'Import, delete and put character cards on the desktop.',
    size: { w: 340, h: 52 + 36 + PAGE_SIZE * 46 + 14 },
    rights: ['stHome.characters', 'stHome.importCharacter', 'stHome.deleteCharacter', 'desktop.cards.add', 'desktop.cards.remove', 'desktop.cards.list', 'stHome.openCharacter'],
    create(host) {
        const layout = host.layout ?? { rowsTop: 52, rowH: 46, searchH: 36 };
        let list = [];            // [{ avatar, name, thumbnail }]
        let onDesk = new Set();   // файлы аватаров, у которых есть карточка на столе
        let page = 0;
        let query = '';
        let confirming = null;    // avatar, для которого спрошено подтверждение удаления
        let confirmTimer = null;
        let note = '';
        let unsubscribe = [];

        const services = { via: 'services' };
        const cores = { via: 'cores' };

        /** Персонажи по строке поиска (по имени, без учёта регистра). */
        const visible = () => {
            const needle = query.trim().toLowerCase();
            return needle ? list.filter(character => String(character.name).toLowerCase().includes(needle)) : list;
        };

        async function load() {
            const [characters, cards] = await Promise.all([host.request('stHome.characters', {}, services), host.request('desktop.cards.list', {}, cores)]);
            if (characters.ok) list = Array.isArray(characters.value) ? characters.value : [];
            if (cards.ok) onDesk = new Set(Array.isArray(cards.value) ? cards.value : []);
            page = Math.min(page, pageCount(visible().length) - 1);
            host.invalidate();
        }

        const askConfirm = avatar => {
            confirming = avatar;
            clearTimeout(confirmTimer);
            confirmTimer = setTimeout(() => { confirming = null; host.invalidate(); }, CONFIRM_TIMEOUT_MS);
            host.invalidate();
        };
        const clearConfirm = () => { confirming = null; clearTimeout(confirmTimer); confirmTimer = null; };

        return {
            html() {
                const shown = visible();
                const pages = pageCount(shown.length);
                const rows = pageSlice(shown, page).map((character, index) => {
                    const top = layout.rowsTop + layout.searchH + index * layout.rowH;
                    const asking = confirming === character.avatar;
                    const title = asking ? 'Delete this character and its chats?' : character.name || 'Unnamed';
                    const sub = asking ? `${character.name} — this cannot be undone` : `${character.avatar}${onDesk.has(character.avatar) ? ' · on the desktop' : ''}`;
                    return `<div class="wg-text" style="left:${AVATAR_X}px;right:78px;top:${top + 5}px;font-weight:600${asking ? ';color:#ff8a80' : ''}">${escapeHtml(title)}</div>`
                        + `<div class="wg-muted" style="left:${AVATAR_X}px;right:78px;top:${top + 24}px;font-size:11.5px">${escapeHtml(sub)}</div>`;
                }).join('');
                const emptyText = list.length ? (shown.length ? '' : 'Nobody matches the search.') : 'No characters yet — import one with the button above.';
                const empty = emptyText ? `<div class="wg-muted" style="left:16px;right:16px;top:${layout.rowsTop + layout.searchH + 8}px">${escapeHtml(emptyText)}</div>` : '';
                const count = query.trim() ? `${shown.length} of ${list.length}` : `${list.length} character${list.length === 1 ? '' : 's'}`;
                const subtitle = note || `${count}${pages > 1 ? ` · page ${page + 1} of ${pages}` : ''}`;
                return `<div class="hb"><div class="wg-title" style="left:16px;top:13px;right:140px;font-size:15px">Characters</div>`
                    + `<div class="wg-muted" style="left:16px;top:33px;right:16px">${escapeHtml(subtitle)}</div>${rows}${empty}</div>`;
            },
            /** Кнопки шапки: импорт и листание (стрелки — только когда есть куда). Читается при каждой перерисовке. */
            get actions() {
                const buttons = [{ id: 'import', icon: 'fa-file-import', title: 'Import a character card' }];
                if (page > 0) buttons.push({ id: 'prev', icon: 'fa-chevron-left', title: 'Previous page' });
                if (page < pageCount(visible().length) - 1) buttons.push({ id: 'next', icon: 'fa-chevron-right', title: 'Next page' });
                return buttons;
            },
            /** Строка поиска над списком: рабочий стол рисует поле, ввод приходит в `onSearch`. */
            get search() { return { placeholder: 'Search characters…', value: query }; },
            onSearch(value) { query = String(value ?? ''); page = 0; clearConfirm(); host.invalidate(); },
            rows() {
                return pageSlice(visible(), page).map(character => ({
                    id: character.avatar,
                    image: character.thumbnail,
                    imageFallback: character.image,
                    click: 'open',
                    actions: confirming === character.avatar
                        ? [{ id: 'confirm-delete', icon: 'fa-check', title: 'Yes, delete it' }, { id: 'cancel', icon: 'fa-xmark', title: 'Cancel' }]
                        : [onDesk.has(character.avatar)
                            ? { id: 'card-remove', icon: 'fa-table-cells-large', title: 'On the desktop — click to remove the card' }
                            : { id: 'card-add', icon: 'fa-plus', title: 'Put a card on the desktop' },
                        { id: 'delete', icon: 'fa-trash', title: 'Delete this character' }],
                }));
            },
            async onAction(id, rowId) {
                if (id === 'open') { await host.request('stHome.openCharacter', { avatar: rowId }, services); return; }
                if (id === 'import') { await host.request('stHome.importCharacter', {}, services); return; }
                if (id === 'prev') { page = Math.max(0, page - 1); clearConfirm(); host.invalidate(); return; }
                if (id === 'next') { page = Math.min(pageCount(visible().length) - 1, page + 1); clearConfirm(); host.invalidate(); return; }
                if (id === 'card-add') { await host.request('desktop.cards.add', { avatar: rowId }, cores); await load(); return; }
                if (id === 'card-remove') { await host.request('desktop.cards.remove', { avatar: rowId }, cores); await load(); return; }
                if (id === 'delete') { askConfirm(rowId); return; }
                if (id === 'cancel') { clearConfirm(); host.invalidate(); return; }
                if (id === 'confirm-delete') {
                    clearConfirm();
                    await host.request('desktop.cards.remove', { avatar: rowId }, cores);
                    const result = await host.request('stHome.deleteCharacter', { avatar: rowId, deleteChats: true }, services);
                    note = result.ok && result.value ? '' : 'Could not delete that character.';
                    await load();
                }
            },
            async start() {
                unsubscribe = ['st.characterPageLoaded', 'st.characterDeleted', 'ui.home.cardsChanged'].map(event => host.subscribe?.(event, () => { void load(); })).filter(Boolean);
                await load();
            },
            stop() {
                clearTimeout(confirmTimer);
                for (const off of unsubscribe) try { off(); } catch { /* уже снято */ }
                unsubscribe = [];
            },
        };
    },
};
