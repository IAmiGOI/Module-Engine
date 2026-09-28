/**
 * Раскладка графа памяти — MEMORY_GRAPH_UI_PLAN.md, Этап 3. ТОЛЬКО чистые функции, без DOM/Cytoscape — секторы
 * становятся ДАННЫМИ (зонами), из которых одновременно рисуется фон (Этап 4), раскладываются ноды и решается,
 * "куда бросили/кликнули" (Этап 7). Заменяет геометрический СМЫСЛ `legacy-geometry.js` (дартборд 5×3 для не тех
 * регионов, Б1 плана) — та Библиотека остаётся нетронутой (свои тесты, план запрещает удалять код с тестами), но
 * окно (Этап 4) переключается на эту.
 */

// --- 3.1 Радиус ноды ---------------------------------------------------------

export const NODE_RADIUS = { min: 4, perSqrtDegree: 2.2, max: 16, protectedBonus: 2 };

/** Радиус узла на холсте — растёт с числом связей (пункт 2 запроса владельца: "размер = число связей"), упирается в потолок; защищённые (центр/под-центр) — БОНУС ПОВЕРХ потолка, не входит в клэмп (они и так крупнее видны). */
export function nodeRadius({ degree = 0, protectedNode = false } = {}) {
    const base = Math.min(NODE_RADIUS.max, Math.max(NODE_RADIUS.min, NODE_RADIUS.min + NODE_RADIUS.perSqrtDegree * Math.sqrt(Math.max(0, degree))));
    return base + (protectedNode ? NODE_RADIUS.protectedBonus : 0);
}

// --- 3.2 Минимальный зазор — растёт с размером -------------------------------

// Реальная жалоба пользователя (скриншот): ноды в регионе визуально слипаются/накладываются друг на друга —
// зазор увеличен (было `{base:4, perRadius:0.5}`, затем по прямому запросу владельца — до `base:20`). Числа —
// подобраны на глаз, не физическая константа; `minCenterDistance()` ниже пересчитывает свой тест ИЗ этих чисел,
// менять тест не нужно.
export const GAP = { base: 20, perRadius: 0.6 };

