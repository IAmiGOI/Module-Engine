/**
 * Геометрия окна графа памяти — старая дартборд-сетка (5 секторов × 3 кольца) и её вспомогательные форматы (фон,
 * семантические регионы, накопитель) — MEMORY_GRAPH_UI_PLAN.md, Этап 1: чистый перенос из верха
 * `cores/ui/memory-graph-panel.js` БЕЗ ИЗМЕНЕНИЯ ПОВЕДЕНИЯ (план явно требует "только перенос кода"). Названо
 * "legacy" заранее — Этап 3 того же плана заменяет саму раскладку (дартборд → зоны-кольца регионов вокруг центра,
 * "подсолнух" внутри региона), но эти функции пока продолжают полностью обслуживать окно; переименовывать/удалять
 * их сейчас нельзя — на них уже есть тесты, и план явно запрещает менять/убирать код раньше времени ("не удалять
 * старые экспортируемые функции, на которые есть тесты").
 */

export const BG_SVG_ID = 'stme-memory-graph-region-bg-svg';
export const MAX_RADIUS = 480; // x2 от исходных 240 — узлы стали в 10 раз меньше визуально, ближний вид "слипался"

// --- Геометрия: региональная сетка ↔ экранные координаты (чистые функции) --

const MIN_ANCHOR_DISTANCE = 16;
const MIN_POINT_DISTANCE = 8;
// "Малые" (обычные) ноды — решено с пользователем явно: потолок 30px от
// точки привязки. Центр региона (индекс 0, "основная" нода) никогда не
// подходит к этому потолку в принципе — он всегда сидит на minAnchorDistance
// (16px), самом БЛИЖНЕМ кольце, так что отдельного исключения ему не нужно:
// "основные ноды могут быть дальше" уже выполняется автоматически (центр —
// ближе всех, а не дальше).
const MAX_ANCHOR_DISTANCE = 30;

/**
 * Позиция N-й ноды внутри региона относительно его точки привязки —
 * концентрические кольца, а не угловой веер (решено с пользователем явно,
 * числами: "минимальная дистанция от точки привязки - 16 пикселей,
 * минимальная дистанция до любой другой точки - 8 пикселей"; прежний
 * угловой веер с фиксированным раствором `sectorAngle*0.7` от этого не
 * защищал — при многих нодах в регионе (до 23) они сжимались теснее 8px).
 *
 * Кольцо k — радиус `minAnchorDistance + minPointDistance*k`, ЗАЖАТЫЙ
 * сверху `maxAnchorDistance` (решено с пользователем: "максимальная
 * удалённость от точки привязки... если малые — то максимальная 30
 * пикселей"). Радиальный шаг между кольцами РАВЕН minPointDistance ПОКА
 * радиус не упёрся в потолок — этого одного факта достаточно, чтобы ЛЮБЫЕ
 * две точки из соседних (или более дальних) колец были на дистанции ≥
 * minPointDistance друг от друга, независимо от угла. При текущих
 * настройках (16/8/30, maxNodesPerRegion=23) потолок вообще не
 * достигается: первых двух колец (12+18=30 мест) хватает на весь регион
 * целиком — упор в потолок документированный, но практически недостижимый
 * крайний случай. Внутри одного кольца точки разнесены по хорде:
 * `2*r*sin(dθ/2) = minPointDistance` даёт максимальное число точек на
 * кольце без нарушения той же дистанции. Результат — угол/радиус в
 * ЛОКАЛЬНОЙ системе (0° — вдоль луча от начала координат наружу),
 * поворачивается на `centerAngle` вызывающим кодом: так нода #0 ложится
 * СТРОГО по тому же лучу, что и сама точка привязки (просто дальше на
 * minAnchorDistance), не смещая угол — раскладка внутри региона не съезжает
 * в соседний сектор на малых радиусах.
 *
 * Не зависит от `countInRegion` — в отличие от прежнего веера, позиция
 * ноды #5 не пересчитывается заново каждый раз, когда в регион добавляется
 * ноды #6: пришедшие раньше не "плавают" при новых вставках.
 */
