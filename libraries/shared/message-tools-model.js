/**
 * Чистые решения панели действий сообщения (выезжает справа от глифа по наведению, cores/ui/chat-viewport/message-tools.js): какие кнопки есть,
 * в каком порядке, какие значки, какая из них «скрыть»/«показать». Без DOM и браузера.
 *
 * Действия — те же, что у родных кнопок сообщения ST (`.mes_button` в шаблоне сообщения): вьюпорт не теряет функций родного чата.
 * `native` — id действия в сервисе `stChat.triggerNative` (кнопка родного `.mes`, её обработчик делает всю работу и обновляет ST);
 * `own` — делаем сами. Некоторые родные кнопки показываются ST только когда действие возможно (Prompt — если есть сохранённый промпт,
 * Swipe picker — если у сообщения несколько свайпов, расширения вроде перевода/картинок — если установлены): кнопка попадает в панель,
 * только когда родная доступна.
 */

/** Порядок — по важности: скрыть/показать, промпт, вложение, копирование, затем ветвление чата. Перевод, картинка и озвучка (кнопки расширений ST) сюда не выводятся — решение владельца. */
export const MESSAGE_TOOLS = Object.freeze([
    Object.freeze({ id: 'hide', native: 'hide', icon: 'fa-eye', title: 'Exclude message from prompts' }),
    Object.freeze({ id: 'unhide', native: 'unhide', icon: 'fa-eye-slash', title: 'Include message in prompts' }),
    Object.freeze({ id: 'prompt', native: 'prompt', icon: 'fa-square-poll-horizontal', title: 'View prompt' }),
    Object.freeze({ id: 'embed', native: 'embed', icon: 'fa-paperclip', title: 'Embed file or image' }),
    Object.freeze({ id: 'copy', native: null, icon: 'fa-copy', title: 'Copy' }),
    Object.freeze({ id: 'swipes', native: 'swipePicker', icon: 'fa-bookmark', title: 'Jump to swipe history' }),
    Object.freeze({ id: 'checkpoint', native: 'checkpoint', icon: 'fa-flag-checkered', title: 'Create checkpoint' }),
    Object.freeze({ id: 'branch', native: 'branch', icon: 'fa-code-branch', title: 'Create branch' }),
    Object.freeze({ id: 'openCheckpoint', native: 'openCheckpoint', icon: 'fa-flag', title: 'Open checkpoint chat' }),
]);

/** Id родных действий (для сервиса `stChat.nativeActions`). */
export const NATIVE_ACTION_IDS = Object.freeze(MESSAGE_TOOLS.filter(tool => tool.native).map(tool => tool.native));

/**
 * Список кнопок для сообщения. `available` — множество id родных действий, доступных СЕЙЧАС (`stChat.nativeActions`), `hidden` — сообщение
 * скрыто от промптов. «Скрыть» и «Показать» — одна кнопка по состоянию: пока сообщение видно — «скрыть» (глаз), скрыто — «показать» (зачёркнутый).
 * Если родного `.mes` для сообщения нет (старое, не отрисованное ST) — скрыть/показать всё равно доступно: делаем сами (`own`), остальное — нет.
 */
export function buildToolList({ available = new Set(), hidden = false, hasNativeMessage = true } = {}) {
    const has = id => available.has(id);
    const tools = [];
    for (const tool of MESSAGE_TOOLS) {
        if (tool.id === 'hide' && hidden) continue;
        if (tool.id === 'unhide' && !hidden) continue;
        if (tool.id === 'hide' || tool.id === 'unhide') {
            tools.push({ ...tool, viaNative: hasNativeMessage && has(tool.native) });
            continue;
        }
        if (tool.native === null) { tools.push({ ...tool, viaNative: false }); continue; }
        if (has(tool.native)) tools.push({ ...tool, viaNative: true });
    }
    return tools;
}