/** Минимальное расстояние между центрами двух нод: сумма радиусов + зазор, растущий с БОЛЬШЕЙ из двух нод (крупная нода — крупнее и её "личное пространство"). */
export function minCenterDistance(rA, rB) {
    return rA + rB + GAP.base + GAP.perRadius * Math.max(rA, rB);
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈137.508° — спираль Фогеля, "подсолнух"

/**
 * Позиции нод ОДНОГО региона относительно его якоря (0,0) — пункт 1 запроса ("подсолнух" вместо дартборда).
 * Центр — В САМОМ якоре. Под-центры — на ближней орбите (сразу за диском центра), равномерно по углу.
 * Обычные ноды — спираль Фогеля: угол k-й ноды = k·золотой угол, радиус НАЧИНАЕТСЯ с радиуса ПРЕДЫДУЩЕЙ (по
 * порядку) обычной ноды и растёт шагом 1, пока расстояние до ВСЕХ уже поставленных нод (центр, под-центры, более
 * ранние обычные) не станет ≥ `minCenterDistance()` — простой поиск, не аналитическая формула, зато гарантированно
 * корректен для любых радиусов узлов (они не одинаковые, в отличие от старого дартборда). Порядок обычных нод —
 * `createdAt`, при равенстве `id` (стабильный тай-брейк, не должен случаться на практике — `createdAt` из `now()`
 * уникален с точностью до совпадения миллисекунды): НОВАЯ нода всегда встаёт ПОСЛЕДНЕЙ в этом порядке и появляется
 * с бо́льшим или равным радиусом, чем предыдущая, — уже поставленные никогда не сдвигаются.
 *
 * Центра нет (удалён/ещё не назначен) — якорь пустой, ПЕРВАЯ по порядку обычная нода садится прямо в него (та же
 * идея, что "первый узел региона — его центр" у органического роста, только здесь просто позиционно, без
 * присвоения самой роли — роль решает Ядро, не раскладка).
 */
export function layoutRegion(members, { centerId = null, subCenterIds = [] } = {}) {
    const positions = new Map();
    const radiusById = new Map(members.map(member => [member.id, nodeRadius(member)]));
    const subCenterSet = new Set(subCenterIds);

    const byCreationOrder = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id));
    const ordinary = members
        .filter(member => member.id !== centerId && !subCenterSet.has(member.id))
        .sort(byCreationOrder);

    let center = centerId != null ? members.find(member => member.id === centerId) : null;
    if (!center && ordinary.length) center = ordinary.shift(); // "якорь пустой — первая по порядку садится в него"
    if (center) positions.set(center.id, { x: 0, y: 0 });

    const placed = center ? [{ id: center.id, pos: { x: 0, y: 0 }, r: radiusById.get(center.id) }] : [];
    let maxRadius = center ? radiusById.get(center.id) : 0;

    const subCenters = members.filter(member => subCenterSet.has(member.id) && member.id !== center?.id);
    if (subCenters.length) {
        const centerR = center ? radiusById.get(center.id) : 0;
        const subR = Math.max(...subCenters.map(member => radiusById.get(member.id)));
        // РЕАЛЬНЫЙ БАГ (тот же класс, что уже поймала и исправила проверка спирали Фогеля ниже — округление позиции
        // ПОСЛЕ вычисления может УМЕНЬШИТЬ уже проверенную дистанцию до ~0.71px по диагонали): центр сидит РОВНО в
        // (0,0), не округляется, а позиция под-центра округляется до целого пикселя — при увеличении зазора (см.
        // GAP выше, найдено по жалобе "ноды слипаются") этот скрытый недобор впервые превысил допуск теста. `+1` —
        // запас, перекрывающий максимально возможную диагональную ошибку округления одной точки (√(0.5²+0.5²)≈0.71).
        const orbitRadius = minCenterDistance(centerR, subR) + 1; // "ближняя орбита" — минимально допустимый зазор от центра, с запасом на округление
        subCenters.forEach((member, index) => {
            const angle = (2 * Math.PI * index) / subCenters.length;
            const pos = { x: Math.round(Math.cos(angle) * orbitRadius), y: Math.round(Math.sin(angle) * orbitRadius) };
            positions.set(member.id, pos);
            placed.push({ id: member.id, pos, r: radiusById.get(member.id) });
        });
        maxRadius = Math.max(maxRadius, orbitRadius + subR);
    }

    let previousRadius = 0;
    ordinary.forEach((member, k) => {
        const angle = k * GOLDEN_ANGLE;
        const r = radiusById.get(member.id);
        let radius = previousRadius;
        // Поиск методом "растим радиус, пока не станет свободно" — не аналитика: радиусы узлов разные (в отличие
        // от старого дартборда с фиксированным 16/8px), формулы под РАЗНЫЕ пары радиусов писать не нужно.
        let pos;
        for (;;) {
            // Проверяем расстояние по УЖЕ ОКРУГЛЁННЫМ координатам — тем же самым, что реально сохранятся ниже
            // (`Math.round`, экранные позиции — целые пиксели). Проверка по НЕокруглённым x/y here давала зазор
            // впритык, который округление могло тут же съесть (до ~0.7px по диагонали) — живой баг, найденный
            // этим же тестом ("n4 and n12 are 25.50px apart, need >= 25.78").
            pos = { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
            const free = placed.every(other => {
                const dx = pos.x - other.pos.x;
                const dy = pos.y - other.pos.y;
                return Math.sqrt(dx * dx + dy * dy) >= minCenterDistance(r, other.r) - 1e-9;
            });
            if (free) break;
            radius += 1;
        }
        positions.set(member.id, pos);
        placed.push({ id: member.id, pos, r });
        previousRadius = radius;
        maxRadius = Math.max(maxRadius, radius + r);
    });

    return { positions, radius: maxRadius };
}

