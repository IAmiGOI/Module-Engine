import { BLOCK_KINDS, FIRST_START_ITEMS, QUICK_ACTIONS, HEAD_H, CHECK_PROGRESS_H, CHECK_ROW_H, ACTION_ROW_H, RECENT_ROW_H } from '../../../libraries/shared/home-model.js';
import { visibleRecent } from '../../../libraries/shared/home-html.js';
import { WIDGET_LAYOUT } from '../../../libraries/shared/widget-contract.js';

/**
 * DOM одного блока главного экрана: плита (тот же вид, что у плиты глифа), аватары, кнопки, галочки. Текст блока — в WebGL поверх (см. scene.js),
 * поэтому размеры и позиции здесь — пара к `libraries/shared/home-html.js` и `styles/home/blocks.css`. Кнопки останавливают `pointerdown`, чтобы
 * нажатие на них не начинало перетаскивание блока. Обработчики приходят снаружи (`handlers`) — узел ничего не знает про сервисы.
 */
const icon = (doc, cls) => { const el = doc.createElement('i'); el.className = `fa-solid ${cls} fa-fw`; return el; };

function button(doc, { cls, title, iconClass, onClick, label }) {
    const el = doc.createElement('button');
    el.setAttribute('type', 'button');
    el.className = cls;
    if (title) { el.setAttribute('title', title); el.setAttribute('aria-label', title); }
    el.append(icon(doc, iconClass));
    if (label) { const span = doc.createElement('span'); span.textContent = label; el.append(span); }
    el.addEventListener('pointerdown', event => event.stopPropagation());
    el.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
    return el;
}

/** Аватар с запасным адресом: серверная миниатюра ST у только что импортированного персонажа может не отдаваться — тогда берём исходный файл (и наоборот). */
function avatarImg(doc, cls, src, fallback) {
    const img = doc.createElement('img');
    img.className = cls;
    img.setAttribute('alt', '');
    img.setAttribute('draggable', 'false');
    img.setAttribute('src', src ?? '');
    if (fallback && fallback !== src) img.addEventListener('error', () => { img.setAttribute('src', fallback); }, { once: true });
    return img;
}

/** «Недавние чаты»: строка на чат — кликабельная (открывает чат), справа круглые кнопки «закрепить», «переименовать», «удалить». */
function buildRecent(doc, el, chats, handlers) {
    el.classList.add('stme-home-recent');
    // «Add card» живёт здесь: карточка персонажа — ярлык на его последний чат, рядом со списком чатов.
    el.append(button(doc, { cls: 'stme-icon-button stme-home-dismiss', title: 'Add a character card', iconClass: 'fa-user-plus', onClick: () => handlers.onAddCard() }));
    visibleRecent(chats).forEach((chat, index) => {
        const row = doc.createElement('div');
        row.className = 'stme-home-row';
        row.style.top = `${HEAD_H + index * RECENT_ROW_H}px`;
        row.style.height = `${RECENT_ROW_H - 4}px`;
        const actions = doc.createElement('div');
        actions.className = 'stme-home-row-actions';
        actions.append(
            button(doc, { cls: `stme-icon-button stme-home-pin${chat.pinned ? ' stme-home-pinned' : ''}`, title: chat.pinned ? 'Unpin chat' : 'Pin chat', iconClass: 'fa-thumbtack', onClick: () => handlers.onChatAction(chat.key, 'pin') }),
            button(doc, { cls: 'stme-icon-button', title: 'Rename chat', iconClass: 'fa-pen-to-square', onClick: () => handlers.onChatAction(chat.key, 'rename') }),
            button(doc, { cls: 'stme-icon-button', title: 'Delete chat', iconClass: 'fa-trash', onClick: () => handlers.onChatAction(chat.key, 'delete') }),
        );
        row.append(avatarImg(doc, 'stme-home-row-avatar', chat.thumbnail), actions);
        row.addEventListener('pointerdown', event => event.stopPropagation());   // строка не таскает блок: её клик — открыть чат
        row.addEventListener('click', () => handlers.onChatAction(chat.key, 'open'));
        el.append(row);
    });
}

