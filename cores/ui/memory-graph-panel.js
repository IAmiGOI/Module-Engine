import { h } from './tree.js';
import { signal, computed, effect } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { loadCytoscape } from '../../libraries/core/graph-rendering.js';
import {
    FloatingPanel, Card, Section, Button, TextInput, TextArea, NumberInput, Toggle,
    Details, Row, Field, EmptyState, Badge,
} from '../../libraries/shared/widgets.js';

/**
 * Визуальный редактор графа памяти — решено с пользователем явно:
 * "полноценный UI не хуже obsidian" + вызов любой функции вручную +
 * редактирование/создание/перемещение нод и связей (см. MEMORY_GRAPH.md).
 * Форма Ядра — точная копия `createUpdateOverlayCore`/`createNotificationsCore`:
 * отдельное `official`-Ядро, свой floating-корень через `uiEngine.mount()`,
 * НЕ секция общей панели настроек (решено с пользователем: окно, а не
 * узкая секция).
 *
 * Читает/пишет ТОЛЬКО через контракты `memoryGraph.*` (как `engine-panel.js`
 * читает Lorebook/Summary) — это Ядро UI не держит прямых ссылок на
 * `cores/memory-graph`.
 *
 * Канвас — Cytoscape.js (готовая CDN-библиотека, решено явно — не свой
 * force-движок с нуля). Позиция узла на экране = `sector`/`ring` РЕГИОНА
 * (не свободные x/y — решено с пользователем: "перетаскивание = смена
 * региона по-настоящему"), layout `preset` — координаты вычисляет сам
 * `regionLayoutPosition()`, не автоматический force-layout поверх (иначе
 * узлы визуально уедут из своей ячейки дартса и перестанут отражать
 * реальный регион).
 */

const MODULE_UI_NAMESPACE = 'core.ui.memoryGraph';
const WINDOW_KEY = 'window';
const CANVAS_ID = 'stme-memory-graph-canvas';
const BG_ID = 'stme-memory-graph-region-bg';
const BG_SVG_ID = 'stme-memory-graph-region-bg-svg';
const PREVIEW_ID = '__memory_graph_preview__';
const MAX_RADIUS = 480; // x2 от исходных 240 — узлы стали в 10 раз меньше визуально, ближний вид "слипался"

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