// --- 3.4 Зоны регионов -------------------------------------------------------

const NUMERIC_KEY = /^(\d+):(\d+)$/;

/** Стабильный порядок регионов — числовые "s:r" по (сектор, кольцо), потом семантические по алфавиту (план явно требует именно так, не порядок появления). */
function sortRegionKeys(keys) {
    return [...keys].sort((a, b) => {
        const ma = a.match(NUMERIC_KEY);
        const mb = b.match(NUMERIC_KEY);
        if (ma && mb) return Number(ma[1]) - Number(mb[1]) || Number(ma[2]) - Number(mb[2]);
        if (ma) return -1; // числовые регионы (дартборд) — перед семантическими, план не уточняет порядок между видами, это разумный дефолт
        if (mb) return 1;
        return a.localeCompare(b);
    });
}

/**
 * Размещает один диск (региона или накопителя) как кольцевой сектор ("зону") на угловом промежутке [a0,a1) —
 * общая логика для `layoutGraph()`'s регионов И отдельно для накопителя (тот же приём, другой вызов). Формула
 * `anchorRadius = max(innerHole + R, R / sin(половина угла))` — не просто "подальше от центра": при
 * `anchorRadius = R/sin(halfAngle)` диск радиуса `R`, центрированный на этом расстоянии, КАСАЕТСЯ обеих угловых
 * границ зоны изнутри — то есть ЛЮБАЯ точка внутри диска (radius ≤ R от анкера) гарантированно остаётся в угловом
 * промежутке зоны при взгляде из начала координат (стандартный факт геометрии касательной окружности), а по
 * радиусу это следует из простого неравенства треугольника. Вместе эти два факта — ровно то, что нужно тестам
 * Этапа 3.6 ("каждая нода лежит внутри своей зоны"), и они выполняются ТОЧНО, а не приближённо.
 *
 * НАЙДЕННЫЙ БАГ (не пойман тестами Этапа 3 — все их фикстуры брали 2+ региона; всплыл на однорегиональном графе,
 * например самом первом регионе до появления второго): формула `R/sin(halfAngle)` верна ТОЛЬКО для `halfAngle <=
 * π/2` — вывод касательной окружности предполагает острый угол между биссектрисой и лучом-границей. При
 * `halfAngle > π/2` (широкий клин — например единственный регион получает ПОЧТИ весь круг) `sin(halfAngle)` уже
 * УБЫВАЕТ обратно к нулю по мере роста угла к `π`, так что формула требует ВСЁ БОЛЬШЕГО расстояния для ВСЁ БОЛЕЕ
 * широкого клина — геометрически это назад: чем шире клин, тем МЕНЬШЕ (не больше) нужно отступать, а при `halfAngle
 * >= π/2` не нужно вообще ничего сверх `innerHole + R` (полуплоскость или шире уже вмещает диск при ЛЮБОМ `d >= R`
 * — угловое отклонение точки на границе диска, `arcsin(R/d)`, само по себе никогда не превышает `π/2`, так что
 * условие "уместиться в клин шире полуплоскости" выполняется автоматически). При `halfAngle → π` (единственный
 * регион на весь граф) необрезанная формула делила на `sin(halfAngle) → 0` и раздувала `anchorRadius` до
 * астрономических чисел (реально наблюдалось ~1.5e17 для тривиального однонодового графа). Исправление — зажимаем
 * УГОЛ ВНУТРИ `sin()` сверху `π/2` (не сам `halfAngle`, который остаётся настоящим для центрирования клина и
 * везде ниже) — для `halfAngle <= π/2` ничего не меняется (та же формула, что уже проверена Этапом 3.6's тестами),
 * для `halfAngle > π/2` даёт `R/sin(π/2) = R`, и внешний `max(innerHole+R, …)` корректно берёт `innerHole+R`.
 */
