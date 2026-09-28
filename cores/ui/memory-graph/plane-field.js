/**
 * "Плоскость графа" — органичная подложка регионов, заменяет угловатые SVG-клинья (`zones-svg.js`, оставлен
 * нетронутым — старый код с тестами, план не разрешает удалять) по прямому запросу владельца: мягкая
 * кляксообразная область, раскрашенная по РАССТОЯНИЮ до нод, где плотный кластер нод "перетягивает" площадь
 * дальше, чем одиночная нода, а границы регионов размыты, не резкие.
 *
 * ТОЛЬКО чистые функции (тот же принцип, что у всего `cores/ui/memory-graph/*`) — рисование в `<canvas>`
 * (по сетке, с апскейлом для дешёвой мягкости) живёт в `memory-graph-panel.js`.
 */

// --- Контур плоскости ("клякса/галактика") ----------------------------------

const OUTLINE_SAMPLES = 96;
const OUTLINE_EXPANSION = 1.2; // во сколько раз шире реального внешнего края зон — подстройка на глаз
// Гармоники контура — ФИКСИРОВАННЫЕ (не случайные) частоты/фазы, чтобы форма была детерминирована и воспроизводима
// для одного и того же графа между перерисовками. Сумма амплитуд (0.06+0.04+0.025=0.125) меньше, чем
// `OUTLINE_EXPANSION - 1` (0.2) — контур ГАРАНТИРОВАННО не проваливается внутрь реального края зон даже в
// худшей фазе всех гармоник разом (см. тест "контур всегда снаружи реального края зон").
const OUTLINE_HARMONICS = [
    { k: 3, amplitude: 0.06, phase: 0.4 },
    { k: 5, amplitude: 0.04, phase: 2.1 },
    { k: 7, amplitude: 0.025, phase: 4.7 },
];

function normalizeAngle(angle) {
    const twoPi = 2 * Math.PI;
    return ((angle % twoPi) + twoPi) % twoPi;
}

/** Множитель "ряби" контура — колеблется вокруг 1, детерминирован по углу. */
function wobbleFactor(angle) {
    let factor = 1;
    for (const { k, amplitude, phase } of OUTLINE_HARMONICS) factor += amplitude * Math.sin(k * angle + phase);
    return factor;
}

/**
 * СГЛАЖЕННЫЙ (не ступенчатый) внешний радиус зон в направлении `angle` — косинусная интерполяция между двумя
 * соседними по кругу зонами (их биссектрисы), а не резкий скачок на границе зоны. `zoneSamples` — `[{angle,radius}]`,
 * отсортированные по углу, одна точка на зону.
 */
function smoothZoneRadiusAt(angle, zoneSamples) {
    if (zoneSamples.length === 1) return zoneSamples[0].radius;
    let upperIndex = zoneSamples.findIndex(sample => sample.angle >= angle);
    if (upperIndex === -1) upperIndex = 0; // угол больше всех точек — сосед справа "заворачивает" на первую
    const lowerIndex = (upperIndex - 1 + zoneSamples.length) % zoneSamples.length;
    const lower = zoneSamples[lowerIndex];
    const upper = zoneSamples[upperIndex];
    let span = upper.angle - lower.angle;
    if (span <= 0) span += 2 * Math.PI; // переход через "шов" 0/2π
    let offset = angle - lower.angle;
    if (offset < 0) offset += 2 * Math.PI;
    const t = span > 0 ? offset / span : 0;
    const eased = (1 - Math.cos(t * Math.PI)) / 2; // 0..1, плавный разгон/торможение на стыке (не линейно)
    return lower.radius + (upper.radius - lower.radius) * eased;
}