export function createMemoryGraphPanelCore(host, { mount } = {}) {
    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    // --- Окно: позиция/размер/свёрнутость/видимость — тот же паттерн, что
    // Tracker's HUD (modules/tracker/index.js's saveHudState()/loadHudState()).
    const panelVisible = signal(false);
    const panelCollapsed = signal(false);
    const panelPosition = signal({});
    const panelSize = signal({});

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY,
            value: { visible: panelVisible.peek(), collapsed: panelCollapsed.peek(), position: panelPosition.peek(), size: panelSize.peek() },
        });
    }

    async function loadWindowState() {
        const result = await call('storage.settings.get', { namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        panelVisible.set(Boolean(saved.visible));
        panelCollapsed.set(Boolean(saved.collapsed));
        panelSize.set(saved.size ?? {});
        panelPosition.set(saved.position?.left === undefined ? {} : clampToViewport(saved.position, {
            width: saved.size?.width ?? 720, height: saved.size?.height ?? 560,
            viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080,
        }));
    }

    // --- Состояние графа, зеркалируемое из контрактов -------------------
    const nodes = signal([]);
    const regions = signal([]);
    const mergeQueue = signal([]);
    const reconsolidationQueue = signal([]);
    const busy = signal(false);
    const statusText = signal('');

    async function refresh() {
        const [nodesResult, regionsResult, mergeResult, reconResult] = await Promise.all([
            call('memoryGraph.nodes'), call('memoryGraph.regions'), call('memoryGraph.mergeQueue'), call('memoryGraph.reconsolidationQueue'),
        ]);
        if (nodesResult.ok) nodes.set(nodesResult.value);
        if (regionsResult.ok) regions.set(regionsResult.value);
        if (mergeResult.ok) mergeQueue.set(mergeResult.value);
        if (reconResult.ok) reconsolidationQueue.set(reconResult.value);
    }

    // --- Выбор/создание -----------------------------------------------
    const selectedNodeId = signal(null);
    const creatingAt = signal(null); // {sector, ring} — задано кликом по канвасу в режиме создания
    const isCreating = signal(false);
    // Точка клика В ПИКСЕЛЯХ (не sector/ring) — только для видимого маркера
    // на канвасе. Найдено живьём: без него клик по канвасу давал только
    // мелкий текст в сайдбаре, далеко от места клика — "не появляется"/
    // "не нативно" (жалоба пользователя). Маркер даёт МГНОВЕННУЮ обратную
    // связь ровно там, где кликнули, даже если реальный узел ляжет в центр
    // региона, а не буквально в эту точку.
    const previewPosition = signal(null);

    const formLabel = signal('');
    const formContent = signal('');
    const formImportance = signal(0);
    const formProtected = signal(false);
    const debugText = signal('');

    function selectedNode() {
        return nodes().find(node => node.id === selectedNodeId());
    }

    function openEditForm(node) {
        selectedNodeId.set(node.id);
        isCreating.set(false);
        formLabel.set(node.label);
        formContent.set(node.content);
        formImportance.set(node.importance ?? 0);
        formProtected.set(Boolean(node.protectedNode));
    }

    function openCreateForm({ sector, ring }) {
        selectedNodeId.set(null);
        isCreating.set(true);
        creatingAt.set({ sector, ring });
        // Маркер появляется НЕМЕДЛЕННО, ещё до первого клика по канвасу —
        // подтверждает, что режим создания реально включился, а не только
        // сайдбар незаметно поменял текст.
        previewPosition.set(regionLayoutPosition(sector, ring, {}));
        formLabel.set('');
        formContent.set('');
        formImportance.set(0);
        formProtected.set(false);
    }

    function closeForm() {
        selectedNodeId.set(null);
        isCreating.set(false);
        creatingAt.set(null);
        previewPosition.set(null);
    }

    async function submitForm() {
        busy.set(true);
        try {
            if (isCreating()) {
                const at = creatingAt() ?? { sector: 0, ring: 0 };
                const result = await call('memoryGraph.nodes.create', {
                    label: formLabel(), content: formContent(), importance: formImportance() ?? 0, sector: at.sector, ring: at.ring,
                });
                statusText.set(result.ok ? 'Node created.' : `Failed: ${result.error?.message}`);
            } else if (selectedNodeId()) {
                const result = await call('memoryGraph.nodes.update', {
                    id: selectedNodeId(), label: formLabel(), content: formContent(), importance: formImportance() ?? 0, protectedNode: formProtected(),
                });
                statusText.set(result.ok ? 'Node updated.' : `Failed: ${result.error?.message}`);
            }
            await refresh();
            closeForm();
        } finally {
            busy.set(false);
        }
    }

    async function deleteSelected() {
        if (!selectedNodeId()) return;
        busy.set(true);
        try {
            await call('memoryGraph.nodes.delete', { id: selectedNodeId() });
            await refresh();
            closeForm();
        } finally {
            busy.set(false);
        }
    }

    async function moveNode(id, sector, ring) {
        busy.set(true);
        try {
            const result = await call('memoryGraph.nodes.move', { id, sector, ring });
            statusText.set(result.ok ? '' : `Move failed: ${result.error?.message}`);
            await refresh();
        } finally {
            busy.set(false);
        }
    }

    async function createEdge(fromId, toId) {
        busy.set(true);
        try {
            await call('memoryGraph.edges.create', { fromId, toId, type: 'mentions' });
            await refresh();
        } finally {
            busy.set(false);
        }
    }

    async function deleteEdge(fromId, toId, type) {
        busy.set(true);
        try {
            await call('memoryGraph.edges.delete', { fromId, toId, type });
            await refresh();
        } finally {
            busy.set(false);
        }
    }

    // --- "Вызов любой функции вручную" (решено с пользователем) ---------
    async function runDebugAction(contract, params) {
        busy.set(true);
        try {
            const result = await call(contract, params);
            statusText.set(result.ok ? `${contract}: ok` : `${contract}: ${result.error?.message}`);
            await refresh();
        } finally {
            busy.set(false);
        }
    }

    // --- Cytoscape: инициализация + синхронизация elements --------------
    let cy = null;

    function edgeElements() {
        const seen = new Set();
        const elements = [];
        for (const node of nodes()) {
            for (const edge of node.edges ?? []) {
                const key = [node.id, edge.to].sort().join('|') + ':' + edge.type;
                if (seen.has(key)) continue; // рёбра двусторонние в данных — одна визуальная линия на пару
                seen.add(key);
                elements.push({ data: { id: `edge:${key}`, source: node.id, target: edge.to, type: edge.type } });
            }
        }
        return elements;
    }

    function nodeElements() {
        const perRegion = new Map();
        for (const node of nodes()) {
            const key = node.regionId ?? 'staged';
            if (!perRegion.has(key)) perRegion.set(key, []);
            perRegion.get(key).push(node);
        }
        const elements = [];
        for (const [regionId, members] of perRegion) {
            members.forEach((node, index) => {
                let position = { x: 0, y: 0 };
                if (regionId !== 'staged') {
                    const [sector, ring] = regionId.split(':').map(Number);
                    position = regionLayoutPosition(sector, ring, { indexInRegion: index });
                }
                elements.push({
                    data: { id: node.id, label: node.label, degree: node.degree ?? 0, protectedNode: Boolean(node.protectedNode), importance: node.importance ?? 0 },
                    position,
                });
            });
        }
        return elements;
    }

    /**
     * Держит подложку регионов синхронной с ЖИВЫМ pan/zoom Cytoscape —
     * решено с пользователем: подложка считалась под один фиксированный
     * масштаб и "физически уезжала" при любом драге/скролле канваса.
     * Тот же расчёт экран=pan+модель*zoom, что использует сам Cytoscape.
     */
    function updateBackgroundTransform() {
        if (!cy) return;
        const svg = document.getElementById(BG_SVG_ID);
        if (!svg) return;
        const pan = cy.pan();
        const zoom = cy.zoom();
        svg.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    }

    async function ensureCytoscape() {
        if (cy) return cy;
        const container = document.getElementById(CANVAS_ID);
        if (!container) return null;
        // Фон региона — статичный SVG под канвасом, В МОДЕЛЬНЫХ единицах
        // (см. renderRegionBackgroundSvg()'s doc-comment) — рисуется ОДИН
        // раз здесь, не в syncCytoscape(): регионы (сектора/кольца) сами по
        // себе не меняются, перерисовывать разметку при каждом изменении
        // графа незачем, а её ЭКРАННОЕ положение держит
        // `updateBackgroundTransform()` через 'pan'/'zoom' ниже.
        const bg = document.getElementById(BG_ID);
        if (bg) bg.innerHTML = renderRegionBackgroundSvg();
        const cytoscape = await loadCytoscape();
        cy = cytoscape({
            container,
            elements: [...nodeElements(), ...edgeElements()],
            layout: { name: 'preset' },
            style: [
                // Подпись СКРЫТА по умолчанию — при таком размере ноды (2px)
                // текст на весь холст был нечитаемым нагромождением (жалоба
                // пользователя). Показывается только классом `.hovered`,
                // который вешает/снимает `mouseover`/`mouseout` ниже.
                // Цвет — по важности (решено с пользователем: "чем важнее,
                // тем зеленее, чем менее важна, тем краснее"), линейная
                // интерполяция по шкале 0..10.
                { selector: 'node', style: { 'background-color': 'mapData(importance, 0, 10, #e74c3c, #2ecc71)', color: '#fff', width: 2, height: 2 } },
                { selector: 'node.hovered', style: { label: 'data(label)', 'font-size': 0.9, 'text-valign': 'bottom', 'text-margin-y': 4 } },
                // Защищённые (центр/под-центр региона) — та же заливка по
                // важности, только БЕЛАЯ ОБВОДКА поверх отличает их роль,
                // не отдельный цвет заливки (иначе он бы спорил со шкалой
                // важности).
                { selector: 'node[?protectedNode]', style: { 'border-width': 2, 'border-color': '#fff' } },
                // Без подписи типа ребра — при реальном графе ("mentions"
                // почти на каждом ребре) текст сплошным нагромождением
                // покрывал весь холст (жалоба пользователя).
                { selector: 'edge', style: { width: 0.25, 'line-color': '#fff', 'curve-style': 'bezier' } },
                // Маркер места будущего узла в режиме создания — пунктир,
                // не сплошная заливка, чтобы не путать с настоящим узлом;
                // не кликабелен и не перетаскиваем (см. `grabbable`/`selectable` ниже).
                {
                    selector: `#${PREVIEW_ID}`,
                    style: {
                        label: 'data(label)', 'background-color': 'rgba(74,158,255,0.15)',
                        'border-width': 2, 'border-style': 'dashed', 'border-color': '#4a9eff',
                        color: '#4a9eff', 'font-size': 9, 'text-valign': 'bottom', 'text-margin-y': 4,
                        width: 2.4, height: 2.4,
                    },
                },
            ],
            wheelSensitivity: 0.2,
        });
        // Начальный кадр (auto-fit ещё не выставил pan/zoom за пределами
        // конструктора) + КАЖДОЕ последующее изменение — драг/скролл
        // канваса живьём шлёт эти события, syncCytoscape()'s `.layout(...).run()`
        // тоже (fit пересчитывает масштаб под новый набор нод).
        cy.on('pan zoom', updateBackgroundTransform);
        updateBackgroundTransform();
        cy.on('tap', 'node', event => {
            if (event.target.id() === PREVIEW_ID) return; // не настоящий узел — нечего редактировать
            openEditForm(nodes().find(node => node.id === event.target.id()));
        });
        // Имя показывается ТОЛЬКО под курсором (решено с пользователем —
        // при 61 ноде подписи разом занимали весь холст).
        cy.on('mouseover', 'node', event => event.target.addClass('hovered'));
        cy.on('mouseout', 'node', event => event.target.removeClass('hovered'));
        // Клик по ребру удаляет его СРАЗУ, без `confirm()` — тот же принцип,
        // что у Delete-кнопки узла и Remove у Lorebook в этом же движке:
        // нигде больше в проекте нет блокирующего нативного диалога.
        cy.on('tap', 'edge', event => {
            const data = event.target.data();
            deleteEdge(data.source, data.target, data.type);
        });
        // Клик по ПУСТОМУ месту канваса — если сейчас режим создания
        // (кнопка "+ Node" уже нажата), уточняет sector/ring по месту клика
        // (`event.position` — координаты модели, ТЕ ЖЕ, что раскладка узлов,
        // preset-layout не масштабирует их); иначе просто закрывает форму.
        cy.on('tap', event => {
            if (event.target !== cy) return;
            if (isCreating()) {
                creatingAt.set(pixelToRegion(event.position.x, event.position.y, {}));
                // Маркер садится РОВНО на клик (не на центр региона) — самая
                // прямая обратная связь. Куда реально ляжет узел (центр
                // региона) видно текстом рядом с формой, маркер здесь — про
                // "я тебя услышал", не про финальную позицию.
                previewPosition.set({ x: event.position.x, y: event.position.y });
            } else closeForm();
        });
        cy.on('dragfree', 'node', event => {
            const node = nodes().find(item => item.id === event.target.id());
            const pos = event.target.position();
            const target = pixelToRegion(pos.x, pos.y, {});
            if (!node || node.regionId === `${target.sector}:${target.ring}`) return;
            moveNode(node.id, target.sector, target.ring);
        });
        if (typeof cytoscape.use === 'function' && cy.edgehandles) {
            const eh = cy.edgehandles({});
            cy.on('ehcomplete', (event, sourceNode, targetNode) => createEdge(sourceNode.id(), targetNode.id()));
            host.__edgehandles = eh; // держим ссылку — иначе GC может собрать раньше времени в некоторых движках
        }
        return cy;
    }

    function syncCytoscape() {
        if (!cy) return;
        cy.elements().remove();
        const elements = [...nodeElements(), ...edgeElements()];
        if (isCreating() && previewPosition()) {
            elements.push({
                data: { id: PREVIEW_ID, label: formLabel() || 'New node' },
                position: previewPosition(),
                grabbable: false, selectable: false,
            });
        }
        cy.add(elements);
        // `fit: false` — зум/пан колесом мыши (если пользователь успел
        // покрутить) не должен сбрасываться на каждое изменение графа.
        // Подложка регионов остаётся синхронной в любом случае — её
        // экранное положение не хардкодится, а пересчитывается от ЖИВОГО
        // `cy.pan()`/`cy.zoom()` через 'pan'/'zoom' в ensureCytoscape().
        cy.layout({ name: 'preset', fit: false }).run();
    }

    // --- Главный персонаж: в LB или только в карточке? (решено с
    // пользователем явно: не автоматическая эвристика — явный выбор
    // пользователя в UI панели, доступный всегда, не только при первом
    // открытии). "Уже в LB" ничего не создаёт — обычный бутстрап и так
    // импортирует Lorebook целиком, выбор здесь только подтверждает, что
    // отдельная нода персонажа не нужна. "Только в карточке" — реальное
    // действие, `memoryGraph.nodes.createFromCharacterCard`. Повторный
    // клик не блокируется отдельно: почти идентичный повторный импорт
    // естественно поймает существующий merge-dedup механизм
    // (`detectMergeCandidate`), как и любой другой почти-дубликат —
    // отдельная защита от двойного клика не нужна.
    function characterOriginRow() {
        return Row(
            Button('Character already in Lorebook', () => statusText.set('Noted — no separate node created.')),
            Button('Only in character card — import', () => runDebugAction('memoryGraph.nodes.createFromCharacterCard')),
        );
    }

    // --- Дебаг-блок: 5 существующих оркестрационных операций (решено с пользователем) --
    function debugBlock() {
        return Details('Debug actions',
            Row(
                Field('Context text', TextInput(debugText, { placeholder: 'story context…' })),
                Button('checkAndPlace', () => runDebugAction('memoryGraph.checkAndPlace', { text: debugText() })),
            ),
            Row(
                Button('sweepStaging', () => runDebugAction('memoryGraph.sweepStaging')),
                Button('sweepMergeQueue', () => runDebugAction('memoryGraph.sweepMergeQueue')),
                Button('sweepReconsolidationQueue', () => runDebugAction('memoryGraph.sweepReconsolidationQueue')),
                Button('sweepBackbone', () => runDebugAction('memoryGraph.sweepBackbone')),
                Button('bootstrapFromLorebook', () => runDebugAction('memoryGraph.bootstrapFromLorebook')),
            ),
            computed(() => (mergeQueue().length ? Badge(`${mergeQueue().length} pending merge`, { tone: 'muted' }) : null)),
            computed(() => (reconsolidationQueue().length ? Badge(`${reconsolidationQueue().length} pending reconsolidation`, { tone: 'muted' }) : null)),
        );
    }

    function nodeForm() {
        return computed(() => {
            if (!isCreating() && !selectedNode()) return EmptyState('Click a node to edit it, or "+ Node" then click the canvas to place a new one.');
            return Section(isCreating() ? 'New node' : 'Edit node', { open: true },
                isCreating() ? h('p', { class: 'stme-memory-graph-hint' }, `Will be placed in region ${creatingAt()?.sector ?? 0}:${creatingAt()?.ring ?? 0} — click the canvas to change.`) : null,
                Field('Label', TextInput(formLabel)),
                Field('Content', TextArea(formContent, { rows: 4 })),
                Field('Importance', NumberInput(formImportance, { min: 0, max: 10, step: 1 })),
                isCreating() ? null : Row(Toggle('Protected', formProtected)),
                Row(
                    Button(isCreating() ? 'Create' : 'Save', submitForm, { disabled: busy() }),
                    isCreating() ? null : Button('Delete', deleteSelected, { variant: 'danger', disabled: busy() }),
                    Button('Cancel', closeForm),
                ),
            );
        });
    }

    function tree() {
        return h('div', { class: 'stme-memory-graph-panel-root' }, computed(() => (panelVisible() ? FloatingPanel(
            'Memory Graph',
            {
                position: panelPosition, size: panelSize, collapsed: panelCollapsed,
                onToggle: value => { panelCollapsed.set(value); saveWindowState(); },
                // Закрытие панели убирает #stme-memory-graph-canvas из
                // дерева (computed() выше возвращает null) — старый `cy`
                // остаётся живым объектом, но привязанным к уже удалённому
                // контейнеру. Без явного `destroy()` его `ensureCytoscape()`
                // при следующем открытии видел бы `cy` истинным и НЕ
                // пересоздавал инстанс для нового контейнера — граф
                // визуально пропадал до перезагрузки страницы (жалоба
                // пользователя: "если выйти из графа и зайти заново - он
                // пропадает").
                onClose: () => { panelVisible.set(false); saveWindowState(); if (cy) { cy.destroy(); cy = null; } },
                drag: createDragHandlers(panelPosition, { onDrop: dropped => { panelPosition.set(clampToViewport(dropped, { width: panelSize.peek().width ?? 720, height: panelSize.peek().height ?? 560, viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })); saveWindowState(); } }),
                onResize: next => { panelSize.set(next); saveWindowState(); },
            },
            h('div', { class: 'stme-memory-graph-body', style: { display: 'flex', gap: '8px', minWidth: '680px', minHeight: '480px' } },
                // Обёртка — position:relative, ДВА слоя внутри: фон региона
                // (SVG, рисуется напрямую в DOM, см. ensureCytoscape()) и
                // сам канвас Cytoscape поверх с прозрачным фоном, чтобы
                // подложка была видна сквозь него.
                h('div', { style: { position: 'relative', width: '480px', height: '480px', background: '#1a1a1a', borderRadius: '8px', flexShrink: '0', overflow: 'hidden' } },
                    h('div', { id: BG_ID, style: { position: 'absolute', inset: '0' } }),
                    h('div', { id: CANVAS_ID, style: { position: 'absolute', inset: '0', background: 'transparent' } }),
                ),
                h('div', { class: 'stme-memory-graph-sidebar', style: { flex: '1', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } },
                    Row(
                        Button('+ Node', () => openCreateForm({ sector: 0, ring: 0 })),
                        Button('Refresh', refresh),
                    ),
                    characterOriginRow(),
                    computed(() => (statusText() ? h('div', { class: 'stme-memory-graph-status' }, statusText()) : null)),
                    nodeForm(),
                    debugBlock(),
                ),
            ),
        ) : null)));
    }

    let refreshUnsubscribers = [];

    /**
     * Строит и монтирует дерево (тем же способом, что
     * `notifications`/`updateOverlay` — `mount()` не крепит корень к
     * странице сам, это делает вызывающий, `harness/engine-wiring.js`,
     * через `document.body.append(...)` ПОСЛЕ `settled()`). НЕ трогает
     * канвас/Cytoscape здесь — контейнер `#stme-memory-graph-canvas`
     * существует в дереве, только когда `panelVisible()` истинно, а сам
     * корень ещё не обязательно в живом документе на этом шаге — см.
     * `activate()`.
     */
    async function open() {
        await loadWindowState();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        await refresh();
        refreshUnsubscribers = [
            'memoryGraph.nodeCreated', 'memoryGraph.nodeUpdated', 'memoryGraph.nodeDeleted', 'memoryGraph.nodeMoved',
            'memoryGraph.nodeEvicted', 'memoryGraph.nodesMerged', 'memoryGraph.nodesReconsolidated', 'memoryGraph.bootstrapped',
            'memoryGraph.edgeCreated', 'memoryGraph.edgeDeleted',
        ].map(event => host.events.subscribe(event, () => refresh()));
        return finalUi;
    }

    /**
     * Ждёт появления канваса в ЖИВОМ документе, опрашивая `requestAnimationFrame`
     * до `maxAttempts` раз. Один-единственный rAF оказался недостаточен на
     * практике (живая проверка в харнессе: контейнер регулярно ещё не
     * успевал попасть в DOM к моменту первого кадра — не гарантия из
     * документации диффинга, а измеренное поведение) — опрос вместо
     * единичной попытки закрывает эту гонку, не полагаясь на точную
     * синхронность применения патча.
     */
    function waitForContainer(maxAttempts = 30) {
        return new Promise(resolve => {
            function attempt(remaining) {
                const container = document.getElementById(CANVAS_ID);
                if (container || remaining <= 0) { resolve(container); return; }
                requestAnimationFrame(() => attempt(remaining - 1));
            }
            attempt(maxAttempts);
        });
    }

    /**
     * Зовётся ВЫЗЫВАЮЩИМ ПОСЛЕ того, как корень реально добавлен в
     * `document.body` (тот же порядок, что у notifications/updateOverlay в
     * `harness/engine-wiring.js`) — только теперь `document.getElementById(CANVAS_ID)`
     * вообще МОЖЕТ что-то найти, если панель уже видима. Ленивая
     * инициализация Cytoscape по `panelVisible()`: контейнер существует в
     * дереве ТОЛЬКО когда панель открыта.
     */
    function activate() {
        effect(() => {
            if (!panelVisible() || cy) return;
            waitForContainer().then(container => { if (container) ensureCytoscape(); });
        });
        // `isCreating()`/`previewPosition()`/`formLabel()` — тоже читаются
        // здесь ЯВНО (не только внутри `syncCytoscape()`, где чтение тоже
        // подписало бы этот эффект, но не так наглядно): маркер должен
        // появляться/двигаться/переименовываться СРАЗУ, без ожидания
        // следующего изменения самого графа.
        effect(() => { nodes(); regions(); isCreating(); previewPosition(); formLabel(); syncCytoscape(); });
    }

    function show() {
        panelVisible.set(true);
        saveWindowState();
    }

    return {
        tree,
        open,
        activate,
        show,
        refresh,
        isVisible: () => panelVisible.peek(),
        stop: () => { for (const unsubscribe of refreshUnsubscribers.splice(0)) unsubscribe(); },
    };
}