function placeZone({ id, label, a0, a1, layout, pad, innerHole, capacity, hue, count, nodesById, positions, radii, zones }) {
    const R = layout.radius + pad;
    const halfAngle = (a1 - a0) / 2;
    const tangentAngle = Math.min(halfAngle, Math.PI / 2);
    const anchorRadius = Math.max(innerHole + R, halfAngle > 0 ? R / Math.sin(tangentAngle) : innerHole + R);
    const centerAngle = (a0 + a1) / 2;
    const anchor = { x: Math.cos(centerAngle) * anchorRadius, y: Math.sin(centerAngle) * anchorRadius };
    for (const [nodeId, local] of layout.positions) {
        positions.set(nodeId, { x: anchor.x + local.x, y: anchor.y + local.y });
        radii.set(nodeId, nodeRadius(nodesById.get(nodeId) ?? {}));
    }
    zones.push({ regionId: id, label, a0, a1, rInner: Math.max(0, anchorRadius - R), rOuter: anchorRadius + R, anchor, count, capacity, hue });
    return zones[zones.length - 1];
}

/**
 * Регионы по кругу вокруг центра холста — пункт 7 запроса ("секторы как данные"). Каждый регион — кольцевой
 * сектор, угол пропорционален ПЛОЩАДИ его диска (`layoutRegion()`'s радиус + отступ `pad`), но не меньше
 * `minAngle` (совсем маленький регион всё равно виден и кликабелен). Накопитель (`regionId === null`) — ОТДЕЛЬНАЯ
 * зона южнее (угол вокруг `π/2`) круга регионов, тем же принципом `placeZone()`, но за пределами внешнего края
 * последнего кольца регионов (`innerHole` для неё — максимальный `rOuter` среди уже построенных зон, не исходный
 * параметр) — визуально отдельная область, не часть круга, тот же смысл, что у `stagedNodePosition()`
 * (legacy-geometry.js), выраженный в новой системе зон. Ей выделяется собственный угловой клин ФИКСИРОВАННОЙ
 * ширины `minAngle`, вычтенный из круга ДО распределения регионов — иначе регионы заняли бы весь круг целиком, не
 * оставив накопителю места, где не пересекаясь встать.
 */
export function layoutGraph(allNodes, regions, { innerHole = 60, pad = 12, minAngle = Math.PI / 15, capacity = 23 } = {}) {
    const nodesById = new Map(allNodes.map(node => [node.id, node]));
    const membersByRegion = new Map();
    const stagingMembers = [];
    for (const node of allNodes) {
        if (node.regionId == null) { stagingMembers.push(node); continue; }
        if (!membersByRegion.has(node.regionId)) membersByRegion.set(node.regionId, []);
        membersByRegion.get(node.regionId).push(node);
    }

    const regionKeys = sortRegionKeys(Object.keys(regions));
    const regionLayouts = regionKeys.map(key => {
        const region = regions[key];
        return { key, region, layout: layoutRegion(membersByRegion.get(key) ?? [], { centerId: region.centerNodeId, subCenterIds: region.subCenterIds ?? [] }) };
    });
    const stagingLayout = stagingMembers.length ? layoutRegion(stagingMembers, { centerId: null, subCenterIds: [] }) : null;

    const stagingAngle = stagingLayout ? minAngle : 0;
    const available = 2 * Math.PI - stagingAngle;
    const areas = regionLayouts.map(({ layout }) => { const r = layout.radius + pad; return Math.PI * r * r; });
    const totalArea = areas.reduce((sum, area) => sum + area, 0) || 1;
    let angles = regionKeys.length ? areas.map(area => Math.max(minAngle, (area / totalArea) * available)) : [];
    const totalAngle = angles.reduce((sum, angle) => sum + angle, 0) || 1;
    // Флоор `minAngle` мог раздуть сумму сверх `available` (много крошечных регионов) — перенормируем, чтобы
    // регионы + клин накопителя ВСЕГДА замыкали ровно полный круг, без наложений и без щелей.
    angles = angles.map(angle => (angle / totalAngle) * available);

    const positions = new Map();
    const radii = new Map();
    const zones = [];
    // Начинаем СВЕРХУ (тот же принцип, что у дартборда/семантических регионов в legacy-geometry.js), с отступом на
    // половину зарезервированного под накопитель клина — так итоговый клин накопителя ложится ТОЧНО на юг (см.
    // doc-comment у placeZone()'s геометрии касательной окружности, откуда и следует эта симметрия).
    let cursor = -Math.PI / 2 - available / 2;
    regionLayouts.forEach(({ key, region, layout }, index) => {
        const a0 = cursor;
        const a1 = cursor + angles[index];
        cursor = a1;
        placeZone({
            id: key, label: region.label ?? key, a0, a1, layout, pad, innerHole, capacity, hue: (360 * index) / regionLayouts.length,
            count: (membersByRegion.get(key) ?? []).length, nodesById, positions, radii, zones,
        });
    });

    if (stagingLayout) {
        const a0 = Math.PI / 2 - stagingAngle / 2;
        const a1 = Math.PI / 2 + stagingAngle / 2;
        const regionsOuter = zones.length ? Math.max(...zones.map(zone => zone.rOuter)) : innerHole;
        placeZone({
            id: null, label: 'Unplaced', a0, a1, layout: stagingLayout, pad, innerHole: regionsOuter, capacity: Infinity, hue: 0,
            count: stagingMembers.length, nodesById, positions, radii, zones,
        });
    }

    return { positions, radii, zones };
}