export function packOffsetInRegion(indexInRegion, { minAnchorDistance = MIN_ANCHOR_DISTANCE, minPointDistance = MIN_POINT_DISTANCE, maxAnchorDistance = MAX_ANCHOR_DISTANCE } = {}) {
    let remaining = Math.max(0, Math.floor(indexInRegion) || 0);
    let ringIndex = 0;
    for (;;) {
        const radius = Math.min(minAnchorDistance + minPointDistance * ringIndex, maxAnchorDistance);
        const step = 2 * Math.asin(Math.min(1, minPointDistance / (2 * radius)));
        const capacity = Math.max(1, Math.floor((2 * Math.PI) / step));
        if (remaining < capacity) {
            // `+ ringIndex * step/2` — соседние кольца сдвинуты друг относительно
            // друга на полшага, чтобы точки не легли строго по радиальным линиям
            // (косметика, на гарантии дистанций не влияет).
            return { radius, angle: remaining * step + ringIndex * (step / 2) };
        }
        remaining -= capacity;
        ringIndex += 1;
    }
}

/**
 * Экранная позиция узла внутри его региона — точка привязки региона
 * (центр сектора/кольца дартса) плюс `packOffsetInRegion()`, повёрнутый на
 * тот же угол, что и сама точка привязки.
 */
export function regionLayoutPosition(sector, ring, { maxRadius = MAX_RADIUS, sectors = 5, rings = 3, indexInRegion = 0, minAnchorDistance = MIN_ANCHOR_DISTANCE, minPointDistance = MIN_POINT_DISTANCE, maxAnchorDistance = MAX_ANCHOR_DISTANCE } = {}) {
    const sectorAngle = (2 * Math.PI) / sectors;
    const centerAngle = sector * sectorAngle + sectorAngle / 2 - Math.PI / 2; // сектор 0 начинается сверху
    const ringInner = (ring / rings) * maxRadius;
    const ringOuter = ((ring + 1) / rings) * maxRadius;
    const anchorRadius = (ringInner + ringOuter) / 2;
    const anchorX = Math.cos(centerAngle) * anchorRadius;
    const anchorY = Math.sin(centerAngle) * anchorRadius;
    const offset = packOffsetInRegion(indexInRegion, { minAnchorDistance, minPointDistance, maxAnchorDistance });
    const globalAngle = centerAngle + offset.angle;
    return {
        x: Math.round(anchorX + Math.cos(globalAngle) * offset.radius),
        y: Math.round(anchorY + Math.sin(globalAngle) * offset.radius),
    };
}

/**
 * Обратная операция — точка сброса драга → регион. Используется на
 * `dragfree` cytoscape, поэтому это и есть "перетаскивание = смена
 * региона" (решено с пользователем). `dx`/`dy` — координаты ОТНОСИТЕЛЬНО
 * центра канваса (не экрана целиком).
 */
export function pixelToRegion(dx, dy, { maxRadius = MAX_RADIUS, sectors = 5, rings = 3 } = {}) {
    const radius = Math.min(Math.sqrt(dx * dx + dy * dy), maxRadius - 0.001);
    let angle = Math.atan2(dy, dx) + Math.PI / 2; // отменяем сдвиг -90°, что и в regionLayoutPosition
    if (angle < 0) angle += 2 * Math.PI;
    const sectorAngle = (2 * Math.PI) / sectors;
    const sector = Math.min(sectors - 1, Math.floor((angle % (2 * Math.PI)) / sectorAngle));
    const ring = Math.max(0, Math.min(rings - 1, Math.floor((radius / maxRadius) * rings)));
    return { sector, ring };
}

// --- Фон регионов — решено с пользователем: "сложно визуально разграничить
// регионы, добавь слабую заливку фона". Рисуется В МОДЕЛЬНЫХ единицах
// Cytoscape (тех же, что `regionLayoutPosition`/`pixelToRegion`, радиус до
// MAX_RADIUS), а не в экранных пикселях — реальный zoom/pan МЕНЯЕТСЯ живьём
// (колесо мыши/драг канваса), и статичная подложка, посчитанная под ОДИН
// фиксированный масштаб, уезжала бы от нод при любом взаимодействии
// (живой баг, поймано пользователем: "фон, который физически уезжает" —
// "можно двигать и приближать фон"). Вместо этого элемент с подложкой несёт
// CSS `transform: translate(pan) scale(zoom)`, обновляемый на КАЖДОЕ
// `cy.on('pan zoom', ...)` — тот же расчёт экран=pan+модель*zoom, что и у
// самого Cytoscape, поэтому подложка синхронна с нодами при любом
// взаимодействии, не только в начальный момент. Не через `h()`-дерево — оно
// строит элементы через обычный `document.createElement` (не
// `createElementNS`), SVG-теги так не рендерятся как векторная графика.