/** Карточка персонажа, которую создал пользователь: аватар (имя — в растре), клик открывает его последний чат, ✕ убирает карточку. */
function buildCharacter(doc, el, block, data, handlers) {
    el.classList.add('stme-home-character');
    el.setAttribute('title', data.name ? `Open the last chat with ${data.name}` : 'Character not found');
    el.append(
        avatarImg(doc, 'stme-home-character-avatar', data.image || data.thumbnail, data.image ? data.thumbnail : ''),
        button(doc, { cls: 'stme-icon-button stme-home-remove', title: 'Remove this card', iconClass: 'fa-xmark', onClick: () => handlers.onRemoveCard(block.avatar) }),
    );
    el.addEventListener('click', () => { if (!el.__dragged) handlers.onOpenCharacter(block.avatar); });
}

/** Блок виджета: тело рисует сам виджет (WebGL), здесь — его кнопки (`data.actions`) и общий ✕ «убрать со стола». */
function buildWidget(doc, el, block, data, handlers) {
    el.classList.add('stme-home-widget');
    const bar = doc.createElement('div');
    bar.className = 'stme-home-widget-actions';
    for (const action of data.actions ?? []) {
        bar.append(button(doc, { cls: 'stme-icon-button', title: action.title, iconClass: action.icon, onClick: () => handlers.onWidgetAction(block.instanceId, action.id) }));
    }
    bar.append(button(doc, { cls: 'stme-icon-button', title: 'Remove from the desktop', iconClass: 'fa-xmark', onClick: () => handlers.onRemoveWidget(block.instanceId) }));
    el.append(bar);
    // Строка поиска над списком (`instance.search`): ввод уходит виджету с небольшой задержкой (не перерастеризуем на каждую букву).
    const searchShift = data.search ? WIDGET_LAYOUT.searchH : 0;
    if (data.search) {
        const input = doc.createElement('input');
        input.className = 'stme-home-search';
        input.setAttribute('type', 'search');
        input.setAttribute('placeholder', data.search.placeholder);
        input.setAttribute('aria-label', data.search.placeholder);
        input.value = data.search.value;
        input.style.top = `${WIDGET_LAYOUT.rowsTop - 4}px`;
        let timer = null;
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => handlers.onWidgetSearch(block.instanceId, input.value), 150); });
        input.addEventListener('pointerdown', event => event.stopPropagation());
        input.addEventListener('keydown', event => event.stopPropagation());   // клавиши поля не должны уходить в горячие клавиши ST
        el.append(input);
    }
    // Список строк виджета (`instance.rows()`): аватар и круглые кнопки на каждую; текст строки — в его собственном HTML; клик по строке — `row.click`.
    (data.rows ?? []).forEach((row, index) => {
        const line = doc.createElement('div');
        line.className = row.click ? 'stme-home-row' : 'stme-home-row stme-home-row-static';
        line.style.top = `${WIDGET_LAYOUT.rowsTop + searchShift + index * WIDGET_LAYOUT.rowH}px`;
        line.style.height = `${WIDGET_LAYOUT.rowH - 4}px`;
        const actions = doc.createElement('div');
        actions.className = 'stme-home-row-actions';
        for (const action of row.actions ?? []) actions.append(button(doc, { cls: 'stme-icon-button', title: action.title, iconClass: action.icon, onClick: () => handlers.onWidgetAction(block.instanceId, action.id, row.id) }));
        if (row.image) line.append(avatarImg(doc, 'stme-home-row-avatar', row.image, row.imageFallback));
        line.append(actions);
        line.addEventListener('pointerdown', event => event.stopPropagation());
        if (row.click) line.addEventListener('click', () => handlers.onWidgetAction(block.instanceId, row.click, row.id));
        el.append(line);
    });
}