/** Кнопка «скрыть/показать» по состоянию — id для действия: `hide` или `unhide`. */
export const hideToolId = hidden => (hidden ? 'unhide' : 'hide');

/** Зона наведения: курсор над плитой глифа, над самой панелью справа от неё или в зазоре между ними — панель остаётся. */
export function isInToolsZone({ x, columnWidth, panelWidth = 46, gap = 8 }) {
    return x >= -2 && x <= columnWidth + gap + panelWidth;
}

/**
 * Размеры панели действий (px) — пара к `styles/chat-viewport/message-tools.css`. Кнопки — те же круглые 26px, что у действий в шапке глифа.
 * Панель — продолжение плиты глифа: вплотную справа (`TOOLS_PANEL_GAP = 0`), той же высоты (видимой части глифа); кнопки идут столбцами,
 * столбцов не больше `TOOLS_MAX_COLUMNS` — от этого зависит место, которое оверлей оставляет справа (`TOOLS_RIGHT_SPACE`).
 */
export const TOOLS_BUTTON = 26;
export const TOOLS_BUTTON_GAP = 6;
export const TOOLS_PAD = 7;
export const TOOLS_MIN_HEIGHT = 96;
export const TOOLS_MAX_COLUMNS = 2;
export const TOOLS_PANEL_GAP = 0;
/** Ширина полосы у правого края плиты глифа, наведение на которую ВЫЗЫВАЕТ панель (владелец: только у правого края, не над всем глифом). */
export const TOOLS_EDGE_WIDTH = 28;
/** Курсор в полосе вызова панели: у правого края плиты или уже над самой панелью. */
export const isOnToolsEdge = ({ x, columnWidth, edge = TOOLS_EDGE_WIDTH }) => x >= columnWidth - edge;
/** Ширина панели в столбцов. */
export const toolsPanelWidth = columns => columns * TOOLS_BUTTON + (columns - 1) * TOOLS_BUTTON_GAP + 2 * TOOLS_PAD;
/** Самая широкая панель (`TOOLS_MAX_COLUMNS` столбцов) — по ней зона наведения и резерв места справа. */
export const TOOLS_PANEL_WIDTH = toolsPanelWidth(TOOLS_MAX_COLUMNS);
/** Место справа от колонки сообщений, которое оверлей оставляет под панель (иначе она уехала бы за край окна). */
export const TOOLS_RIGHT_SPACE = TOOLS_PANEL_WIDTH + 8;

/**
 * Раскладка панели для глифа: по вертикали — по ВИДИМОЙ части глифа внутри вьюпорта (не уезжает вниз за короткое сообщение и не обрезается у нижнего
 * края), по горизонтали — столбцами, сколько нужно, чтобы все кнопки влезли в эту высоту (не больше `TOOLS_MAX_COLUMNS`; если и так не влезает —
 * панель вытягивается по высоте). `glyphTop`/`glyphHeight` — в координатах кадра, `viewportHeight` — высота видимой области.
 */
export function computeToolsLayout({ glyphTop, glyphHeight, viewportHeight, count }) {
    const top = Math.max(0, glyphTop);
    const bottom = Math.min(viewportHeight, glyphTop + glyphHeight);
    let height = Math.max(TOOLS_MIN_HEIGHT, bottom - top);
    const pitch = TOOLS_BUTTON + TOOLS_BUTTON_GAP;
    let rows = Math.max(1, Math.floor((height - 2 * TOOLS_PAD + TOOLS_BUTTON_GAP) / pitch));
    let columns = Math.max(1, Math.ceil(count / rows));
    if (columns > TOOLS_MAX_COLUMNS) {
        columns = TOOLS_MAX_COLUMNS;
        rows = Math.ceil(count / columns);
        height = Math.max(height, rows * pitch - TOOLS_BUTTON_GAP + 2 * TOOLS_PAD);
    }
    const y = Math.max(0, Math.min(top, viewportHeight - height));
    return { y, height, width: toolsPanelWidth(columns), columns, rows };
}
