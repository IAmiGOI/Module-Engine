/**
 * Чистая модель ХАБА — обзора основной панели Module Engine (cores/ui/hub/): вместо длинного списка форм — сетка блоков «как глифы», в каждом живой статус,
 * клик открывает ФОРМУ этого блока (нынешняя DOM-карточка панели, без переделок). Здесь — состав блоков, статусы по снимку состояния движка и раскладка
 * сетки. Без DOM и браузера.
 *
 * Блок хаба — тот же по духу, что блок рабочего стола: тело (заголовок и две строки статуса) рисует WebGL на общей поверхности (cores/ui/surface/), точка
 * статуса и кнопка — DOM. Формы остаются DOM: поля ввода, IME и доступность в WebGL не нарисовать.
 */

export const HUB_GROUPS = Object.freeze({ WORK: 'work', SETTINGS: 'settings' });

/**
 * Блоки хаба. `card` — заголовок DOM-карточки панели, которая служит формой блока (ищется по `.stme-card-title strong`); `group` — на каком экране панели
 * блок живёт (основная панель или экран настроек); `description` — строка, пока живого статуса нет. Порядок — порядок в сетке.
 */
export const HUB_TILES = Object.freeze([
    Object.freeze({ id: 'models', title: 'Models', card: 'Model connections', group: HUB_GROUPS.WORK, description: 'Where the engine gets its own generations from', live: true }),
    Object.freeze({ id: 'classifiers', title: 'Classifiers', card: 'Classifiers', group: HUB_GROUPS.WORK, description: 'Small models (Jev) that rate statements about the chat' }),
    Object.freeze({ id: 'modules', title: 'Modules', card: 'Modules', group: HUB_GROUPS.WORK, description: 'What you plug in yourself', live: true }),
    Object.freeze({ id: 'macros', title: 'Macros', card: 'Macros', group: HUB_GROUPS.WORK, description: 'Your own {{macro}} — fixed text or a small program' }),
    Object.freeze({ id: 'lorebook', title: 'Lorebook', card: 'Lorebook', group: HUB_GROUPS.WORK, description: 'Entries of the active lorebooks, editable here' }),
    Object.freeze({ id: 'summary', title: 'Chat Summary', card: 'Chat Summary', group: HUB_GROUPS.WORK, description: 'Folds old messages into summaries' }),
    Object.freeze({ id: 'engine', title: 'Engine', card: 'Engine', group: HUB_GROUPS.SETTINGS, description: 'What is actually wired right now' }),
    Object.freeze({ id: 'viewport', title: 'Chat Viewport', card: 'Chat Viewport (experimental)', group: HUB_GROUPS.SETTINGS, description: 'WebGL chat, own input bar and docks' }),
    Object.freeze({ id: 'preset', title: 'Preset', card: 'Preset', group: HUB_GROUPS.SETTINGS, description: 'Save and load the whole engine setup' }),
    Object.freeze({ id: 'updates', title: 'Updates', card: 'Updates', group: HUB_GROUPS.SETTINGS, description: 'Check GitHub for a newer engine' }),
    Object.freeze({ id: 'sync', title: 'Sync', card: 'Sync', group: HUB_GROUPS.SETTINGS, description: 'Keep devices in step over WebRTC and GitHub' }),
    Object.freeze({ id: 'backgrounds', title: 'Backgrounds', card: 'Backgrounds', group: HUB_GROUPS.SETTINGS, description: 'Backgrounds from the shared repository' }),
]);

export const tilesForGroup = (group, tiles = HUB_TILES) => tiles.filter(tile => tile.group === group);
export const tileById = (id, tiles = HUB_TILES) => tiles.find(tile => tile.id === id) ?? null;
/** Блок, чьей формой служит карточка с заголовком `card` (по нему открывает панель шаг чек-листа рабочего стола). */
export const tileForCard = (card, tiles = HUB_TILES) => tiles.find(tile => tile.card === card) ?? null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (names, max) => (names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', '));

/**
 * Статус блока по снимку состояния: `{ status, lines }`. `status` — 'ok' (работает), 'warn' (нужно внимание), 'off' (выключено), 'info' (просто раздел).
 * Снимок: `{ workerNames: string[]|null, modules: { enabled: string[], total: number }|null }`. Нет данных (`null`) — обычное описание, не «0».
 */
export function tileStatus(tile, snapshot = {}) {
    if (tile.id === 'models' && Array.isArray(snapshot.workerNames)) {
        const names = snapshot.workerNames;
        if (!names.length) return { status: 'warn', lines: ['No connections yet', 'Add one to let the engine call a model'] };
        return { status: 'ok', lines: [plural(names.length, 'connection'), list(names, 3)] };
    }
    if (tile.id === 'modules' && snapshot.modules) {
        const { enabled, total } = snapshot.modules;
        if (!enabled.length) return { status: 'off', lines: [`None enabled (${total} available)`, 'Switch on what you need'] };
        return { status: 'ok', lines: [`${enabled.length} of ${total} enabled`, list(enabled, 3)] };
    }
    return { status: 'info', lines: [tile.description, ''] };
}

export const HUB_TILE_MIN_W = 250;
export const HUB_TILE_MAX_W = 380;
export const HUB_TILE_H = 116;
export const HUB_GAP = 14;

/**
 * Фиксированная сетка обзора: столько колонок, сколько влезает по ширине `width`, ширина блока растягивается по колонкам (в пределах min/max), строки идут
 * сверху вниз. Возвращает `{ tiles: [{ id, x, y, w, h }], width, height }` — `height` нужен контейнеру, чтобы канвас покрыл всю сетку и она прокручивалась.
 * Никакой ручной расстановки: панель — меню, а не рабочее пространство (это решение по рабочему столу другое).
 */
export function layoutGrid({ width, count, ids = [], tileMinW = HUB_TILE_MIN_W, tileMaxW = HUB_TILE_MAX_W, tileH = HUB_TILE_H, gap = HUB_GAP }) {
    const usable = Math.max(1, width);
    const columns = Math.max(1, Math.floor((usable + gap) / (tileMinW + gap)));
    const w = Math.max(1, Math.min(tileMaxW, Math.floor((usable - (columns - 1) * gap) / columns)));
    const total = count ?? ids.length;
    const usedColumns = Math.min(columns, Math.max(1, total));
    const gridW = usedColumns * w + (usedColumns - 1) * gap;
    const left = Math.max(0, Math.floor((usable - gridW) / 2));
    const tiles = Array.from({ length: total }, (_, index) => ({
        id: ids[index] ?? String(index),
        x: left + (index % columns) * (w + gap),
        y: Math.floor(index / columns) * (tileH + gap),
        w,
        h: tileH,
    }));
    const rows = Math.ceil(total / columns);
    return { tiles, width: usable, height: rows ? rows * tileH + (rows - 1) * gap : 0, columns };
}

/** Навигация хаба: `null` — обзор, иначе id открытого блока; неизвестный id — обзор. */
export const resolveView = (view, tiles = HUB_TILES) => (view && tileById(view, tiles) ? view : null);
