/**
 * Чистая модель главного экрана (cores/ui/home/): блоки «как глифы», раскиданные по экрану. Без DOM и браузера.
 *
 * Блок — одна функция: чек-лист первого запуска, быстрые действия, «Недавние чаты», карточка персонажа (её создаёт пользователь). Тело блока
 * рисуется в WebGL (растр HTML, как у тела сообщения), кнопки и ссылки — DOM поверх, как у глифов. Здесь — только состав, размеры, раскладка
 * и перетаскивание.
 *
 * РАСКЛАДКА адаптивна: стартовая композиция считается от ширины/высоты сцены (колонки блоков по центру, короткая колонка первой), а положение,
 * которое пользователь задал перетаскиванием, хранится ДОЛЯМИ свободного места (`fx`, `fy` ∈ [0,1]), а не пикселями — при смене окна блок остаётся
 * на «своём» месте и не вылезает за край. Блоки не наезжают друг на друга ни при раскладке, ни при перетаскивании.
 */

import { widgetBlockId, WIDGET_DEFAULT_SIZE } from './widget-contract.js';

export const BLOCK_KINDS = Object.freeze({ RECENT: 'recent', CHARACTER: 'character', ACTIONS: 'actions', CHECKLIST: 'checklist', WIDGET: 'widget' });

export const HOME_GAP = 16;
export const HOME_MARGIN = 24;
/** Блок «Недавние чаты»: строки по одному чату, не больше `RECENT_MAX_ROWS`. */
export const RECENT_BLOCK_W = 340;
export const RECENT_ROW_H = 46;
export const RECENT_MAX_ROWS = 6;
/** Карточка персонажа, созданная пользователем: аватар и имя. */
export const CHARACTER_BLOCK = Object.freeze({ w: 150, h: 196 });
/** Минимальный зазор между блоками: они не наезжают друг на друга. */
export const BLOCK_SPACING = 8;
export const ACTIONS_BLOCK_W = 300;
/** Блок «Add widget»: заголовок и одна кнопка. */
export const CHECKLIST_BLOCK_W = 340;
/** Высота шапки и подвала блока (пара к `styles/home/`). */
export const HEAD_H = 52;
export const FOOT_H = 14;
/** Быстрые действия идут кнопками по две в ряд. */
export const ACTION_ROW_H = 44;
/** Строка чек-листа: заголовок и подсказка в две строки. */
export const CHECK_ROW_H = 46;
/** Строка «выполнено N из M» под шапкой чек-листа. */
export const CHECK_PROGRESS_H = 22;
/** Быстрые действия: ссылки (`href`) и «Add widget» (`own`, отдельной строкой на всю ширину, `wide`); действия ST владелец убрал с экрана. */
export const QUICK_ACTIONS = Object.freeze([
    Object.freeze({ id: 'docs', icon: 'fa-circle-question', title: 'SillyTavern docs', label: 'ST Docs', href: 'https://docs.sillytavern.app/' }),
    Object.freeze({ id: 'discord', icon: 'fa-brands fa-discord', title: 'SillyTavern Discord', label: 'Discord', href: 'https://discord.gg/sillytavern' }),
    Object.freeze({ id: 'github-st', icon: 'fa-brands fa-github', title: 'SillyTavern on GitHub', label: 'GitHub ST', href: 'https://github.com/SillyTavern/SillyTavern' }),
    Object.freeze({ id: 'github-me', icon: 'fa-brands fa-github', title: 'Module Engine on GitHub', label: 'GitHub ME', href: 'https://github.com/IAmiGOI/Module-Engine' }),
    // Отдельная строка на всю ширину: открывает выбор виджета для рабочего стола.
    Object.freeze({ id: 'add-widget', icon: 'fa-plus', title: 'Add a widget to the desktop', label: 'Add widget', own: 'addWidget', wide: true }),
]);

/**
 * Чек-лист «первый запуск: что сделать для знакомства с движком». `auto` — событие, по которому пункт отмечается сам; без него — отмечает
 * пользователь. `card` — заголовок карточки панели движка, к которой ведёт клик по пункту. Список — данные: правится здесь, без правок ядра.
 */
export const FIRST_START_ITEMS = Object.freeze([
    Object.freeze({ id: 'model', title: 'Set up a model in Module Engine', hint: 'Panel → Models: add a worker with your API.', card: 'Model connections', auto: 'model.workers.changed' }),
    Object.freeze({ id: 'first-module', title: 'Turn on your first module', hint: 'Panel → Modules: switch on what you need.', card: 'Modules' }),
    Object.freeze({ id: 'first-tracker', title: 'Add your first tracker', hint: 'Panel → Modules → Tracker: pick fields to follow.', card: 'Modules' }),
]);

