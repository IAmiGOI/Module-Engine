/**
 * Режимы работы графа памяти (MEMORY_GRAPH_TYPES_PLAN.md, этап 0; решение владельца: «новая модель — новый режим, прежний
 * остаётся как legacy»).
 *
 * - `legacy` — граф работает как до плана видов нод: ноды без видов, центры регионов — «защищённые» ноды, двусторонние рёбра,
 *   бутстрап по базовым регионам, прежний формат извлечения. Все существующие чаты — legacy.
 * - `structured` — новая модель: виды нод (сущность/объект/факт/событие), уровень Core, направленные рёбра событий, тематический
 *   бутстрап, извлечение с субъектами, рождение регионов, таймлайн.
 *
 * Режим — свойство КОНКРЕТНОГО графа (ключ `graphMeta` в памяти чата), не глобальный переключатель: в одном чате граф может быть
 * legacy, в соседнем — structured. Новое поведение включается флагом `features.<имя>` В ОДНОМ МЕСТЕ — на входе функции,
 * а не размазанным `if` внутри алгоритмов; чистые функции режим не знают. Исправления ошибок из прежних планов (размещение по
 * сходству, часы, маяки, защита от смены чата…) к режимам не относятся — они работают в обоих.
 */

export const MODES = Object.freeze(['legacy', 'structured']);

const FLAG_NAMES = Object.freeze([
    'kinds',                // виды нод, `kind`/`subtype`
    'core',                 // уровень Core (центры регионов)
    'directedEvents',       // направленные рёбра событий и правило таймлайна
    'structuredExtraction', // новый JSON извлечения: вид, субъекты, время, алиасы
    'subjects',             // разрешение субъектов, рёбра и регион по главному субъекту
    'timeline',             // цепочки событий, сворачивание старых
    'regionBirth',          // новые регионы вокруг Core
    'thematicBootstrap',    // бутстрап строит тематические регионы
    'eventsInRetrieval',    // секция «Recent events» в ретриве
    'plotSkeleton',         // блок «сюжетный каркас» (дополнительно включается своей настройкой)
]);

/** Флаги режима: legacy — всё выключено, structured — всё включено. Неизвестный режим читается как legacy. */
export function featuresFor(mode) {
    const on = mode === 'structured';
    return Object.freeze(Object.fromEntries(FLAG_NAMES.map(name => [name, on])));
}

export const normalizeMode = mode => (MODES.includes(mode) ? mode : 'legacy');

/** Метаданные графа: чат без `graphMeta` — legacy (все существующие чаты). Мусор в данных не роняет загрузку. */
export function normalizeGraphMeta(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const meta = { mode: normalizeMode(source.mode), version: 1, createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null };
    if (typeof source.libraryId === 'string' && source.libraryId) meta.libraryId = source.libraryId;
    if (typeof source.convertedFrom === 'string') meta.convertedFrom = source.convertedFrom;
    if (Number.isFinite(source.bootstrapCoreCount)) meta.bootstrapCoreCount = source.bootstrapCoreCount; // Core на конец бутстрапа/конвертации: не запирают автоповышение (core-tier.js)
    return meta;
}

/**
 * Миграция данных legacy → structured (только структура, без вызовов модели): ноды без `kind` — `fact`; `protectedNode: true` —
 * `core: true` (оба поля остаются синонимами, чтобы существующий код вытеснения, весов и маяков работал без переписывания).
 * Рёбра не меняются. Возвращает НОВЫЙ объект нод (входной не мутируется); идемпотентна.
 */
export function migrateNodesToStructured(nodes) {
    const migrated = {};
    for (const [id, node] of Object.entries(nodes ?? {})) {
        migrated[id] = { ...node, kind: node.kind ?? 'fact', core: node.core ?? Boolean(node.protectedNode) };
        if (migrated[id].core) migrated[id].protectedNode = true;
    }
    return migrated;
}