/** Радиус плоскости в направлении `angle` — сглаженный край зон, расширенный и деформированный рябью. Публичная, чтобы её же могла звать отрисовка canvas (маска края) без пересчёта зон заново. */
export function planeRadiusAt(angle, zones, { expansion = OUTLINE_EXPANSION } = {}) {
    if (!zones.length) return 0;
    const zoneSamples = zones
        .map(zone => ({ angle: normalizeAngle((zone.a0 + zone.a1) / 2), radius: zone.rOuter }))
        .sort((a, b) => a.angle - b.angle);
    return smoothZoneRadiusAt(normalizeAngle(angle), zoneSamples) * expansion * wobbleFactor(normalizeAngle(angle));
}

/** Замкнутый многоугольник контура плоскости — `samples` точек по кругу. Пустые зоны → пустой контур (рисовать нечего, тот же принцип, что у `renderZonesSvg()`). */
export function computePlaneOutline(zones, { expansion = OUTLINE_EXPANSION, samples = OUTLINE_SAMPLES } = {}) {
    if (!zones.length) return { points: [] };
    const points = [];
    for (let i = 0; i < samples; i += 1) {
        const angle = (i / samples) * 2 * Math.PI;
        const radius = planeRadiusAt(angle, zones, { expansion });
        points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    }
    return { points };
}

// --- Поле силы по расстоянию (раскраска плоскости) --------------------------

const DISTANCE_SOFTENING = 100; // px² — смягчение обратного квадрата У САМОЙ ноды (не даёт деления на ноль/острого пика)
// Минимальная гарантированная зона региона (по запросу владельца — регион не должен "исчезать" рядом с плотным
// чужим кластером): в пределах этого радиуса от ЛЮБОЙ ноды региона его поле получает бонус, плавно спадающий к
// нулю к краю. Порядок величины — сравним с `NODE_RADIUS.max` (layout.js, 16) плюс запас.
const MIN_REGION_RADIUS = 26;

function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * `nodePoints`: `[{x, y, regionId}]`. → `Map(regionId → сила)` в точке `(x,y)`.
 *
 * Базовое поле — ОБРАТНЫЙ КВАДРАТ расстояния, СУММИРУЕМЫЙ по всем нодам региона: несколько нод одного региона
 * складывают свои вклады (та же математика, что у суммы гравитационных/электрических потенциалов нескольких точечных
 * источников) — поэтому у плотного кластера итоговая сила в произвольной точке ЕСТЕСТВЕННО больше, чем у одной
 * далёкой ноды на том же расстоянии. "Сила растёт с плотностью" — не отдельный коэффициент, а прямое следствие
 * суммирования (решение владельца: без "отдельной формулы плотности").
 *
 * ПОВЕРХ базового поля — гарантированный минимум региона (`MIN_REGION_RADIUS`): бонус, что ЗАВЕДОМО перекрывает
 * максимально возможную сумму базовых полей ЛЮБОГО количества нод (`nodePoints.length / DISTANCE_SOFTENING` —
 * теоретический потолок суммы, если бы ВСЕ прочие ноды стояли на расстоянии 0 от точки, что физически невозможно,
 * но даёт строгую, не подобранную на глаз, гарантию для графа ЛЮБОГО размера), плюс небольшой запас.
 */
export function regionFieldAt(x, y, nodePoints) {
    const minBonus = nodePoints.length / DISTANCE_SOFTENING + 10;
    const fields = new Map();
    for (const node of nodePoints) {
        const dx = x - node.x;
        const dy = y - node.y;
        const distanceSquared = dx * dx + dy * dy;
        const base = 1 / (distanceSquared + DISTANCE_SOFTENING);
        const distance = Math.sqrt(distanceSquared);
        const bonus = minBonus * (1 - smoothstep(0, MIN_REGION_RADIUS, distance)); // 1 у самой ноды → 0 на границе MIN_REGION_RADIUS
        fields.set(node.regionId, (fields.get(node.regionId) ?? 0) + base + bonus);
    }
    return fields;
}

// --- Смешение цвета по полю --------------------------------------------------

const DEFAULT_SHARPNESS = 3;