/** Прогресс чек-листа: сколько отмечено, какой пункт следующий, всё ли готово. */
export function checklistProgress(done = new Set(), items = FIRST_START_ITEMS) {
    const doneCount = items.filter(item => done.has(item.id)).length;
    const next = items.find(item => !done.has(item.id)) ?? null;
    return { done: doneCount, total: items.length, next: next?.id ?? null, complete: doneCount === items.length };
}

/** Пункты, которые отмечаются сами по событию `event`. */
export const itemsForEvent = (event, items = FIRST_START_ITEMS) => items.filter(item => item.auto === event).map(item => item.id);

/** Размер блока по виду и числу строк (`count`). Высота считается, а не измеряется: растр рисуется под неё. */
export function blockSize(kind, { count = 0 } = {}) {
    if (kind === BLOCK_KINDS.CHARACTER) return { ...CHARACTER_BLOCK };
    if (kind === BLOCK_KINDS.RECENT) return { w: RECENT_BLOCK_W, h: HEAD_H + Math.max(1, Math.min(count, RECENT_MAX_ROWS)) * RECENT_ROW_H + FOOT_H };
    if (kind === BLOCK_KINDS.ACTIONS) return { w: ACTIONS_BLOCK_W, h: HEAD_H + Math.ceil(count / 2) * ACTION_ROW_H + FOOT_H };
    return { w: CHECKLIST_BLOCK_W, h: HEAD_H + CHECK_PROGRESS_H + count * CHECK_ROW_H + FOOT_H };
}

/** Id блока карточки персонажа по файлу аватара. */
export const characterBlockId = avatar => `character:${avatar}`;

/**
 * Набор блоков экрана в порядке стартовой раскладки: чек-лист (пока не закончен и не закрыт), быстрые действия, «Недавние чаты», затем карточки
 * персонажей, которые создал пользователь (`characterCards` — файлы аватаров).
 */
export function buildBlocks({ recentChats = [], checklistDone = new Set(), checklistDismissed = false, characterCards = [], widgets = [] } = {}) {
    const blocks = [];
    if (!checklistDismissed && !checklistProgress(checklistDone).complete) {
        blocks.push({ id: 'checklist', kind: BLOCK_KINDS.CHECKLIST, ...blockSize(BLOCK_KINDS.CHECKLIST, { count: FIRST_START_ITEMS.length }) });
    }
    blocks.push({ id: 'actions', kind: BLOCK_KINDS.ACTIONS, ...blockSize(BLOCK_KINDS.ACTIONS, { count: QUICK_ACTIONS.length }) });
    blocks.push({ id: 'recent', kind: BLOCK_KINDS.RECENT, ...blockSize(BLOCK_KINDS.RECENT, { count: recentChats.length }) });
    for (const item of widgets) {
        const size = item.size ?? WIDGET_DEFAULT_SIZE;
        blocks.push({ id: widgetBlockId(item.instanceId), kind: BLOCK_KINDS.WIDGET, instanceId: item.instanceId, widgetId: item.widgetId, w: size.w, h: size.h });
    }
    for (const avatar of characterCards) blocks.push({ id: characterBlockId(avatar), kind: BLOCK_KINDS.CHARACTER, avatar, ...blockSize(BLOCK_KINDS.CHARACTER) });
    return blocks;
}

/** Прижимает блок целиком в сцену. */
export function clampPlacement({ x, y, w, h }, { width, height }) {
    return { x: Math.round(Math.max(0, Math.min(x, Math.max(0, width - w)))), y: Math.round(Math.max(0, Math.min(y, Math.max(0, height - h)))), w, h };
}

/** Положение → доли свободного места (для хранения): 0 — у левого/верхнего края, 1 — у правого/нижнего. */
export function toSaved({ x, y, w, h }, { width, height }) {
    const fx = width > w ? x / (width - w) : 0;
    const fy = height > h ? y / (height - h) : 0;
    return { fx: Math.max(0, Math.min(1, Number(fx.toFixed(4)))), fy: Math.max(0, Math.min(1, Number(fy.toFixed(4)))) };
}

/** Доли → пиксели для блока размера `{w,h}` в сцене `{width,height}`. */
export function fromSaved({ fx = 0, fy = 0 }, { w, h }, { width, height }) {
    return { x: fx * Math.max(0, width - w), y: fy * Math.max(0, height - h) };
}

/** Два прямоугольника ближе друг к другу, чем `gap` (или пересекаются)? */
export const rectsCollide = (a, b, gap = BLOCK_SPACING) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

const collides = (rect, others, gap) => others.some(other => rectsCollide(rect, other, gap));

/**
 * Ближайшее к желаемому место, где блок не наезжает ни на один из `others` (и не ближе `gap`), целиком в сцене. Перебор идёт квадратными
 * кольцами вокруг желаемой точки с шагом `step`; если места нет совсем (сцена тесна) — возвращает желаемое, прижатое в сцену: лучше наезд, чем потеря блока.
 */
