import { h } from './tree.js';
import { signal, computed, effect } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { loadCytoscape } from '../../libraries/core/graph-rendering.js';
import {
    FloatingPanel, Card, Section, Button, TextInput, TextArea, NumberInput, Toggle,
    Details, Row, Field, EmptyState, Badge, Slider, Select, ProgressBar, HoldButton,
} from '../../libraries/shared/widgets.js';
import { summarizeDecision } from '../memory-graph/decision-log.js';
// MEMORY_GRAPH_UI_PLAN.md, Этап 1 — геометрия и стили Cytoscape вынесены в отдельные файлы БЕЗ ИЗМЕНЕНИЯ
// ПОВЕДЕНИЯ (см. их doc-comment); реэкспортированы ниже (после констант окна) — существующие импорты (тестов, в
// частности) продолжают работать без правки.
import {
    BG_SVG_ID, MAX_RADIUS, packOffsetInRegion, regionLayoutPosition, pixelToRegion, regionWedgePath,
    renderRegionBackgroundSvg, backgroundTransformCss, SEMANTIC_MIN_ANCHOR_DISTANCE, SEMANTIC_MIN_POINT_DISTANCE,
    SEMANTIC_MAX_ANCHOR_DISTANCE, SEMANTIC_REGION_GAP, semanticAnchorRadius, fallbackSemanticPosition,
    STAGING_ANCHOR_DISTANCE, stagedNodePosition,
} from './memory-graph/legacy-geometry.js';
import { graphStylesheet, PREVIEW_ID } from './memory-graph/stylesheet.js';
export {
    MAX_RADIUS, packOffsetInRegion, regionLayoutPosition, pixelToRegion, regionWedgePath, renderRegionBackgroundSvg,
    SEMANTIC_MAX_ANCHOR_DISTANCE, SEMANTIC_REGION_GAP, semanticAnchorRadius, fallbackSemanticPosition,
    STAGING_ANCHOR_DISTANCE, stagedNodePosition, backgroundTransformCss,
} from './memory-graph/legacy-geometry.js';

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
    const staging = signal([]);
    // Журнал решений (MEMORY_GRAPH_FIX_PLAN.md, Этап 6, ROADMAP 5.107е) — уже отсортирован Ядром новейшими первыми
    // (`memoryGraph.decisionLog`), панели остаётся только отрезать хвост под показ (см. whyBlock() ниже).
    const decisionLog = signal([]);
    const busy = signal(false);
    const statusText = signal('');

    async function refresh() {
        const [nodesResult, regionsResult, mergeResult, reconResult, stagingResult, decisionLogResult] = await Promise.all([
            call('memoryGraph.nodes'), call('memoryGraph.regions'), call('memoryGraph.mergeQueue'), call('memoryGraph.reconsolidationQueue'), call('memoryGraph.staging'), call('memoryGraph.decisionLog'),
        ]);
        if (nodesResult.ok) nodes.set(nodesResult.value);
        if (regionsResult.ok) regions.set(regionsResult.value);
        if (mergeResult.ok) mergeQueue.set(mergeResult.value);
        if (reconResult.ok) reconsolidationQueue.set(reconResult.value);
        if (stagingResult.ok) staging.set(stagingResult.value);
        if (decisionLogResult.ok) decisionLog.set(decisionLogResult.value);
    }

    // --- Прогресс бутстрапа (реальная жалоба пользователя: "невозможно в
    // реальном времени понять процесс построения графа из-за подвисания") —
    // Ядро уже публикует `memoryGraph.bootstrapStarted/Progress/Finished`
    // (тот же механизм, что раньше был виден ТОЛЬКО в отдельной панели
    // движка — cores/ui/engine-panel.js — а не здесь, в самом окне графа,
    // где пользователь реально нажимает кнопку и смотрит на канвас). `phase`
    // приходит с бэкенда словами технических шагов — тот же словарь, что и
    // у engine-panel.js's `memoryGraphProgressPhaseLabel()`, продублирован
    // намеренно, не импортирован оттуда: Ядра/UI-Ядра друг друга напрямую
    // не знают (тот же принцип, что уже применён к BOOTSTRAP_REASONING_EFFORTS
    // в cores/memory-graph/index.js).
    const bootstrapProgress = signal(null); // {done, total, phase} | null
    const bootstrapRunning = signal(false);

    function bootstrapPhaseLabel(phase) {
        switch (phase) {
            case 'reading': return 'reading Lorebook';
            case 'skeleton': return 'laying out regions';
            case 'centers': return 'adding region centers';
            case 'placing': return 'placing entries';
            case 'linking': return 'linking regions';
            case 'connecting': return 'connecting isolated entries';
            case 'finalizing': return 'finalizing';
            default: return 'building';
        }
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

    /**
     * Бутстрап — НЕ через `runDebugAction()`/общий `busy` (реальная жалоба:
     * "невозможно... подвисания" + "нужен... отдельный процесс, чтобы не
     * висло"). `bootstrapFromLorebook()` реально может идти минутами на
     * большом Lorebook (эмбединг каждой записи + несколько LLM-вызовов) —
     * блокировать ВЕСЬ остальной редактор графа (создание/правку узлов,
     * дебаг-кнопки) на всё это время общим флагом было бы неоправданно,
     * когда своя, точная обратная связь уже есть через
     * `bootstrapProgress`/`bootstrapRunning` (см. подписки в `open()`).
     * Клик НЕ ждёт результата сам — событийная лента уже показывает ход
     * вживую, а собственная кнопка блокируется своим состоянием
     * (`bootstrapRunning`), не общим `busy`. Реальный баг, найденный по
     * жалобе "после первого этапа bootstrap не идут следующие": этот
     * `.then()` раньше САМ писал generic "Lorebook is empty" на ЛЮБОЙ
     * `result.value === false` — включая случай, когда Проход 1/2 реально
     * СЛОМАЛСЯ (пустой Lorebook там ни при чём), и эта неверная фраза
     * побеждала гонку с куда более точным сообщением из
     * `memoryGraph.bootstrapFinished` ниже (тот приходит РАНЬШЕ — событие
     * летит из `finally` самого Ядра, до того как промис успевает
     * резолвиться сюда). Единственная забота этого колбэка теперь —
     * отказ на уровне самого КОНТРАКТА (Гейт/сеть); что случилось ВНУТРИ
     * успешно завершившегося прогона — целиком за событием ниже.
     */
    function runBootstrap({ includeCard = false } = {}) {
        call('memoryGraph.bootstrapFromLorebook', { includeCard }).then(result => {
            if (!result.ok) statusText.set(`Generation failed: ${result.error?.message}`);
        });
    }

    /** Остановить построение — уже построенное остаётся (Ядро сохраняет его по ходу дела). */
    async function abortBootstrap() {
        statusText.set('Stopping…');
        await call('memoryGraph.bootstrapAbort');
    }

    /**
     * Полное удаление графа — реальная жалоба пользователя: "граф нельзя
     * удалить". Гейт подтверждения — `HoldButton` (прямой запрос: "кнопку,
     * которую нужно держать, с анимацией заполнения"), не `window.confirm()`
     * — единообразно с остальным проектом (MEMORY_GRAPH.md уже убирал
     * ровно такой диалог из этой же панели). Закрывает открытую форму и
     * снимает выбор узла — оба всё равно ссылались бы на только что
     * удалённые данные.
     */
    async function deleteGraph() {
        busy.set(true);
        try {
            const result = await call('memoryGraph.reset');
            statusText.set(result.ok ? 'Graph deleted.' : `Delete failed: ${result.error?.message}`);
            closeForm();
            await refresh();
        } finally {
            busy.set(false);
        }
    }

    // --- Настройка извлечения -------------------------------------------
    // Лимит узлов, собираемых ШУМОМ при извлечении: маяки + маршрут + шум
    // ВМЕСТЕ не должны превысить это число (`retrievalTargetNodes`,
    // DEFAULT_SETTINGS: 20). Ползунок пишется сразу при отпускании — не
    // нужен отдельный Save: `memoryGraph.configure` клэмпит и сохраняет сам.
    const retrievalTargetNodes = signal(24);
    const bootstrapChunkTokens = signal(10000);
    const retrievalBusy = signal(false);
    // Sticky balance (решено с пользователем явно) — три готовые точки, не
    // откручиваемое число (см. RETRIEVAL_STABILITY_LEVELS/_MARGINS в
    // cores/memory-graph/index.js за самой математикой).
    const retrievalStability = signal('balanced');
    const RETRIEVAL_STABILITY_OPTIONS = Object.freeze([
        { value: 'often', label: 'Often — swap readily' },
        { value: 'balanced', label: 'Balanced' },
        { value: 'sticky', label: 'Sticky — hold the block' },
    ]);

    async function loadRetrievalSettings() {
        const result = await call('memoryGraph.settings');
        if (result.ok && result.value?.retrievalTargetNodes != null) retrievalTargetNodes.set(result.value.retrievalTargetNodes);
        if (result.ok && result.value?.bootstrapChunkTokens != null) bootstrapChunkTokens.set(result.value.bootstrapChunkTokens);
        if (result.ok && result.value?.retrievalStability) {
            retrievalStability.set(result.value.retrievalStability);
            stabilityIndex.set(Math.max(0, RETRIEVAL_STABILITY_OPTIONS.findIndex(option => option.value === result.value.retrievalStability)));
        }
        if (result.ok && Array.isArray(result.value?.fallbackWorkerIds)) fallbackWorkerIds.set(result.value.fallbackWorkerIds);
    }

    // Настройки пишутся САМИ через 0,4 с после последнего движения ползунка (отдельных «Save» нет): Ядро клэмпит значения и сохраняет.
    async function saveSetting(patch) {
        const result = await call('memoryGraph.configure', patch);
        if (!result.ok) statusText.set(`Could not save: ${result.error?.message}`);
    }

    const stabilityIndex = signal(1);
    const autosaveDisposers = [];
    function bindAutosave(source, toPatch) {
        let first = true;
        let timer = null;
        autosaveDisposers.push(effect(() => {
            const value = source();
            if (first) { first = false; return; }   // первый прогон эффекта — это просто чтение, не изменение
            clearTimeout(timer);
            timer = setTimeout(() => saveSetting(toPatch(value)), 400);
        }));
    }

    /**
     * Резервные воркеры для звонков SideCar Графа (`fallbackWorkerIds`,
     * cores/memory-graph/index.js). Прямой запрос пользователя: "сделай
     * несколько уровней fallback, перед настоящей отменой" — сам механизм
     * (несколько тиров, каждый следующий воркер пробуется, только если
     * предыдущий реально отказал) уже был у движка с ROADMAP 5.33/5.37, но
     * НАСТРОИТЬ его было нечем — контракт принимал список, а окно графа
     * ни разу не давало его заполнить. Список воркеров и порядок в нём —
     * стабильный порядок `model.workers.get()` (тот же источник, что и
     * «Worker» у Chat Summary в основной панели, `cores/ui/engine-panel.js`),
     * а не порядок кликов — тянуть drag-переупорядочивание ради того же
     * результата было бы лишней сложностью без ясной пользы: тиры и так
     * пробуются один за другим по списку.
     */
    const availableWorkerIds = signal([]);
    const fallbackWorkerIds = signal([]);
    const fallbackBusy = signal(false);

    async function loadWorkerIds() {
        const result = await call('model.workers.get');
        availableWorkerIds.set(result.ok ? (result.value ?? []).map(worker => worker.id) : []);
    }

    async function toggleFallbackWorker(id, checked) {
        const selected = new Set(fallbackWorkerIds.peek());
        if (checked) selected.add(id); else selected.delete(id);
        const next = availableWorkerIds.peek().filter(workerId => selected.has(workerId));
        fallbackBusy.set(true);
        try {
            const result = await call('memoryGraph.configure', { fallbackWorkerIds: next });
            if (result.ok) fallbackWorkerIds.set(result.value.fallbackWorkerIds);
            statusText.set(result.ok ? 'Fallback workers saved.' : `Failed: ${result.error?.message}`);
        } finally {
            fallbackBusy.set(false);
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
        // Отсортировано — тот же список семантических регионов даёт тот же
        // угол при каждой перерисовке (иначе порядок Map's insertion, который
        // зависит от порядка ПРИХОДА нод, мог бы тасовать углы регионов
        // между собой на каждый refresh()).
        const semanticRegionIds = [...perRegion.keys()].filter(key => key !== 'staged' && !/^\d+:\d+$/.test(key)).sort();
        const elements = [];
        for (const [regionId, members] of perRegion) {
            members.forEach((node, index) => {
                const position = regionId === 'staged'
                    ? stagedNodePosition(index)
                    : (/^\d+:\d+$/.test(regionId)
                        ? regionLayoutPosition(...regionId.split(':').map(Number), { indexInRegion: index })
                        : fallbackSemanticPosition(regionId, index, semanticRegionIds));
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
        svg.style.transform = backgroundTransformCss(cy.pan(), cy.zoom());
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
            // MEMORY_GRAPH_UI_PLAN.md, Этап 1 — сам массив стилей вынесен в graphStylesheet() (stylesheet.js) БЕЗ
            // ИЗМЕНЕНИЯ ПОВЕДЕНИЯ, см. его doc-comment.
            style: graphStylesheet(),
            wheelSensitivity: 0.2,
        });
        // Начальный кадр (auto-fit ещё не выставил pan/zoom за пределами
        // конструктора) + КАЖДОЕ последующее изменение — драг/скролл
        // канваса живьём шлёт эти события, syncCytoscape()'s `.layout(...).run()`
        // тоже (fit пересчитывает масштаб под новый набор нод).
        // Начальный вид — ВЕСЬ дартборд по центру канваса: модельные координаты центрированы на (0, 0), а у Cytoscape по умолчанию pan = (0, 0)
        // и zoom = 1, то есть (0, 0) лежал в ЛЕВОМ ВЕРХНЕМ углу холста и была видна только правая нижняя четверть графа.
        const width = container.clientWidth || 480;
        const height = container.clientHeight || 480;
        cy.viewport({ zoom: Math.min(width, height) / (2 * MAX_RADIUS), pan: { x: width / 2, y: height / 2 } });
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

    // --- Компактные зоны боковой панели ------------------------------------------------------------------

    /** Ползунок с подписью значения (для 3 положений баланса выводится название, а не число). Занимает свою долю строки. */
    function LabeledSlider(label, valueSignal, { min, max, step = 1, format = value => String(value) } = {}) {
        return h('label', { class: 'stme-slider stme-mg-slider' },
            h('span', { class: 'stme-slider-head' }, h('span', {}, label), h('output', {}, computed(() => format(valueSignal())))),
            h('input', { type: 'range', min, max, step, value: valueSignal, 'on:input': event => valueSignal.set(Number(event.target.value)) }),
        );
    }

    /** Строка построения: две кнопки и размер чанка рядом (как строка управления в модуле Music — без заголовков и рамок). */
    function generationRow() {
        return Row(
            Button(computed(() => (bootstrapRunning() ? 'Building…' : 'Generate + character card')), () => runBootstrap({ includeCard: true }), { disabled: bootstrapRunning }),
            Button('Generate (Lorebook only)', () => runBootstrap({ includeCard: false }), { disabled: bootstrapRunning }),
            LabeledSlider('Chunk size', bootstrapChunkTokens, { min: 6000, max: 50000, step: 1000, format: value => `${Math.round(value / 1000)}k tokens` }),
        );
    }

    /** Одна строка: подсказка (в покое) или прогресс с кнопкой остановки (при построении). Всё, что построено, Ядро сохраняет по ходу дела. */
    function progressRow() {
        return computed(() => {
            const progress = bootstrapProgress();
            if (!progress) return h('small', { class: 'stme-module-hint' }, 'Saved automatically while the graph is built.');
            const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
            const label = progress.detail ? `${bootstrapPhaseLabel(progress.phase)} — ${progress.detail}` : bootstrapPhaseLabel(progress.phase);
            return h('div', { class: 'stme-mg-progress-row' }, ProgressBar(percent, `${label}… ${percent}%`), Button('Stop', abortBootstrap, { variant: 'danger' }));
        });
    }

    /** Строка извлечения: сколько нод собирается в промпт и насколько цепко держится набор (три положения) — два ползунка рядом. */
    function retrievalRow() {
        return Row(
            LabeledSlider('Nodes per retrieval', retrievalTargetNodes, { min: 10, max: 50, step: 1 }),
            LabeledSlider('Balance', stabilityIndex, { min: 0, max: RETRIEVAL_STABILITY_OPTIONS.length - 1, step: 1, format: value => RETRIEVAL_STABILITY_OPTIONS[value]?.label ?? '' }),
        );
    }

    /** Низ панели — две кнопки: обновить картинку графа и удалить граф целиком (удержанием). */
    function footerRow() {
        return Row(
            Button('Refresh', refresh),
            HoldButton('Hold to delete graph', deleteGraph, { holdMs: 1200, variant: 'danger', disabled: busy() }),
        );
    }

    // --- Дебаг-блок: оставшиеся оркестрационные операции (решено с
    // пользователем; bootstrap вынесен из этого блока в свою секцию выше —
    // это штатная операция, а не дебаг) --
    function debugBlock() {
        return Details('Debug actions',
            h('p', { class: 'stme-memory-graph-hint' }, 'Everything here already runs automatically during play, on its own schedule. These buttons just force a step right now — useful to test a change or unstick something, never required for the graph to keep working.'),
            Row(
                Field('Context text', TextInput(debugText, { placeholder: 'story context…' })),
                Button('Check this text now', () => runDebugAction('memoryGraph.checkAndPlace', { text: debugText() })),
            ),
            h('p', { class: 'stme-memory-graph-hint' }, 'Runs the same "is this worth remembering?" check the engine runs after every reply — against the text typed above instead of the real chat.'),
            Row(
                Button('Retry stuck entries', () => runDebugAction('memoryGraph.sweepStaging')),
                Button('Resolve near-duplicates', () => runDebugAction('memoryGraph.sweepMergeQueue')),
                Button('Compress weak clusters', () => runDebugAction('memoryGraph.sweepReconsolidationQueue')),
                Button('Rebuild backbone links', () => runDebugAction('memoryGraph.sweepBackbone')),
            ),
            h('p', { class: 'stme-memory-graph-hint' },
                '"Retry stuck entries" (sweepStaging) — nodes with no confident region yet, see "awaiting placement" below. ' +
                '"Resolve near-duplicates" (sweepMergeQueue) — pairs flagged as likely duplicates, see "pending merge" below. ' +
                '"Compress weak clusters" (sweepReconsolidationQueue) — low-priority nodes queued to be folded into one, see "pending reconsolidation" below. ' +
                '"Rebuild backbone links" (sweepBackbone) — connects region centers to each other; only used during Lorebook import, not during normal play.'),
            computed(() => (mergeQueue().length ? Badge(`${mergeQueue().length} pending merge`, { tone: 'muted' }) : null)),
            computed(() => (reconsolidationQueue().length ? Badge(`${reconsolidationQueue().length} pending reconsolidation`, { tone: 'muted' }) : null)),
            computed(() => (staging().length ? Badge(`${staging().length} awaiting placement`, { tone: 'muted' }) : null)),
        );
    }

    /**
     * Секция «Why» (MEMORY_GRAPH_FIX_PLAN.md, Этап 6, ROADMAP 5.107е) — без неё калибровать пороги гейта
     * (`thresholdK`/`gateWindow`) и размещения (`placementMinSimilarity`/`placementMinMargin`) можно было только
     * вслепую: ни разработчик, ни пользователь не видел, ПОЧЕМУ конкретный ход не дал ноды. Последние 20 записей —
     * тот же журнал, что и в `decisionLog` сигнале выше, отрезанный под показ; `summarizeDecision()` (decision-log.js)
     * делает саму строку.
     */
    function whyBlock() {
        return Details('Why (recent decisions)',
            h('p', { class: 'stme-memory-graph-hint' },
                'What the gate and the model decided on each recent check — newest first. Use this to see whether a fact you expected actually got captured, and why not if it didn\'t.'),
            computed(() => (decisionLog().length
                ? h('div', { class: 'stme-mg-decision-log' }, decisionLog().slice(0, 20).map(entry => h('div', { class: 'stme-mg-decision-row' }, summarizeDecision(entry))))
                : h('small', { class: 'stme-module-hint' }, 'No checks recorded yet.'))),
        );
    }

    function nodeForm() {
        return computed(() => {
            if (!selectedNode()) return h('small', { class: 'stme-module-hint' }, 'Click a node on the graph to edit it.');
            return h('div', { class: 'stme-mg-node' },
                Row(Field('Label', TextInput(formLabel)), Field('Importance', NumberInput(formImportance, { min: 0, max: 10, step: 1 }))),
                Field('Content', TextArea(formContent, { rows: 3 })),
                Row(
                    Toggle('Protected', formProtected),
                    Button('Save', submitForm, { disabled: busy() }),
                    Button('Delete', deleteSelected, { variant: 'danger', disabled: busy() }),
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
                // Обёртка — колонка: канвас + легенда под ним, тем же
                // приёмом, что hint-параграфы у остальных секций (реальная
                // жалоба: "очень плохой UI... ноль объяснений" — сам канвас
                // до этого не объяснял НИ ОДНОГО своего взаимодействия:
                // клик, драг узла, драг рёбер-хендла).
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', flexShrink: '0' } },
                    // position:relative, ДВА слоя внутри: фон региона (SVG,
                    // рисуется напрямую в DOM, см. ensureCytoscape()) и сам
                    // канвас Cytoscape поверх с прозрачным фоном, чтобы
                    // подложка была видна сквозь него.
                    h('div', { style: { position: 'relative', width: '480px', height: '480px', background: '#1a1a1a', borderRadius: '8px', overflow: 'hidden' } },
                        h('div', { id: BG_ID, style: { position: 'absolute', inset: '0' } }),
                        h('div', { id: CANVAS_ID, style: { position: 'absolute', inset: '0', background: 'transparent' } }),
                    ),
                    h('p', { class: 'stme-memory-graph-hint', style: { width: '480px', boxSizing: 'border-box' } },
                        'Click a node to edit it. Drag a node onto a different dartboard cell to move it into that region. Drag from a node\'s edge handle to another node to connect them.'),
                ),
                h('div', { class: 'stme-memory-graph-sidebar stme-module-body stme-mg-flat' },
                    generationRow(),
                    progressRow(),
                    retrievalRow(),
                    computed(() => (statusText() ? h('div', { class: 'stme-memory-graph-status' }, statusText()) : null)),
                    nodeForm(),
                    footerRow(),
                    debugBlock(),
                    whyBlock(),
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
        await loadRetrievalSettings();
        bindAutosave(retrievalTargetNodes, value => ({ retrievalTargetNodes: Number(value) }));
        bindAutosave(bootstrapChunkTokens, value => ({ bootstrapChunkTokens: Number(value) }));
        bindAutosave(stabilityIndex, value => ({ retrievalStability: RETRIEVAL_STABILITY_OPTIONS[value]?.value ?? 'balanced' }));
        const finalUi = mount(tree());
        await finalUi.settled?.();
        await refresh();
        refreshUnsubscribers = [
            ...[
                'memoryGraph.nodeCreated', 'memoryGraph.nodeUpdated', 'memoryGraph.nodeDeleted', 'memoryGraph.nodeMoved',
                'memoryGraph.nodeEvicted', 'memoryGraph.nodesMerged', 'memoryGraph.nodesReconsolidated', 'memoryGraph.bootstrapped',
                'memoryGraph.edgeCreated', 'memoryGraph.edgeDeleted', 'memoryGraph.reset',
                // Сменили чат: Ядро загрузило граф нового чата — перерисовываем (и сбрасываем выбранную ноду прежнего графа).
                'memoryGraph.loaded',
            ].map(event => host.events.subscribe(event, () => { if (event === 'memoryGraph.loaded') closeForm(); refresh(); })),
            // Бутстрап-прогресс — та же тройка событий, тем же смыслом, что
            // уже подписан cores/ui/engine-panel.js: `started` подтверждает,
            // что работа реально НАЧАЛАСЬ (может идти десятки секунд/минуты
            // на большом Lorebook), `progress` тикает по ходу, `finished`
            // гасит индикатор БЕЗУСЛОВНО — и на успехе, и на любом раннем
            // отказе, иначе полоса зависла бы навсегда. `bootstrapRunning`
            // — отдельный от `busy` сигнал (см. `runBootstrap()`'s doc-comment
            // за причиной), поэтому ставится здесь, по факту события, а не
            // по факту того, что чей-то клик всё ещё ждёт свой промис.
            host.events.subscribe('memoryGraph.bootstrapStarted', payload => {
                bootstrapRunning.set(true);
                bootstrapProgress.set({ done: 0, total: Math.max(1, payload?.totalSteps ?? 1), phase: 'reading' });
            }),
            host.events.subscribe('memoryGraph.bootstrapProgress', payload => {
                bootstrapRunning.set(true); // подстраховка на случай, если `started` пришёл ДО открытия этого окна
                bootstrapProgress.set({ done: payload?.done ?? 0, total: Math.max(1, payload?.total ?? 1), phase: payload?.phase ?? '', detail: payload?.detail ?? null });
                // Реальная жалоба: "канвас графа обновляется редко и не очень
                // ясно, что происходит" — бутстрап мутирует `nodes`/`regions`
                // НАПРЯМУЮ по ходу дела (не по одной ноде через
                // `nodeCreated` — это был бы спам событий на сотни записей),
                // так что без этого канвас просто стоял бы статичным до
                // самого конца, а потом резко показывал всё разом.
                // `refresh()` — 5 дешёвых локальных чтений, не сеть и не
                // эмбединг — звать его на каждый тик безопасно.
                refresh();
            }),
            host.events.subscribe('memoryGraph.bootstrapFinished', payload => {
                bootstrapRunning.set(false);
                bootstrapProgress.set(null);
                // `reason` — новое поле Ядра (жалоба: "после первого этапа
                // не идут следующие... только один запрос к SideCar"):
                // раньше отказ на середине каскада (Проход 1/2 звонок упал,
                // ИЛИ ответ разобрался в пустой список) был неотличим от
                // "нечего импортировать" — оба давали один и тот же немой
                // "ничего не построено". Теперь Ядро само знает и сообщает,
                // на чём именно остановилось.
                statusText.set(payload?.success
                    ? `Bootstrap complete — ${payload?.nodeCount ?? nodes().length} nodes.`
                    : `Bootstrap stopped: ${payload?.reason ?? 'nothing to import — Lorebook is empty, unreadable, or already imported'}.`);
            }),
        ];
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
            // Открыли окно — граф обновляется сам (раньше показывал то, что успело накопиться до открытия, до нажатия Refresh).
            waitForContainer().then(async container => { if (container) { await ensureCytoscape(); refresh(); } });
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
        refresh();
    }

    /** Спрятать окно — та же запись состояния, что и у крестика FloatingPanel (onClose выше): кнопка дока и крестик ведут себя одинаково. */
    function hide() {
        panelVisible.set(false);
        saveWindowState();
        if (cy) { cy.destroy(); cy = null; }
    }

    return {
        tree,
        open,
        activate,
        show,
        hide,
        refresh,
        isVisible: () => panelVisible.peek(),
        stop: () => { for (const unsubscribe of refreshUnsubscribers.splice(0)) unsubscribe(); for (const dispose of autosaveDisposers.splice(0)) dispose?.(); },
    };
}