/** Путь одной ячейки дартса (сектор×кольцо) в МОДЕЛЬНЫХ единицах — тот же угол, что у `regionLayoutPosition`/`pixelToRegion`, тот же масштаб радиуса (`maxRadius`). Кольцо 0 — сплошной клин от центра (без вырожденной дуги радиуса 0), остальные — кольцевой сегмент. */
export function regionWedgePath(sector, ring, { sectors = 5, rings = 3, maxRadius = MAX_RADIUS } = {}) {
    const sectorAngle = (2 * Math.PI) / sectors;
    const a0 = sector * sectorAngle - Math.PI / 2;
    const a1 = a0 + sectorAngle;
    const cx = maxRadius;
    const cy = maxRadius;
    const r1 = ((ring + 1) / rings) * maxRadius;
    const pt = (r, a) => `${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`;
    if (ring === 0) {
        return `M ${cx.toFixed(2)},${cy.toFixed(2)} L ${pt(r1, a0)} A ${r1.toFixed(2)} ${r1.toFixed(2)} 0 0 1 ${pt(r1, a1)} Z`;
    }
    const r0 = (ring / rings) * maxRadius;
    return `M ${pt(r0, a0)} L ${pt(r1, a0)} A ${r1.toFixed(2)} ${r1.toFixed(2)} 0 0 1 ${pt(r1, a1)} L ${pt(r0, a1)} A ${r0.toFixed(2)} ${r0.toFixed(2)} 0 0 0 ${pt(r0, a0)} Z`;
}

/**
 * Вся подложка — 15 ячеек, шахматная заливка по чётности (sector+ring),
 * чтобы соседние регионы отличались на глаз, но не спорили с нодами/рёбрами
 * поверх. `<svg>` — ЯВНЫЕ пиксельные `width`/`height` (не `100%`), чтобы
 * 1 единица SVG = 1 CSS-пиксель РОВНО, без скрытого масштабирования от
 * вписывания в контейнер — иначе внешний `transform: scale(zoom)` (см.
 * `updateBackgroundTransform()`) домножался бы на этот скрытый коэффициент
 * и съезжал относительно реальных позиций нод. `id`/`style` — на самом
 * `<svg>`, чтобы `updateBackgroundTransform()` мог найти его напрямую и
 * применить transform без лишней обёртки.
 */
export function renderRegionBackgroundSvg({ sectors = 5, rings = 3, maxRadius = MAX_RADIUS } = {}) {
    const cells = [];
    for (let sector = 0; sector < sectors; sector += 1) {
        for (let ring = 0; ring < rings; ring += 1) {
            const fill = (sector + ring) % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.07)';
            cells.push(`<path d="${regionWedgePath(sector, ring, { sectors, rings, maxRadius })}" fill="${fill}" stroke="rgba(255,255,255,0.08)" stroke-width="0.5" />`);
        }
    }
    const size = maxRadius * 2;
    return `<svg id="${BG_SVG_ID}" style="position:absolute;left:0;top:0;transform-origin:0 0;" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${cells.join('')}</svg>`;
}

/**
 * Реальный баг, найден по жалобе пользователя ("точка отсчета не верная" —
 * скриншот показал дартборд-подложку, видную только в углу канваса, вместо
 * центра). `regionWedgePath()`'s геометрический центр (где сходятся все
 * клинья) лежит в ЛОКАЛЬНЫХ SVG-координатах `(maxRadius, maxRadius)`, а не
 * `(0, 0)` — `<svg>` рисуется от `viewBox="0 0 ${2*maxRadius} ${2*maxRadius}"`
 * (см. `renderRegionBackgroundSvg()`). Модельные же координаты Cytoscape
 * (где считаются позиции нод — `regionLayoutPosition()`/
 * `fallbackSemanticPosition()`) центрированы на MODEL `(0, 0)`. Старый код
 * применял к `<svg>` ТОЧНО тот же `translate(pan.x, pan.y) scale(zoom)`, что
 * и у самого Cytoscape для модельных координат — это верно ТОЛЬКО если
 * SVG-локальный `(0,0)` совпадает с MODEL `(0,0)`, а у него на самом деле
 * есть постоянное смещение на `(maxRadius, maxRadius)`. Итог: центр
 * подложки рендерился на экране в точке `(pan.x + maxRadius*zoom, pan.y +
 * maxRadius*zoom)` — на `maxRadius*zoom` пикселей правее/ниже, чем
 * настоящий MODEL `(0,0)` (который рендерится ровно в `(pan.x, pan.y)`).
 * При типичном `zoom≈0.5` для канваса 480px это ~240px — почти вся
 * подложка уезжала за пределы видимой области, что и видно на скриншоте
 * (клинья — только в углу).
 *
 * Исправление — тот же трюк, что нужен был бы для ноды, сидящей в MODEL
 * `(-maxRadius, -maxRadius)`: вычитаем это смещение (в экранных пикселях,
 * то есть ПОСЛЕ домножения на zoom) из `pan` перед подстановкой в
 * `translate()`. Чистая функция — сам `<svg>`-элемент недоступен вне DOM,
 * поэтому тестируется именно возвращаемая строка трансформа, не побочный
 * эффект на реальном элементе.
 */