export function findFreeSpot(desired, others, stage, { gap = BLOCK_SPACING, step = 8, maxRings = 160 } = {}) {
    const base = clampPlacement(desired, stage);
    if (!collides(base, others, gap)) return base;
    let best = null;
    let bestDist = Infinity;
    for (let ring = 1; ring <= maxRings; ring += 1) {
        if (best && ring * step > bestDist) break;
        for (let i = -ring; i <= ring; i += 1) {
            const edge = i === -ring || i === ring;
            const offsets = edge ? Array.from({ length: 2 * ring + 1 }, (_, k) => [i, k - ring]) : [[i, -ring], [i, ring]];
            for (const [ox, oy] of offsets) {
                const spot = clampPlacement({ ...desired, x: desired.x + ox * step, y: desired.y + oy * step }, stage);
                const dist = Math.hypot(spot.x - desired.x, spot.y - desired.y);
                if (dist < bestDist && !collides(spot, others, gap)) { best = spot; bestDist = dist; }
            }
        }
    }
    return best ?? base;
}

/**
 * Стартовая раскладка: блоки текут по колонкам (каждый — в самую короткую), колонки стоят по центру сцены. Ширина колонки — самого широкого блока,
 * число колонок — сколько влезает. `saved` — положения, заданные пользователем (`{[id]: {fx, fy}}`): такие блоки ставятся на своё место и в поток не
 * идут. Блоки НЕ наезжают друг на друга: сначала встают сохранённые (при наезде сдвигаются на ближайшее свободное место), затем потоковые
 * обходят их. Возвращает `[{id, kind, x, y, w, h}]` в порядке `blocks`, всегда целиком внутри сцены (тесная сцена — блок прижимается к краю).
 */
export function composeHome({ width, height, blocks, saved = {}, gap = HOME_GAP, margin = HOME_MARGIN }) {
    const stage = { width, height };
    const free = blocks.filter(block => !saved[block.id]);
    const colW = Math.max(1, ...blocks.map(block => block.w));
    const cols = Math.max(1, Math.min(free.length || 1, Math.floor((width - 2 * margin + gap) / (colW + gap))));
    const stageW = cols * colW + (cols - 1) * gap;
    const left = Math.max(0, Math.round((width - stageW) / 2));
    const tops = new Array(cols).fill(margin);
    const flowed = new Map();
    for (const block of free) {
        let col = 0;
        for (let i = 1; i < cols; i += 1) if (tops[i] < tops[col]) col = i;
        flowed.set(block.id, { x: left + col * (colW + gap) + Math.round((colW - block.w) / 2), y: tops[col] });
        tops[col] += block.h + gap;
    }
    const placed = new Map();
    const put = (block, spot) => {
        const rect = findFreeSpot({ ...spot, w: block.w, h: block.h }, [...placed.values()], stage);
        placed.set(block.id, { ...block, ...rect });
    };
    for (const block of blocks) if (saved[block.id]) put(block, fromSaved(saved[block.id], block, stage));
    for (const block of free) put(block, flowed.get(block.id));
    return blocks.map(block => placed.get(block.id));
}

/**
 * Перетаскивание: новое положение блока со сдвигом курсора, не выходя за сцену и не наезжая на `others` (их прямоугольники). Упёрся в соседа —
 * скользит вдоль него (сохраняется движение по одной оси); если и так нельзя — остаётся на последнем допустимом месте `last`.
 */
export function dragPlacement(placement, { dx, dy }, stage, { others = [], last = placement, gap = BLOCK_SPACING } = {}) {
    const target = clampPlacement({ x: placement.x + dx, y: placement.y + dy, w: placement.w, h: placement.h }, stage);
    const tries = [target, { ...target, y: last.y }, { ...target, x: last.x }];
    const ok = tries.find(rect => !collides(rect, others, gap));
    const rect = ok ?? { x: last.x, y: last.y, w: placement.w, h: placement.h };
    return { ...placement, ...rect };
}

/** Порог сдвига, после которого жест — перетаскивание, а не клик по блоку. */
export const DRAG_THRESHOLD = 5;
export const isDrag = ({ dx, dy }) => Math.hypot(dx, dy) >= DRAG_THRESHOLD;

/**
 * Выбор из списка (персонажи, виджеты): без уже добавленных (`exclude` — значения поля `key`), по подстроке имени без учёта регистра; порядок сохраняется.
 */
export function filterItems(items, query = '', exclude = [], key = 'id') {
    const needle = String(query).trim().toLowerCase();
    const hidden = new Set(exclude);
    return items.filter(item => !hidden.has(item[key]) && (!needle || String(item.name).toLowerCase().includes(needle)));
}

/** То же для списка персонажей (`{ avatar, name }`): скрывает уже добавленные по файлу аватара. */
export const filterCharacters = (characters, query = '', exclude = []) => filterItems(characters, query, exclude, 'avatar');