// --- 3.5 Попадание в зону -----------------------------------------------------

function normalizeAngle(angle) {
    const twoPi = 2 * Math.PI;
    return ((angle % twoPi) + twoPi) % twoPi;
}

/** Угол лежит в [a0,a1) — считая ОТ a0 вперёд по кругу, поэтому корректно работает даже если a1 численно вышел за ±π (зона перешла через "шов" atan2), без отдельного случая на переполнение. */
function angleInRange(angle, a0, a1) {
    const span = a1 - a0;
    const offset = normalizeAngle(angle - a0);
    return offset < span || Math.abs(offset - span) < 1e-9;
}

/** Зона под точкой модели (x,y) — полярные координаты (угол atan2, радиус от центра холста), первая зона, чей угловой промежуток и радиальное кольцо оба подходят. Зоны не пересекаются по углу (см. layoutGraph()), поэтому порядок перебора не важен. Нет зоны → `null`. */
export function zoneAt(x, y, zones) {
    const radius = Math.sqrt(x * x + y * y);
    const angle = Math.atan2(y, x);
    for (const zone of zones) {
        if (radius < zone.rInner || radius > zone.rOuter) continue;
        if (angleInRange(angle, zone.a0, zone.a1)) return zone;
    }
    return null;
}

/** SVG-путь кольцевого сектора зоны — для фона (Этап 4). Координаты — В МОДЕЛЬНОМ пространстве, центрированном на (0,0) (та же система, что `positions`/`zoneAt`), не в положительном SVG-viewBox — сдвиг в положительные координаты делает вызывающий (zones-svg.js), как и раньше у regionWedgePath()/renderRegionBackgroundSvg(). */
export function zonePath(zone) {
    const { a0, a1, rInner, rOuter } = zone;
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const pt = (r, a) => `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
    if (rInner <= 0.001) {
        return `M 0,0 L ${pt(rOuter, a0)} A ${rOuter.toFixed(2)} ${rOuter.toFixed(2)} 0 ${large} 1 ${pt(rOuter, a1)} Z`;
    }
    return `M ${pt(rInner, a0)} L ${pt(rOuter, a0)} A ${rOuter.toFixed(2)} ${rOuter.toFixed(2)} 0 ${large} 1 ${pt(rOuter, a1)} L ${pt(rInner, a1)} A ${rInner.toFixed(2)} ${rInner.toFixed(2)} 0 ${large} 0 ${pt(rInner, a0)} Z`;
}