export function backgroundTransformCss(pan, zoom, maxRadius = MAX_RADIUS) {
    const offsetX = pan.x - maxRadius * zoom;
    const offsetY = pan.y - maxRadius * zoom;
    return `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
}

/**
 * ВРЕМЕННАЯ защита, не полноценная визуализация (решено с пользователем
 * явно — раскладка UI для семантических регионов бутстрапа, MEMORY_GRAPH.md,
 * "LLM-driven семантические регионы" — отдельный заход). У семантического
 * `regionId` (например "Locations") нет "sector:ring" — без ветки, которая
 * зовёт эту функцию в `nodeElements()`, `regionId.split(':').map(Number)`
 * дал бы `NaN`-координаты (не краш, но нода рендерилась бы в
 * непредсказуемом/невидимом месте).
 *
 * История правок (реальные жалобы пользователя со скриншотами, по порядку):
 * 1) угол по ХЭШУ строки региона (похожие имена ложились рядом) плюс
 *    КВАДРАТНАЯ сетка смещений — узлы были сбиты в тесный ком в одном углу.
 * 2) заменено на равномерное угловое распределение (`2π/N`) по ФИКСИРОВАННОМУ
 *    радиусу (`0.75*MAX_RADIUS`) — независимо от числа регионов. При МАЛОМ
 *    N (типично 3-5 регионов) это раскидывало якоря региона на сотни
 *    пикселей друг от друга ("регионы далеко друг от друга"), а разброс
 *    ВНУТРИ региона (16/8/150 — те же числа, что у дартборда) при небольшом
 *    числе нод в регионе едва выходит за первое кольцо (радиус ~16-24px) —
 *    "внутри региона слишком близко". Плюс размер ноды (3px) откровенно
 *    мелкий на таком масштабе.
 *
 * Сейчас: радиус якоря РАССЧИТЫВАЕТСЯ от числа регионов
 * (`semanticAnchorRadius()`) так, чтобы соседние регионы едва не касались
 * друг друга (зазор `SEMANTIC_REGION_GAP` между их дальними краями), а не
 * раскидывались на фиксированную долю канваса — регионы больше не "далеко
 * друг от друга" сильнее, чем нужно для их же собственного разброса.
 * Разброс ВНУТРИ региона — свои, ЗНАЧИТЕЛЬНО более крупные шаги
 * (`SEMANTIC_MIN_ANCHOR_DISTANCE`/`SEMANTIC_MIN_POINT_DISTANCE`), чем у
 * дартборда: там 16/8px были откалиброваны под клиновидную ячейку и до 23
 * нод в регионе; здесь даже 3-5 нод одного региона уже видимо расходятся
 * кольцом, а не жмутся точкой у центра.
 */
export const SEMANTIC_MIN_ANCHOR_DISTANCE = 36;
export const SEMANTIC_MIN_POINT_DISTANCE = 24;
export const SEMANTIC_MAX_ANCHOR_DISTANCE = 160;
export const SEMANTIC_REGION_GAP = 30; // зазор МЕЖДУ дальними краями (maxAnchorDistance) двух соседних регионов, не между их центрами

/**
 * Радиус, на котором лежат якоря N семантических регионов, равномерно
 * распределённых по кругу (`2π/N`). Хорда между двумя СОСЕДНИМИ якорями —
 * `2*radius*sin(π/N)` — подбирается так, чтобы она равнялась
 * `2*SEMANTIC_MAX_ANCHOR_DISTANCE + SEMANTIC_REGION_GAP` (края разброса
 * двух соседних регионов едва не соприкасаются, с небольшим зазором), а не
 * бралась произвольной долей канваса. Зажато снизу (регион не жмётся к
 * центру уже при N=2-3) и сверху `MAX_RADIUS` (при большом N — та же
 * теснота, что у дартборда при переполнении: единственное кольцо регионов
 * не резиновое, но это плавная деградация, не обрыв/наложение в одну точку).
 */
export function semanticAnchorRadius(regionCount) {
    const count = Math.max(1, Math.floor(regionCount) || 0);
    const desiredChord = 2 * SEMANTIC_MAX_ANCHOR_DISTANCE + SEMANTIC_REGION_GAP;
    const minRadius = SEMANTIC_MAX_ANCHOR_DISTANCE + SEMANTIC_REGION_GAP;
    if (count <= 1) return minRadius; // один регион — сравнивать не с кем, просто разумный отступ от центра
    const radius = desiredChord / (2 * Math.sin(Math.PI / count));
    return Math.min(MAX_RADIUS - SEMANTIC_MAX_ANCHOR_DISTANCE, Math.max(minRadius, radius));
}

export function fallbackSemanticPosition(regionId, indexInRegion, semanticRegionIds) {
    const count = Math.max(1, semanticRegionIds.length);
    const idx = Math.max(0, semanticRegionIds.indexOf(regionId));
    const centerAngle = (idx / count) * 2 * Math.PI - Math.PI / 2; // регион 0 начинается сверху, как и сектор 0 у дартборда
    const anchorRadius = semanticAnchorRadius(count);
    const anchorX = Math.cos(centerAngle) * anchorRadius;
    const anchorY = Math.sin(centerAngle) * anchorRadius;
    const offset = packOffsetInRegion(indexInRegion, {
        minAnchorDistance: SEMANTIC_MIN_ANCHOR_DISTANCE, minPointDistance: SEMANTIC_MIN_POINT_DISTANCE, maxAnchorDistance: SEMANTIC_MAX_ANCHOR_DISTANCE,
    });
    const globalAngle = centerAngle + offset.angle;
    return {
        x: Math.round(anchorX + Math.cos(globalAngle) * offset.radius),
        y: Math.round(anchorY + Math.sin(globalAngle) * offset.radius),
    };
}

/**
 * Позиция узла, застрявшего в накопителе (`node.regionId === null` — каскад
 * `cores/memory-graph/index.js`'s `placeNewNode()` не нашёл уверенного
 * региона). Раньше ВСЕ такие узлы рисовались буквально в `{x:0, y:0}` —
 * не отдельной ячейкой, а одной и той же точкой для любого их количества,
 * так что живьём это выглядело так, будто узел вообще не появился ("каскад
 * не проходит" — реальная жалоба пользователя). Якорь — за пределами
 * ПОСЛЕДНЕГО кольца дартборда (`MAX_RADIUS + SEMANTIC_REGION_GAP`), не
 * десятый регион и не центр канваса: визуально сразу видно, что это
 * ОТДЕЛЬНАЯ, временная зона, а не часть дерева регионов. Тот же
 * `packOffsetInRegion()`, что и у семантических регионов, — узлы реально
 * разносятся друг от друга по мере роста очереди, не наслаиваются.
 */
// + SEMANTIC_MAX_ANCHOR_DISTANCE (не только + GAP) — packOffsetInRegion()
// раскладывает узлы ПО ВСЕМ углам вокруг якоря, а не только наружу от
// начала координат; узел, чей офсет пришёлся почти точно НАВСТРЕЧУ якорю
// (максимальный радиус кольца, угол ~180° от направления на якорь), иначе
// мог бы придвинуться обратно внутрь дартборда. Гарантия: даже в этом
// худшем случае итоговое расстояние от центра канваса — не меньше
// MAX_RADIUS + SEMANTIC_REGION_GAP, то есть накопитель НИКОГДА визуально не
// перекрывается с последним кольцом дартборда, для любого узла в очереди.
export const STAGING_ANCHOR_DISTANCE = MAX_RADIUS + SEMANTIC_MAX_ANCHOR_DISTANCE + SEMANTIC_REGION_GAP;
const STAGING_ANCHOR_ANGLE = Math.PI / 2; // "юг" канваса, прямо под дартбордом — тот же угол-от-начала-координат, что anchorX/anchorY у regionLayoutPosition/fallbackSemanticPosition

export function stagedNodePosition(indexInRegion) {
    const anchorX = Math.cos(STAGING_ANCHOR_ANGLE) * STAGING_ANCHOR_DISTANCE;
    const anchorY = Math.sin(STAGING_ANCHOR_ANGLE) * STAGING_ANCHOR_DISTANCE;
    const offset = packOffsetInRegion(indexInRegion, {
        minAnchorDistance: SEMANTIC_MIN_ANCHOR_DISTANCE, minPointDistance: SEMANTIC_MIN_POINT_DISTANCE, maxAnchorDistance: SEMANTIC_MAX_ANCHOR_DISTANCE,
    });
    const globalAngle = STAGING_ANCHOR_ANGLE + offset.angle;
    return {
        x: Math.round(anchorX + Math.cos(globalAngle) * offset.radius),
        y: Math.round(anchorY + Math.sin(globalAngle) * offset.radius),
    };
}