/** HSL (h: 0-360, s/l: 0-100) → RGB (0-255) — стандартная формула, нужна для записи реальных байт в ImageData канваса (в отличие от `hsl(...)` CSS-строки, которой обходится `metrics.js`'s `region`-метрика для стилей Cytoscape). Экспортирована — тестам нужен эталонный цвет для проверки смешения. */
export function hslToRgb(h, s, l) {
    const sat = s / 100;
    const light = l / 100;
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const hp = normalizeAngle((h * Math.PI) / 180) / (Math.PI / 3);
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = light - c / 2;
    let [r, g, b] = [0, 0, 0];
    if (hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * `fieldMap` — вывод `regionFieldAt()`. `hueByRegionId` — `Map(regionId → hue)` (тот же `hue`, что красит зону/
 * ноду метрики `region`, `metrics.js` — визуальная согласованность). → `{r,g,b,a}` (0-255 / 0-1).
 *
 * Смешение — НЕ голая доля от суммы (дала бы слишком "молочный", равномерно размытый результат даже там, где один
 * регион явно доминирует) — вес каждого региона = `сила^sharpness`, нормированная; чем выше `sharpness`, тем ближе
 * переход к резкому (классический Voronoi), чем ниже — тем шире зона смешения между соседями.
 *
 * РЕАЛЬНАЯ ЖАЛОБА пользователя (скриншот): при непрозрачности, зависящей ещё и от АБСОЛЮТНОЙ величины поля (была
 * тут раньше — насыщающаяся экспонента от суммы), обратный квадрат расстояния гаснет настолько быстро, что почти
 * вся "плоскость" оставалась непрокрашенной — цвет виден только в узком кольце вплотную к самим нодам, а не по всей
 * кляксе, как просил пользователь ("ВСЯ клякса должна быть покрашена в цвета регионов"). Исправлено — ЦВЕТ (какой
 * регион доминирует ГДЕ) и НЕПРОЗРАЧНОСТЬ (стоит ли вообще что-то рисовать в этой точке) теперь РАЗДЕЛЕНЫ:
 * `dominantBlend()` отвечает только за цвет (по ОТНОСИТЕЛЬНЫМ, не абсолютным, весам — они не гаснут с расстоянием,
 * просто становятся более "размытыми" между дальними регионами), альфа — `1`, если в точке есть ХОТЬ КАКОЕ-ТО поле
 * (значит, точка внутри охвата графа), иначе `0`. Настоящее затухание "непрозрачности к краю" — забота
 * `paintZonesCanvas()` (memory-graph-panel.js): маска по контуру плоскости (`computePlaneOutline()`/`planeRadiusAt()`),
 * не по величине поля — так вся клякса красится, а не только окрестность нод.
 */
export function dominantBlend(fieldMap, hueByRegionId, { sharpness = DEFAULT_SHARPNESS } = {}) {
    const entries = [...fieldMap.entries()];
    const total = entries.reduce((sum, [, strength]) => sum + strength, 0);
    if (!entries.length || total <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    const weighted = entries.map(([regionId, strength]) => [regionId, strength ** sharpness]);
    const weightedTotal = weighted.reduce((sum, [, w]) => sum + w, 0);
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [regionId, w] of weighted) {
        const weight = weightedTotal > 0 ? w / weightedTotal : 1 / weighted.length;
        const hue = hueByRegionId instanceof Map ? (hueByRegionId.get(regionId) ?? 0) : (hueByRegionId?.[regionId] ?? 0);
        const [nr, ng, nb] = hslToRgb(hue, 60, 55);
        r += nr * weight;
        g += ng * weight;
        b += nb * weight;
    }
    // `a` — просто "есть ли тут вообще какое-то поле" (1, раз мы уже прошли проверку `total > 0` выше), НЕ функция
    // от его абсолютной величины (была тут раньше, см. doc-comment выше за причиной убрать) — настоящее затухание
    // непрозрачности к краю плоскости считает `paintZonesCanvas()` по КОНТУРУ, не по полю.
    return { r, g, b, a: 1 };
}
