import { filterItems } from '../../../libraries/shared/home-model.js';

/**
 * Окно выбора из списка (персонаж для карточки, виджет для стола): поиск по имени и список (миниатюра, имя, подсказка). Элемент — `{ id, name, thumbnail?, hint? }`;
 * клик — `onPick(id)` и окно закрывается; клик мимо, ✕ или Esc — закрыть. Сам список не хранит: его отдаёт вызывающий при открытии (`open(items, exclude)`), уже добавленные скрыты.
 * Браузерное (`document`) — инъекцией; ничего не знает про сервисы.
 */
export function createItemPicker({ document: doc = globalThis.document, title: heading = 'Choose', emptyText = 'Nothing to add.', onPick = () => {} } = {}) {
    let backdrop = null;
    let onKey = null;

    function close() {
        if (!backdrop) return;
        doc.removeEventListener('keydown', onKey);
        backdrop.remove();
        backdrop = null;
    }

    function open(items, exclude = []) {
        close();
        backdrop = doc.createElement('div');
        backdrop.className = 'stme-home-picker-backdrop';
        const panel = doc.createElement('div');
        panel.className = 'stme-home-picker';
        const head = doc.createElement('div');
        head.className = 'stme-home-picker-head';
        const title = doc.createElement('span');
        title.textContent = heading;
        const closeButton = doc.createElement('button');
        closeButton.setAttribute('type', 'button');
        closeButton.className = 'stme-icon-button';
        closeButton.setAttribute('title', 'Close');
        closeButton.innerHTML = '<i class="fa-solid fa-xmark fa-fw"></i>';
        closeButton.addEventListener('click', close);
        head.append(title, closeButton);
        const search = doc.createElement('input');
        search.className = 'stme-home-picker-search';
        search.setAttribute('type', 'search');
        search.setAttribute('placeholder', 'Search by name…');
        const list = doc.createElement('div');
        list.className = 'stme-home-picker-list';

        const render = () => {
            list.replaceChildren();
            const shown = filterItems(items, search.value, exclude);
            if (!shown.length) {
                const empty = doc.createElement('div');
                empty.className = 'stme-home-picker-empty';
                empty.textContent = items.length && !exclude.length ? 'Nothing matches.' : (search.value.trim() ? 'Nothing matches.' : emptyText);
                list.append(empty);
                return;
            }
            for (const entry of shown) {
                const row = doc.createElement('button');
                row.setAttribute('type', 'button');
                row.className = 'stme-home-pick';
                if (entry.thumbnail) {
                    const img = doc.createElement('img');
                    img.setAttribute('alt', '');
                    img.setAttribute('src', entry.thumbnail);
                    if (entry.image && entry.image !== entry.thumbnail) img.addEventListener('error', () => { img.setAttribute('src', entry.image); }, { once: true });
                    row.append(img);
                }
                const text = doc.createElement('span');
                text.className = 'stme-home-pick-text';
                text.textContent = entry.name;
                if (entry.hint) { const hint = doc.createElement('small'); hint.textContent = entry.hint; text.append(hint); }
                row.append(text);
                row.addEventListener('click', () => { close(); onPick(entry.id); });
                list.append(row);
            }
        };
        search.addEventListener('input', render);
        render();
        panel.append(head, search, list);
        backdrop.append(panel);
        backdrop.addEventListener('pointerdown', event => { if (event.target === backdrop) close(); });
        onKey = event => { if (event.key === 'Escape') close(); };
        doc.addEventListener('keydown', onKey);
        doc.body.append(backdrop);
        search.focus?.();
    }

    return { open, close, isOpen: () => backdrop !== null };
}