function buildActions(doc, el, handlers) {
    const grid = doc.createElement('div');
    grid.className = 'stme-home-action-grid';
    grid.style.top = `${HEAD_H}px`;
    grid.style.gridAutoRows = `${ACTION_ROW_H}px`;
    for (const action of QUICK_ACTIONS) {
        grid.append(button(doc, { cls: `stme-home-action${action.wide ? ' stme-home-action-wide' : ''}`, title: action.title, iconClass: action.icon, label: action.label ?? action.title, onClick: () => handlers.onQuick(action) }));
    }
    el.classList.add('stme-home-actions');
    el.append(grid);
}

function buildChecklist(doc, el, done, handlers) {
    el.classList.add('stme-home-checklist');
    el.append(button(doc, { cls: 'stme-icon-button stme-home-dismiss', title: 'Hide this list', iconClass: 'fa-xmark', onClick: () => handlers.onDismissChecklist() }));
    const rowsTop = HEAD_H + CHECK_PROGRESS_H;
    FIRST_START_ITEMS.forEach((item, index) => {
        const isDone = done.has(item.id);
        const check = button(doc, {
            cls: `stme-home-check${isDone ? ' stme-home-check-done' : ''}`, title: isDone ? 'Mark as not done' : 'Mark as done',
            iconClass: isDone ? 'fa-check' : 'fa-circle', onClick: () => handlers.onToggleItem(item.id),
        });
        check.dataset.item = item.id;
        check.style.top = `${rowsTop + index * CHECK_ROW_H + 8}px`;
        // Строка целиком ведёт туда, где шаг делается (карточка панели движка); кружок слева — отметить вручную.
        const step = button(doc, { cls: 'stme-home-step', title: `Go there: ${item.card}`, iconClass: 'fa-arrow-right', onClick: () => handlers.onOpenStep(item) });
        step.dataset.step = item.id;
        step.style.top = `${rowsTop + index * CHECK_ROW_H}px`;
        step.style.height = `${CHECK_ROW_H - 4}px`;
        el.append(step, check);
    });
}

/** Собирает узел блока. `data`: `{ chats }` для «Недавних», `{ name, thumbnail }` для карточки персонажа, `{ done }` для чек-листа, `{ actions, rows }` для виджета. */
export function createBlockDom({ document: doc, block, data = {}, handlers }) {
    const el = doc.createElement('div');
    el.className = 'stme-home-block';
    el.dataset.block = block.id;
    Object.assign(el.style, { width: `${block.w}px`, height: `${block.h}px` });
    if (block.kind === BLOCK_KINDS.RECENT) buildRecent(doc, el, data.chats ?? [], handlers);
    else if (block.kind === BLOCK_KINDS.CHARACTER) buildCharacter(doc, el, block, data, handlers);
    else if (block.kind === BLOCK_KINDS.CHECKLIST) buildChecklist(doc, el, data.done ?? new Set(), handlers);
    else if (block.kind === BLOCK_KINDS.WIDGET) buildWidget(doc, el, block, data, handlers);
    else buildActions(doc, el, handlers);
    return {
        el,
        place: (x, y) => { el.style.transform = `translate(${x}px, ${y}px)`; },
        setDragging: on => el.classList.toggle('stme-home-dragging', on),
        remove: () => el.remove(),
    };
}

/**
 * Блок пересобирается при каждой перерисовке виджета — а поле поиска нельзя терять посреди набора. `captureFocus` вызывается ДО удаления старого узла
 * (у удалённого узла фокус уже сброшен), `restoreFocus` — после вставки нового: фокус и положение курсора переезжают в новое поле.
 */
export function captureFocus(doc, previousEl) {
    const active = doc.activeElement;
    if (!previousEl || !active || active.tagName !== 'INPUT' || !previousEl.contains(active)) return null;
    return { caret: active.selectionStart ?? null };
}

export function restoreFocus(snapshot, nextEl) {
    if (!snapshot) return;
    const next = nextEl.querySelector('input');
    if (!next) return;
    next.focus();
    const caret = snapshot.caret ?? next.value.length;
    next.setSelectionRange?.(caret, caret);
}
