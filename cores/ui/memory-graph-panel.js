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
// Из всего набора legacy-geometry.js локально ЕЩЁ используются только эти три (создание превью-маркера и
// интерпретация клика/драга, см. doc-comment ниже) — остальные имена реэкспортируются (следующий блок) ради
// тестов (`tests/memory-graph-panel.test.js` берёт их из ЭТОГО файла, не из legacy-geometry.js напрямую), но
// собственный код панели их больше не зовёт: `export {…} from '…'` не требует отдельного локального `import`.
import { regionLayoutPosition, pixelToRegion, backgroundTransformCss } from './memory-graph/legacy-geometry.js';
import { graphStylesheet, PREVIEW_ID } from './memory-graph/stylesheet.js';
export {
    MAX_RADIUS, packOffsetInRegion, regionLayoutPosition, pixelToRegion, regionWedgePath, renderRegionBackgroundSvg,
    SEMANTIC_MAX_ANCHOR_DISTANCE, SEMANTIC_REGION_GAP, semanticAnchorRadius, fallbackSemanticPosition,
    STAGING_ANCHOR_DISTANCE, stagedNodePosition, backgroundTransformCss,
} from './memory-graph/legacy-geometry.js';
// MEMORY_GRAPH_UI_PLAN.md, Этап 4 — раскладка/фон/синхронизация переключены на зоны (layout.js/zones-svg.js) и
// диффинг (elements-diff.js) вместо дартборда (legacy-geometry.js, реэкспорт выше остаётся — план запрещает
// удалять код с тестами) и полной пересборки `cy.elements().remove()`. `pixelToRegion()`/`regionLayoutPosition()`/
// `fallbackSemanticPosition()`/`stagedNodePosition()` из реэкспорта выше по-прежнему используются ниже, но ТОЛЬКО
// для интерпретации клика/драга (Б3-геометрия, привязанная к дартборду) — Этап 7 того же плана заменит их на
// `zoneAt()` (layout.js); до тех пор клик/драг по канвасу решают регион по СТАРОЙ дартборд-сетке, а сам фон и
// позиции нод уже рисуются по НОВЫМ зонам — известное временное расхождение, см. ROADMAP 5.108г.
import { layoutGraph, nodeRadius, zoneAt } from './memory-graph/layout.js';
import { diffElements } from './memory-graph/elements-diff.js';
import { dropDecision, connectModeStep, edgeTypesInGraph } from './memory-graph/interactions.js';
import { renderZonesSvg, zonesSignature, ZONES_SVG_ID } from './memory-graph/zones-svg.js';
import { retrievalClasses, routeChainLabels } from './memory-graph/retrieval-overlay.js';
import { METRICS, findMetric, metricColor, metricDomain } from './memory-graph/metrics.js';

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
 * force-движок с нуля). Позиция узла на экране = его РЕГИОН (не свободные
 * x/y — решено с пользователем: "перетаскивание = смена региона
 * по-настоящему"), layout `preset` — координаты вычисляет `layoutGraph()`
 * (MEMORY_GRAPH_UI_PLAN.md, Этап 3/4: зоны-кольца регионов, не сетка
 * дартборда), не автоматический force-layout поверх (иначе узлы визуально
 * уедут из своей зоны и перестанут отражать реальный регион).
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
    // Подсветка ретрива — ПЕРЕКЛЮЧАТЕЛЬ (MEMORY_GRAPH_UI_PLAN.md, Этап 5, пункт 4 запроса владельца: "не таймер"),
    // по умолчанию выключен, состояние сохраняется вместе с остальным состоянием окна.
    const retrievalOverlayEnabled = signal(false);

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY,
            value: {
                visible: panelVisible.peek(), collapsed: panelCollapsed.peek(), position: panelPosition.peek(), size: panelSize.peek(),
                retrievalOverlayEnabled: retrievalOverlayEnabled.peek(),
                colorMetricId: colorMetricId.peek(), sizeMode: sizeMode.peek(), glowMode: glowMode.peek(),
            },
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
        retrievalOverlayEnabled.set(Boolean(saved.retrievalOverlayEnabled));
        if (saved.colorMetricId) colorMetricId.set(saved.colorMetricId);
        if (saved.sizeMode) sizeMode.set(saved.sizeMode);
        if (saved.glowMode) glowMode.set(saved.glowMode);
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
    // История ретривов (MEMORY_GRAPH_UI_PLAN.md, Этап 5.3) — Ядро уже держит кольцевой буфер из 20 (Этап 2,
    // `memoryGraph.retrievals`, новые первыми). `retrievalHistoryIndex` — `null` значит "Live" (следовать за самым
    // новым, `retrievalHistory()[0]`), иначе индекс конкретной, выбранной пользователем точки истории.
    const retrievalHistory = signal([]);
    const retrievalHistoryIndex = signal(null);
    const busy = signal(false);
    const statusText = signal('');

    /** Ретрив, который сейчас должен быть показан — либо самый свежий (Live), либо выбранная в истории точка. */
    function currentRetrieval() {
        const history = retrievalHistory();
        if (!history.length) return null;
        const index = retrievalHistoryIndex();
        return history[index == null ? 0 : Math.min(index, history.length - 1)] ?? null;
    }

    /** Выбор точки истории — план прямо требует: "выбор точки включает переключатель автоматически". */
    function selectRetrievalHistory(index) {
        retrievalHistoryIndex.set(index);
        retrievalOverlayEnabled.set(true);
        saveWindowState();
    }

    /** ◀ — на одну точку СТАРШЕ (больший индекс, `retrievalHistory` — новые первыми); ▶ — на одну точку СВЕЖЕЕ, до возврата в Live (`null`) на самой новой. */
    function stepRetrievalHistory(direction) {
        const history = retrievalHistory();
        if (!history.length) return;
        const current = retrievalHistoryIndex() ?? 0;
        const next = current + direction;
        if (next < 0) { retrievalHistoryIndex.set(null); saveWindowState(); return; }
        selectRetrievalHistory(Math.min(history.length - 1, next));
    }

    function goLiveRetrieval() {
        retrievalHistoryIndex.set(null);
        saveWindowState();
    }

    async function refresh() {
        const [nodesResult, regionsResult, mergeResult, reconResult, stagingResult, decisionLogResult, retrievalsResult] = await Promise.all([
            call('memoryGraph.nodes'), call('memoryGraph.regions'), call('memoryGraph.mergeQueue'), call('memoryGraph.reconsolidationQueue'), call('memoryGraph.staging'), call('memoryGraph.decisionLog'), call('memoryGraph.retrievals'),
        ]);
        if (nodesResult.ok) nodes.set(nodesResult.value);
        if (regionsResult.ok) regions.set(regionsResult.value);
        if (mergeResult.ok) mergeQueue.set(mergeResult.value);
        if (reconResult.ok) reconsolidationQueue.set(reconResult.value);
        if (stagingResult.ok) staging.set(stagingResult.value);
        if (decisionLogResult.ok) decisionLog.set(decisionLogResult.value);
        if (retrievalsResult.ok) retrievalHistory.set(retrievalsResult.value);
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

    /** MEMORY_GRAPH_UI_PLAN.md, Этап 7.1 — перенос ТОЛЬКО через `regionId` (`zoneAt()` вместо дартборда, см. `dragfree` в `ensureCytoscape()`); `sector`/`ring` этому вызывающему сегодня не нужны вовсе (Этап 7.2, создание нод по клику, по-прежнему на старой дартборд-геометрии — см. ROADMAP 5.108з, известный, задокументированный, отдельно вынесенный остаток). */
    async function moveNode(id, regionId) {
        busy.set(true);
        try {
            const result = await call('memoryGraph.nodes.move', { id, regionId });
            statusText.set(result.ok ? '' : `Move failed: ${result.error?.message}`);
            await refresh();
            return result;
        } finally {
            busy.set(false);
        }
    }

    async function createEdge(fromId, toId, type = 'related') {
        busy.set(true);
        try {
            await call('memoryGraph.edges.create', { fromId, toId, type });
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

    /** "Ребро между уже соединёнными нодами того же типа — не создавать" (план 7.3). */
    function alreadyConnected(fromId, toId, type) {
        const fromNode = nodes().find(node => node.id === fromId);
        return Boolean(fromNode?.edges?.some(edge => edge.to === toId && edge.type === type));
    }

    /** Создание ребра С ПРОВЕРКОЙ дубликата — общий путь для Shift-drag и режима "Connect" (Этап 7.3). */
    function createEdgeChecked(fromId, toId, type) {
        if (alreadyConnected(fromId, toId, type)) { statusText.set('Already connected.'); return; }
        createEdge(fromId, toId, type);
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
    // Нода, которую СЕЙЧАС держит мышь (`grab`…`free`) — MEMORY_GRAPH_UI_PLAN.md, Этап 4.1: её ПОЗИЦИЮ диффинг
    // ниже трогать не должен (см. diffElements()'s doc-comment), иначе свежепосчитанная раскладка того же региона
    // могла бы "выдернуть" ноду из-под пальца на середине драга.
    let draggingId = null;
    // Последние посчитанные зоны — нужны `updateBackgroundTransform()` отдельно от `renderZonesSvg()` (тот же
    // набор зон определяет и СТРОКУ SVG, и половину его стороны для смещения в `backgroundTransformCss()`, но
    // пересчитывать/перерисовывать саму строку на каждый 'pan'/'zoom' незачем — только на реальное изменение зон).
    let currentZones = [];
    let lastZonesSignature = null;
    // Последняя посчитанная раскладка (Map(id → {x,y})) — снапбэк после неудачного драга (Этап 7.1: "зона та же —
    // нода плавно возвращается на СВОЮ позицию из раскладки") анимирует ИМЕННО эту позицию, не перечитывает граф.
    let lastPositions = new Map();

    // --- Перетаскивание/соединение (Этап 7) --------------------------------

    // "Moved to <label> · Undo" (Этап 7.1) — исчезает сама через 5с.
    const moveToast = signal(null); // { nodeId, label, previousRegionId } | null
    let moveToastTimer = null;
    function showMoveToast(nodeId, label, previousRegionId) {
        clearTimeout(moveToastTimer);
        moveToast.set({ nodeId, label, previousRegionId });
        moveToastTimer = setTimeout(() => moveToast.set(null), 5000);
    }
    function undoMove() {
        const toast = moveToast.peek();
        if (!toast) return;
        clearTimeout(moveToastTimer);
        moveToast.set(null);
        moveNode(toast.nodeId, toast.previousRegionId);
    }

    // Режим "Connect" (Этап 7.3) — кнопка-переключатель, состояние решений — чистый `connectModeStep()` (interactions.js).
    const connectMode = signal(false);
    const connectState = signal({ selectedId: null });
    const currentEdgeType = signal('related');
    function toggleConnectMode() {
        connectMode.set(!connectMode.peek());
        connectState.set({ selectedId: null });
    }

    // Выбранное ребро (Этап 7.4 — Б5: клик ВЫДЕЛЯЕТ, не удаляет сразу) — маленькая панель "type · Delete" в сайдбаре.
    const selectedEdge = signal(null); // { id, source, target, type } | null

    /** Подсветка зоны под курсором во время драга (Этап 7.1) — прямая правка DOM у уже нарисованного `<path>` (`zones-svg.js`'s `data-region-id`), не полная пересборка SVG на каждый кадр драга. */
    let highlightedZonePath = null;
    function setZoneHighlight(regionId) {
        if (highlightedZonePath) { highlightedZonePath.classList.remove('stme-mg-zone-highlight'); highlightedZonePath = null; }
        if (regionId === undefined) return;
        const svg = document.getElementById(ZONES_SVG_ID);
        if (!svg) return;
        const attr = regionId == null ? '' : String(regionId);
        const path = svg.querySelector(`path[data-region-id="${CSS.escape(attr)}"]`);
        if (path) { path.classList.add('stme-mg-zone-highlight'); highlightedZonePath = path; }
    }

    // --- Режимы карты (Этап 6.2) — три независимых канала, тот же принцип, что у звёздной карты EVE Online:
    // ОДНА карта, но выбор решает, что показывают цвет/размер/свечение. Persisted с окном (см. save/loadWindowState).
    const colorMetricId = signal('weight');
    const sizeMode = signal('connections'); // 'connections' | 'importance' | 'retrieved' | 'uniform'
    const glowMode = signal('weight'); // 'none' | 'weight' | 'retrieved' | 'risk'
    const MAP_MODE_PRESETS = {
        health: { color: 'weight', size: 'connections', glow: 'weight' },
        risk: { color: 'risk', size: 'connections', glow: 'risk' },
        usage: { color: 'retrieved', size: 'retrieved', glow: 'retrieved' },
        structure: { color: 'region', size: 'connections', glow: 'none' },
        timeline: { color: 'age', size: 'uniform', glow: 'none' },
    };
    function applyMapModePreset(name) {
        const preset = MAP_MODE_PRESETS[name];
        if (!preset) return;
        colorMetricId.set(preset.color);
        sizeMode.set(preset.size);
        glowMode.set(preset.glow);
        saveWindowState();
    }

    /** Регионы — плоский объект по `id` (`layoutGraph()`'s формат), а не массив, что отдаёт `memoryGraph.regions`. */
    function regionsById() {
        const map = {};
        for (const region of regions()) map[region.id] = region;
        return map;
    }

    /** "Size by" (Этап 6.2) — какую величину подставить ВМЕСТО `degree` в `nodeRadius()` (layout.js's формула сама не знает, ПОЧЕМУ число такое — только само число). */
    function sizeDrivingValue(node) {
        switch (sizeMode()) {
            case 'importance': return node.importance ?? 0;
            case 'retrieved': return node.retrievedCount ?? 0;
            case 'uniform': return 0; // все узлы — базовый радиус (протект-бонус и обводка всё равно отличают роль)
            case 'connections':
            default: return node.degree ?? 0;
        }
    }

    /**
     * Единая раскладка — MEMORY_GRAPH_UI_PLAN.md, Этап 3/4: зоны-кольца регионов вместо дартборда (`layoutGraph()`,
     * layout.js), а не три разные ветки (`stagedNodePosition`/`regionLayoutPosition`/`fallbackSemanticPosition`),
     * что рисовали РАЗНУЮ геометрию для числовых/семантических/накопительных регионов, никогда не совпадавшую с
     * фоном (Б1 плана). Ноды графа уже несут `regionId`/`degree`/`protectedNode`/`createdAt`/`weightRank` — Ядро
     * отдаёт их напрямую (`nodesForResponse()`, Этап 2), `layoutGraph()` требует ровно эти поля.
     *
     * "Size by" (Этап 6.2, "раскладка всегда считается по выбранному размеру — зазоры остаются верными в любом
     * режиме") — `layoutRegion()`/`nodeRadius()` (layout.js) читают ТОЛЬКО `member.degree`, ни о каких режимах не
     * знают; вместо правки layout.js подменяем `degree` каждой ноды на выбранную величину ЗАРАНЕЕ, здесь — та же
     * математика радиуса/зазора применяется к ЛЮБОЙ неотрицательной величине одинаково корректно.
     */
    function computeGraphLayout() {
        const layoutNodes = sizeMode() === 'connections' ? nodes() : nodes().map(node => ({ ...node, degree: sizeDrivingValue(node) }));
        return layoutGraph(layoutNodes, regionsById());
    }

    /** "Glow by" (Этап 6.2) — 0..1, протектным нодам всегда добавлена надбавка (та же визуальная гарантия "роль виднее", что была в Этапе 4, независимо от режима). */
    function glowValue(node, ctx, retrievedDomain) {
        const bump = node.protectedNode ? 0.25 : 0;
        switch (glowMode()) {
            case 'none': return Math.min(0.9, 0.12 + bump);
            case 'retrieved': {
                const { min, max } = retrievedDomain;
                const t = max > min ? ((node.retrievedCount ?? 0) - min) / (max - min) : 0;
                return Math.min(0.9, 0.12 + 0.5 * t + bump);
            }
            case 'risk': return Math.min(0.9, 0.12 + 0.5 * findMetric('risk').value(node, ctx) + bump);
            case 'weight':
            default: return Math.min(0.9, 0.12 + 0.5 * (node.protectedNode ? 1 : (node.weightRank ?? 0)) + bump);
        }
    }

    /** Ноды по id — переиспользуется рёбрами, фильтрами/поиском, тултипом. */
    function nodesById() {
        return new Map(nodes().map(node => [node.id, node]));
    }

    // Последние hue по региону (из `zones`, посчитанных `buildNextElements()`) — легенде (Этап 6.3) нужен ТОТ ЖЕ
    // контекст, что и цвету нод, но легенда рисуется отдельным `computed()`, не внутри самого диффинга.
    let lastHueByRegionId = new Map();

    /** `Map(id → { group, data, position? })` для ВСЕХ элементов, что ДОЛЖНЫ быть на канвасе прямо сейчас — вход для `diffElements()`. `positions`/`radii` — уже посчитанная `layoutGraph()` (вызывающий, `syncCytoscape()`, считает её ОДИН раз и на элементы, и на зоны фона). */
    function buildNextElements({ positions, radii, zones }) {
        const byId = nodesById();
        const colorMetric = findMetric(colorMetricId());
        const hueByRegionId = new Map(zones.map(zone => [zone.regionId, zone.hue]));
        lastHueByRegionId = hueByRegionId;
        const ctx = { regionsById: regionsById(), hueByRegionId };
        const colorDomain = metricDomain(colorMetric, nodes(), ctx);
        const retrievedDomain = metricDomain(findMetric('retrieved'), nodes(), ctx);
        const map = new Map();
        for (const node of nodes()) {
            const size = 2 * (radii.get(node.id) ?? nodeRadius(node));
            map.set(node.id, {
                group: 'nodes',
                data: {
                    id: node.id, label: node.label, degree: node.degree ?? 0, protectedNode: Boolean(node.protectedNode),
                    importance: node.importance ?? 0, size,
                    // `colorMetric.value()` уже само знает, что делать с `protectedNode` для метрик, которым это
                    // важно (`weight`/`risk` — см. metrics.js); остальные метрики (region/source/age/…) красят
                    // защищённую ноду ТАК ЖЕ, как обычную — белая обводка (graphStylesheet()) и так отличает роль.
                    color: metricColor(colorMetric, colorMetric.value(node, ctx), colorDomain),
                    glow: glowValue(node, ctx, retrievedDomain),
                },
                position: positions.get(node.id) ?? { x: 0, y: 0 },
            });
        }
        const seen = new Set();
        for (const node of nodes()) {
            for (const edge of node.edges ?? []) {
                const key = [node.id, edge.to].sort().join('|') + ':' + edge.type;
                if (seen.has(key)) continue; // рёбра двусторонние в данных — одна визуальная линия на пару
                seen.add(key);
                const other = byId.get(edge.to);
                const backbone = Boolean(node.protectedNode && other?.protectedNode);
                map.set(`edge:${key}`, { group: 'edges', data: { id: `edge:${key}`, source: node.id, target: edge.to, type: edge.type, backbone } });
            }
        }
        if (isCreating() && previewPosition()) {
            map.set(PREVIEW_ID, { group: 'nodes', data: { id: PREVIEW_ID, label: formLabel() || 'New node' }, position: previewPosition() });
        }
        return map;
    }

    /** `Map(id → { group, data, position? })` из живого `cy` — то, что РЕАЛЬНО сейчас на канвасе (см. `diffElements()`'s doc-comment за тем, зачем нужны обе стороны). */
    function currentElements() {
        const map = new Map();
        if (!cy) return map;
        cy.elements().forEach(ele => {
            map.set(ele.id(), { group: ele.isNode() ? 'nodes' : 'edges', data: ele.data(), position: ele.isNode() ? ele.position() : undefined });
        });
        return map;
    }

    /**
     * Держит подложку зон синхронной с ЖИВЫМ pan/zoom Cytoscape — решено с
     * пользователем: подложка считалась под один фиксированный масштаб и
     * "физически уезжала" при любом драге/скролле канваса. Тот же расчёт
     * экран=pan+модель*zoom, что использует сам Cytoscape; `currentZones`'s
     * максимальный `rOuter` — та же половина стороны, что `renderZonesSvg()`
     * посчитала для самой строки SVG (см. `updateZonesBackground()`).
     */
    function updateBackgroundTransform() {
        if (!cy) return;
        const svg = document.getElementById(ZONES_SVG_ID);
        if (!svg) return;
        const half = currentZones.length ? Math.max(...currentZones.map(zone => zone.rOuter)) : 1;
        svg.style.transform = backgroundTransformCss(cy.pan(), cy.zoom(), half);
    }

    /** Перерисовывает `<svg>` фона зон ТОЛЬКО когда зоны реально изменились (`zonesSignature()`) — план прямо просит не делать этого на каждый pan/zoom/refresh, раз `layoutGraph()` детерминирован и часто отдаёт БАЙТ-В-БАЙТ те же зоны. */
    function updateZonesBackground(zones) {
        currentZones = zones;
        const signature = zonesSignature(zones);
        if (signature === lastZonesSignature) { updateBackgroundTransform(); return; }
        lastZonesSignature = signature;
        const bg = document.getElementById(BG_ID);
        if (bg) bg.innerHTML = renderZonesSvg(zones);
        updateBackgroundTransform();
    }

    async function ensureCytoscape() {
        if (cy) return cy;
        const container = document.getElementById(CANVAS_ID);
        if (!container) return null;
        const cytoscape = await loadCytoscape();
        cy = cytoscape({
            container,
            elements: [], // первое заполнение идёт через syncCytoscape() ниже — тот же путь diffElements(), что и любое последующее обновление, не отдельная ветка "начального" списка.
            layout: { name: 'preset' },
            style: graphStylesheet(),
            wheelSensitivity: 0.2,
            // Качество отрисовки (ориентир — карта EVE Online, план 4.2): чёткость важнее скорости на наших
            // размерах (сотни нод, не десятки тысяч). `pixelRatio: 'auto'` — резкость на HiDPI-экранах.
            pixelRatio: 'auto', textureOnViewport: false, motionBlur: false, hideEdgesOnViewport: false,
        });
        syncCytoscape(); // первая раскладка + фон зон — тем же кодом, что и обычное обновление
        // Начальный вид — ВЕСЬ круг зон по центру канваса: модельные
        // координаты центрированы на (0, 0), а у Cytoscape по умолчанию
        // pan = (0, 0) и zoom = 1, то есть (0, 0) лежал бы в ЛЕВОМ ВЕРХНЕМ
        // углу холста. Половина стороны — реальный внешний край зон
        // (`currentZones`, только что посчитан `syncCytoscape()` выше), не
        // фиксированный MAX_RADIUS: раскладка теперь переменного размера
        // (регионы — данные, не сетка 5×3).
        const width = container.clientWidth || 480;
        const height = container.clientHeight || 480;
        const halfExtent = currentZones.length ? Math.max(...currentZones.map(zone => zone.rOuter)) : 200;
        cy.viewport({ zoom: Math.min(width, height) / (2 * halfExtent), pan: { x: width / 2, y: height / 2 } });
        cy.on('pan zoom', updateBackgroundTransform);
        updateBackgroundTransform();
        cy.on('tap', 'node', event => {
            if (event.target.id() === PREVIEW_ID) return; // не настоящий узел — нечего редактировать
            // Режим "Connect" (Этап 7.3) перехватывает клик по ноде ЦЕЛИКОМ — открывать форму редактирования
            // ОДНОВРЕМЕННО с выбором пары для ребра было бы путаницей; выйти из режима явно — кнопка/Esc.
            if (connectMode()) {
                const { next, create } = connectModeStep(connectState.peek(), event.target.id());
                connectState.set(next);
                cy.nodes().removeClass('connect-selected');
                if (next.selectedId) cy.getElementById(next.selectedId).addClass('connect-selected');
                if (create) createEdgeChecked(create[0], create[1], currentEdgeType());
                return;
            }
            openEditForm(nodes().find(node => node.id === event.target.id()));
        });
        // Имя показывается ТОЛЬКО под курсором (решено с пользователем —
        // при 61 ноде подписи разом занимали весь холст) — данные крупные/
        // защищённые ноды теперь ВСЕГДА подписаны через graphStylesheet(),
        // класс `.hovered` покрывает только ОСТАЛЬНЫЕ, мелкие ноды.
        cy.on('mouseover', 'node', event => {
            event.target.addClass('hovered');
            if (event.target.id() === PREVIEW_ID) return;
            hoveredNodeId.set(event.target.id());
            hoveredScreenPos.set({ x: event.renderedPosition.x, y: event.renderedPosition.y });
        });
        cy.on('mouseout', 'node', event => { event.target.removeClass('hovered'); hoveredNodeId.set(null); });
        // Клик по ребру ВЫДЕЛЯЕТ его (Этап 7.4, Б5 плана: раньше удалял СРАЗУ — случайные удаления, реальная
        // жалоба). Панель "type · Delete" — в сайдбаре (`edgeSelectionPanel()`); само удаление — только кнопкой
        // или клавишей Delete/Backspace (`handleGlobalKeydown()` ниже), не одним кликом.
        cy.on('tap', 'edge', event => {
            const data = event.target.data();
            cy.elements().unselect();
            event.target.select();
            selectedEdge.set({ id: data.id, source: data.source, target: data.target, type: data.type });
        });
        // Клик по ПУСТОМУ месту канваса — если сейчас режим создания
        // (кнопка "+ Node" уже нажата), уточняет sector/ring по месту клика
        // (`event.position` — координаты модели, ТЕ ЖЕ, что раскладка узлов,
        // preset-layout не масштабирует их); иначе просто закрывает форму.
        // ВРЕМЕННО всё ещё дартборд-геометрия (`pixelToRegion`) — Этап 7
        // плана заменит на `zoneAt()` (layout.js), см. doc-comment у
        // импортов вверху файла и ROADMAP 5.108г.
        cy.on('tap', event => {
            if (event.target !== cy) return;
            selectedEdge.set(null);
            // Создание по клику — ВРЕМЕННО всё ещё дартборд-геометрия (`pixelToRegion`), не `zoneAt()` — Этап 7.2
            // (кнопка "+ Node"/форма создания в сайдбаре) не построен ЭТИМ проходом плана, решено с пользователем
            // явно (см. ROADMAP 5.108з): `isCreating()` сегодня недостижим ни из одного места UI, ветка ниже —
            // мёртвый код, оставлен нетронутым (план запрещает удалять код на будущее без явной причины), а не
            // "почти рабочая" фича.
            if (isCreating()) {
                creatingAt.set(pixelToRegion(event.position.x, event.position.y, {}));
                previewPosition.set({ x: event.position.x, y: event.position.y });
            } else closeForm();
        });
        // `draggingId` — только на время самого драга (Этап 4.1: диффинг не
        // должен переставлять ноду, которую пользователь ещё держит).
        cy.on('grab', 'node', event => { draggingId = event.target.id(); });
        // Подсветка зоны под курсором во время драга (Этап 7.1).
        cy.on('drag', 'node', event => {
            const pos = event.target.position();
            setZoneHighlight(zoneAt(pos.x, pos.y, currentZones)?.regionId);
        });
        cy.on('free', 'node', event => { draggingId = null; setZoneHighlight(undefined); });
        /**
         * Отпустили ноду (Этап 7.1) — решает ЧИСТАЯ `dropDecision()` (interactions.js) по зоне ПОД КУРСОРОМ
         * (`zoneAt()`, layout.js), не дартборд-математика. `'snap-back'` — та же зона, накопитель или пусто
         * (владелец: "перетащили в СВОЙ регион — возвращается на место"; накопитель НАРОЧНО не даёт ручной переезд
         * — см. `dropDecision()`'s doc-comment) — плавная анимация НАЗАД на позицию из уже посчитанной раскладки
         * (`lastPositions`), а не рефреш графа (граф и не менялся). Настоящий переезд — `moveNode(id, regionId)`
         * (Этап 2 API), с плашкой "Moved to <label> · Undo" (Undo — `undoMove()`).
         */
        cy.on('dragfree', 'node', event => {
            const node = nodes().find(item => item.id === event.target.id());
            if (!node) return;
            const pos = event.target.position();
            const zone = zoneAt(pos.x, pos.y, currentZones);
            const decision = dropDecision(node.regionId, zone);
            if (decision === 'snap-back') {
                const layoutPos = lastPositions.get(node.id);
                if (layoutPos) event.target.animate({ position: layoutPos }, { duration: 200 });
                return;
            }
            const previousRegionId = node.regionId;
            const targetRegionId = decision.move;
            moveNode(node.id, targetRegionId).then(result => {
                if (result?.ok) showMoveToast(node.id, regions().find(region => region.id === targetRegionId)?.label ?? targetRegionId, previousRegionId);
            });
        });
        // Shift + перетаскивание от ноды рисует ребро (Этап 7.3) — обычное перетаскивание ноды отключается на
        // время соединения (`ungrabify()`/`grabify()` после), иначе один и тот же жест двусмысленен.
        cy.on('tapstart', 'node', event => {
            if (!event.originalEvent?.shiftKey || !host.__edgehandles) return;
            event.target.ungrabify();
            host.__edgehandles.start(event.target);
        });
        if (typeof cytoscape.use === 'function' && cy.edgehandles) {
            const eh = cy.edgehandles({});
            cy.on('ehcomplete', (event, sourceNode, targetNode) => {
                sourceNode.grabify();
                createEdgeChecked(sourceNode.id(), targetNode.id(), currentEdgeType());
            });
            cy.on('ehcancel', (event, sourceNode) => sourceNode.grabify());
            host.__edgehandles = eh; // держим ссылку — иначе GC может собрать раньше времени в некоторых движках
        }
        return cy;
    }

    /**
     * Синхронизация БЕЗ полной пересборки (Б3 плана, Этап 4.1) — раньше `cy.elements().remove()` + добавление
     * всего заново на КАЖДОЕ изменение графа сбрасывало выделение и обрывало перетаскивание (нода "прыгала"
     * обратно при любом чужом `refresh()`). Теперь — чистый `diffElements()` (elements-diff.js) между тем, что
     * РЕАЛЬНО на канвасе (`currentElements()`), и тем, что должно быть (`buildNextElements()`); `add`/`remove`
     * применяются через `cy.add()`/`.remove()`, `update` — точечно через `.data()`/`.position()` на конкретном
     * элементе, не общий `.layout(...).run()`. Pan/zoom/выделение не трогаются вообще — их вообще не задевает ни
     * один из этих трёх вызовов.
     */
    function syncCytoscape() {
        if (!cy) return;
        const { positions, radii, zones } = computeGraphLayout();
        lastPositions = positions;
        const next = buildNextElements({ positions, radii, zones });
        const { add, remove, update } = diffElements(currentElements(), next, { excludeId: draggingId });
        for (const id of remove) {
            const ele = cy.getElementById(id);
            if (ele.nonempty()) cy.remove(ele);
        }
        if (add.length) {
            cy.add(add.map(item => ({
                group: item.group, data: item.data, position: item.position,
                grabbable: item.id !== PREVIEW_ID, selectable: item.id !== PREVIEW_ID,
            })));
        }
        for (const item of update) {
            const ele = cy.getElementById(item.id);
            if (ele.empty()) continue;
            if (item.data) ele.data(item.data);
            if (item.position) ele.position(item.position);
        }
        updateZonesBackground(zones);
        applyRetrievalOverlay();
        applySearchFilters();
    }

    // --- Подсветка ретрива (Этап 5) ---------------------------------------

    const OVERLAY_CLASSES = ['beacon', 'route-node', 'noise', 'route', 'dimmed'];

    /** Классы подсветки — на ВСЕ элементы канваса, включая маркер создания (у него класс никогда не находится, снимается тем же циклом). Выключен или ретрив ещё не выбран — просто снимает все классы обратно. */
    function applyRetrievalOverlay() {
        if (!cy) return;
        const retrieval = retrievalOverlayEnabled() ? currentRetrieval() : null;
        const allNodeIds = cy.nodes().map(ele => ele.id());
        const allEdges = cy.edges().map(ele => ({ id: ele.id(), source: ele.source().id(), target: ele.target().id() }));
        const classes = retrievalClasses(retrieval, allNodeIds, allEdges);
        cy.elements().forEach(ele => {
            const wanted = classes.get(ele.id());
            for (const cls of OVERLAY_CLASSES) {
                if (cls === wanted) ele.addClass(cls); else ele.removeClass(cls);
            }
        });
    }

    /**
     * Бегущий пунктир по рёбрам маршрута (Этап 5.4) — `requestAnimationFrame`, ≤30 кадров/с (план прямо задаёт
     * потолок), останавливается сам (не планирует следующий кадр), как только подсветка выключена, окно скрыто или
     * `prefers-reduced-motion: reduce` — тогда виден только СТАТИЧНЫЙ пунктир из самого стиля (`line-dash-pattern`
     * в graphStylesheet(), смещение не движется).
     */
    let routeAnimationFrame = null;
    let lastRouteAnimationTime = 0;
    function reducedMotionRequested() {
        return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    function stepRouteAnimation(timestamp) {
        routeAnimationFrame = null;
        if (!cy || !retrievalOverlayEnabled() || !panelVisible() || reducedMotionRequested()) return;
        if (timestamp - lastRouteAnimationTime >= 1000 / 30) {
            lastRouteAnimationTime = timestamp;
            const routeEdges = cy.edges('.route');
            if (routeEdges.nonempty()) routeEdges.style('line-dash-offset', (routeEdges[0].numericStyle('line-dash-offset') || 0) - 1);
        }
        routeAnimationFrame = requestAnimationFrame(stepRouteAnimation);
    }
    function ensureRouteAnimation() {
        if (routeAnimationFrame || !cy || !retrievalOverlayEnabled() || !panelVisible() || reducedMotionRequested()) return;
        routeAnimationFrame = requestAnimationFrame(stepRouteAnimation);
    }

    // --- Поиск и фильтры (Этап 6.5) -----------------------------------------

    const searchQuery = signal('');
    const searchMatchIndex = signal(0);
    const showProtected = signal(true);
    const showOrdinary = signal(true);
    const showUnplaced = signal(true);
    const showEdges = signal(true);
    const minWeightThreshold = signal(0);

    /** `.filtered` (display:none, план 6.5) и `.match` (подсветка поиска) — НЕ пересчитывает раскладку (позиции остаются из `layoutGraph()`, план прямо просит "карта не прыгает"). */
    function applySearchFilters() {
        if (!cy) return;
        const query = searchQuery().trim().toLowerCase();
        const threshold = minWeightThreshold();
        const byId = nodesById();
        cy.nodes().forEach(ele => {
            if (ele.id() === PREVIEW_ID) return;
            const node = byId.get(ele.id());
            if (!node) return;
            const rank = node.protectedNode ? 1 : (node.weightRank ?? 0);
            const hidden = (node.protectedNode && !showProtected())
                || (!node.protectedNode && node.regionId != null && !showOrdinary())
                || (node.regionId == null && !showUnplaced())
                || rank < threshold;
            ele.toggleClass('filtered', hidden);
            ele.toggleClass('match', Boolean(query) && ((node.label ?? '').toLowerCase().includes(query) || (node.content ?? '').toLowerCase().includes(query)));
        });
        cy.edges().forEach(ele => ele.toggleClass('filtered', !showEdges()));
    }

    /** Enter в поле поиска — первое совпадение центрируется и выделяется, повторный Enter — следующее по кругу (план 6.5). */
    function centerOnNextSearchMatch() {
        if (!cy || !searchQuery().trim()) return;
        const matches = cy.nodes('.match');
        if (!matches.nonempty()) return;
        const index = searchMatchIndex() % matches.length;
        const ele = matches[index];
        cy.elements().unselect();
        ele.select();
        cy.animate({ center: { eles: ele }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300 });
        searchMatchIndex.set(index + 1);
    }

    // --- Подсказка при наведении (Этап 6.4) ---------------------------------

    const hoveredNodeId = signal(null);
    const hoveredScreenPos = signal(null);

    // --- Центрирование на регионе (клик по "Fullest region" в статистике, Этап 6.6) ---
    function centerOnRegion(regionId) {
        if (!cy) return;
        const zone = currentZones.find(z => z.regionId === regionId);
        if (!zone) return;
        cy.animate({ pan: { x: cy.width() / 2 - zone.anchor.x * cy.zoom(), y: cy.height() / 2 - zone.anchor.y * cy.zoom() } }, { duration: 300 });
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

    /** "12s ago"/"4m ago"/"3h ago" — не точная метка времени, план сам так просит (Этап 5.5). */
    function timeAgo(at) {
        if (!at) return '';
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        return `${Math.round(minutes / 60)}h ago`;
    }

    /** Клик по маяку в списке (Этап 5.5) — центрирует канвас на нём и выделяет; не открывает форму редактирования (та — по клику НА САМОМ канвасе, отдельное действие). */
    function selectBeaconOnCanvas(id) {
        if (!cy) return;
        const ele = cy.getElementById(id);
        if (ele.empty()) return;
        cy.elements().unselect();
        ele.select();
        cy.animate({ center: { eles: ele }, zoom: Math.max(cy.zoom(), 1) }, { duration: 300 });
    }

    /** Полоса истории — точки по времени (новые справа), ◀/▶ и "Live" (Этап 5.3, приём как у "повтора" на карте EVE). */
    function retrievalHistoryStrip() {
        return computed(() => {
            const history = retrievalHistory();
            if (!history.length) return null;
            const index = retrievalHistoryIndex();
            const activeIndex = index == null ? 0 : Math.min(index, history.length - 1);
            return h('div', { class: 'stme-mg-retrieval-strip' },
                Button('◀', () => stepRetrievalHistory(1), { disabled: activeIndex >= history.length - 1 }),
                h('div', { class: 'stme-mg-retrieval-dots' }, [...history].reverse().map((entry, reversedIndex) => {
                    const realIndex = history.length - 1 - reversedIndex;
                    return h('span', {
                        class: `stme-mg-retrieval-dot${realIndex === activeIndex ? ' stme-mg-retrieval-dot-active' : ''}`,
                        title: new Date(entry.at).toLocaleTimeString(),
                        'on:click': () => selectRetrievalHistory(realIndex),
                    });
                })),
                Button('▶', () => stepRetrievalHistory(-1), { disabled: index == null }),
                Button('Live', goLiveRetrieval, { disabled: index == null }),
            );
        });
    }

    /** Секция "Retrieval" (Этап 5.5) — детали ВЫБРАННОГО (историей или Live) ретрива: время, sticky, маяки, цепочка маршрута, шум, запрос. */
    function retrievalSection() {
        return h('div', { class: 'stme-mg-retrieval-section' },
            Row(Toggle('Retrieval overlay', retrievalOverlayEnabled), retrievalHistoryStrip()),
            computed(() => {
                const retrieval = currentRetrieval();
                if (!retrieval) return h('small', { class: 'stme-module-hint' }, 'No retrieval recorded yet this chat.');
                const labelById = new Map(nodes().map(node => [node.id, node.label]));
                const chain = routeChainLabels(retrieval.segments, labelById);
                const beaconIds = retrieval.beaconIds ?? [];
                const noiseCount = (retrieval.noiseIds ?? []).length;
                return h('div', { class: 'stme-mg-retrieval-detail' },
                    Row(
                        h('span', {}, timeAgo(retrieval.at)),
                        retrieval.sticky ? Badge('reused', { tone: 'muted' }) : null,
                    ),
                    beaconIds.length
                        ? h('div', { class: 'stme-mg-retrieval-beacons' }, beaconIds.map(id => Button(labelById.get(id) ?? id, () => selectBeaconOnCanvas(id))))
                        : null,
                    chain.length > 1 ? h('div', { class: 'stme-mg-retrieval-chain' }, chain.join(' → ')) : null,
                    noiseCount ? h('small', { class: 'stme-module-hint' }, `+${noiseCount} noise`) : null,
                    retrieval.query ? h('small', { class: 'stme-module-hint' }, `Query: ${retrieval.query}`) : null,
                );
            }),
        );
    }

    /** "Moved to <label> · Undo" (Этап 7.1) — живёт поверх канваса, не сайдбара: ближе к месту, где реально произошёл драг. */
    function moveToastBlock() {
        return computed(() => {
            const toast = moveToast();
            if (!toast) return null;
            return h('div', { class: 'stme-mg-toast' }, h('span', {}, `Moved to ${toast.label}`), Button('Undo', undoMove));
        });
    }

    /** Кнопка "Connect" + тип ребра + панель выделенного ребра "type · Delete" (Этап 7.3/7.4). */
    function connectAndEdgeRow() {
        return Row(
            Button(computed(() => (connectMode() ? 'Connecting… (Esc to stop)' : 'Connect')), toggleConnectMode, { variant: connectMode() ? 'danger' : 'default' }),
            Field('Edge type', Select(currentEdgeType, () => edgeTypesInGraph(nodes()).map(type => ({ value: type, label: type })))),
            computed(() => {
                const edge = selectedEdge();
                if (!edge) return null;
                return Row(
                    h('span', { class: 'stme-module-hint' }, `Selected edge: ${edge.type}`),
                    Button('Delete', () => { selectedEdge.set(null); deleteEdge(edge.source, edge.target, edge.type); }, { variant: 'danger' }),
                );
            }),
        );
    }

    // --- Режимы карты + легенда (Этап 6.2/6.3) ------------------------------

    const SIZE_OPTIONS = [
        { value: 'connections', label: 'Connections' }, { value: 'importance', label: 'Importance' },
        { value: 'retrieved', label: 'Retrieved' }, { value: 'uniform', label: 'Uniform' },
    ];
    const GLOW_OPTIONS = [
        { value: 'none', label: 'None' }, { value: 'weight', label: 'Weight' },
        { value: 'retrieved', label: 'Retrieved' }, { value: 'risk', label: 'Risk' },
    ];
    const COLOR_OPTIONS = METRICS.map(metric => ({ value: metric.id, label: metric.label }));

    /** Легенда (Этап 6.3) — угол холста, HTML поверх (не Cytoscape): название метрики, градиент/категории, строки про размер/свечение. Обновляется сама на смену режима/данных (`computed()`). */
    function legendBlock() {
        return computed(() => {
            const metric = findMetric(colorMetricId());
            const ctx = { regionsById: regionsById(), hueByRegionId: lastHueByRegionId };
            const domain = metricDomain(metric, nodes(), ctx);
            const scaleBlock = metric.scale === 'categorical'
                ? h('div', { class: 'stme-mg-legend-categories' }, (domain.length ? domain : [null]).map(value => h('span', { class: 'stme-mg-legend-chip' },
                    h('span', { class: 'stme-mg-legend-dot', style: { background: metricColor(metric, value) } }),
                    metric.format(value) || String(value ?? 'n/a'),
                )))
                : h('div', { class: 'stme-mg-legend-gradient' },
                    h('span', {}, metric.format(metric.scale === 'rank' ? 0 : domain.min)),
                    h('div', {
                        class: 'stme-mg-legend-bar',
                        style: { background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map(t => metricColor(metric, metric.scale === 'rank' ? t : domain.min + t * (domain.max - domain.min), domain)).join(',')})` },
                    }),
                    h('span', {}, metric.format(metric.scale === 'rank' ? 1 : domain.max)),
                );
            return h('div', { class: 'stme-mg-legend' },
                h('strong', {}, metric.label), scaleBlock,
                h('small', { class: 'stme-module-hint' }, `Size: ${sizeMode()}`),
                h('small', { class: 'stme-module-hint' }, `Glow: ${glowMode()}`),
            );
        });
    }

    /** "Map mode" (Этап 6.2) — три выпадающих списка + пять быстрых пресетов кнопками (тот же приём, что вкладки режимов карты в EVE). */
    function mapModeSection() {
        return h('div', { class: 'stme-mg-mapmode' },
            Row(Field('Color by', Select(colorMetricId, COLOR_OPTIONS)), Field('Size by', Select(sizeMode, SIZE_OPTIONS)), Field('Glow by', Select(glowMode, GLOW_OPTIONS))),
            Row(
                Button('Health', () => applyMapModePreset('health')),
                Button('Eviction risk', () => applyMapModePreset('risk')),
                Button('Usage', () => applyMapModePreset('usage')),
                Button('Structure', () => applyMapModePreset('structure')),
                Button('Timeline', () => applyMapModePreset('timeline')),
            ),
            legendBlock(),
        );
    }

    // --- Поиск + фильтры (сайдбар, Этап 6.5) --------------------------------

    function searchAndFiltersRow() {
        return h('div', { class: 'stme-mg-filters' },
            h('input', {
                class: 'text_pole', type: 'text', placeholder: 'Search label or content…', value: searchQuery,
                'on:input': event => { searchQuery.set(event.target.value); searchMatchIndex.set(0); },
                'on:keydown': event => { if (event.key === 'Enter') centerOnNextSearchMatch(); },
            }),
            Row(Toggle('Protected', showProtected), Toggle('Ordinary', showOrdinary), Toggle('Unplaced', showUnplaced), Toggle('Edges', showEdges)),
            LabeledSlider('Min weight', minWeightThreshold, { min: 0, max: 1, step: 0.05, format: value => value.toFixed(2) }),
        );
    }

    // --- Сводка (Этап 6.6) ---------------------------------------------------

    function statsSection() {
        return computed(() => {
            const allNodes = nodes();
            const protectedCount = allNodes.filter(node => node.protectedNode).length;
            const unplacedCount = allNodes.filter(node => node.regionId == null).length;
            const edgeIds = new Set();
            for (const node of allNodes) for (const edge of node.edges ?? []) edgeIds.add([node.id, edge.to].sort().join('|') + ':' + edge.type);
            const unprotected = allNodes.filter(node => !node.protectedNode);
            const avgWeight = unprotected.length ? unprotected.reduce((sum, node) => sum + (node.weight ?? 0), 0) / unprotected.length : 0;
            const regionList = regions();
            const fullest = regionList.reduce((best, region) => {
                const ratio = Number.isFinite(region.capacity) && region.capacity > 0 ? (region.count ?? 0) / region.capacity : 0;
                const bestRatio = best && Number.isFinite(best.capacity) && best.capacity > 0 ? (best.count ?? 0) / best.capacity : -1;
                return ratio > bestRatio ? region : best;
            }, null);
            const riskMetric = findMetric('risk');
            const ctx = { regionsById: regionsById() };
            const atRisk = allNodes.filter(node => riskMetric.value(node, ctx) > 0).length;
            const lastRetrieval = retrievalHistory()[0];
            const lastRetrievalCount = lastRetrieval ? (lastRetrieval.beaconIds?.length ?? 0) + (lastRetrieval.noiseIds?.length ?? 0) : null;
            return h('div', { class: 'stme-mg-stats' },
                h('small', {}, `${allNodes.length} nodes (${protectedCount} protected, ${unplacedCount} unplaced) · ${edgeIds.size} edges · ${regionList.length} regions`),
                h('small', {}, `Avg weight ${avgWeight.toFixed(2)} · ${atRisk} at eviction risk`),
                fullest
                    ? h('small', { class: 'stme-mg-stats-clickable', 'on:click': () => centerOnRegion(fullest.id) }, `Fullest: ${fullest.label ?? fullest.id} — ${fullest.count}/${fullest.capacity}`)
                    : null,
                h('small', {}, lastRetrievalCount == null ? 'No retrievals yet' : `Last retrieval: ${lastRetrievalCount} nodes`),
            );
        });
    }

    /** Подсказка при наведении (Этап 6.4) — карточка у курсора со ВСЕМИ метриками сразу, не форма редактирования (та — по клику). Позиционируется АБСОЛЮТНО внутри canvas-wrap (см. tree()). */
    function hoverTooltip() {
        return computed(() => {
            const id = hoveredNodeId();
            const pos = hoveredScreenPos();
            if (!id || !pos) return null;
            const node = nodes().find(item => item.id === id);
            if (!node) return null;
            const region = regions().find(item => item.id === node.regionId);
            const line = [
                `Weight ${node.weight != null ? node.weight.toFixed(2) : '—'}`,
                `Importance ${node.importance ?? 0}`,
                `Connections ${node.degree ?? 0}`,
                `Age ${node.ageTurns ?? 0}`,
                `Idle ${node.idleTurns ?? 0}`,
                `Retrieved ${node.retrievedCount ?? 0}×`,
            ].join(' · ');
            return h('div', { class: 'stme-mg-tooltip', style: { left: `${pos.x + 12}px`, top: `${pos.y + 12}px` } },
                h('strong', {}, node.label),
                h('div', {}, region ? region.label : (node.regionId == null ? 'Unplaced' : node.regionId)),
                h('div', {}, line),
                Row(node.protectedNode ? Badge('Protected', { tone: 'muted' }) : null, node.regionId == null ? Badge('Unplaced', { tone: 'muted' }) : null),
            );
        });
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
                    h('div', { class: 'stme-mg-canvas-wrap', style: { position: 'relative', width: '480px', height: '480px', borderRadius: '8px', overflow: 'hidden' } },
                        h('div', { id: BG_ID, style: { position: 'absolute', inset: '0' } }),
                        h('div', { id: CANVAS_ID, style: { position: 'absolute', inset: '0', background: 'transparent' } }),
                        hoverTooltip(),
                        moveToastBlock(),
                    ),
                    h('p', { class: 'stme-memory-graph-hint', style: { width: '480px', boxSizing: 'border-box' } },
                        'Click a node to edit it. Drag a node onto a different dartboard cell to move it into that region. Drag from a node\'s edge handle to another node to connect them.'),
                ),
                h('div', { class: 'stme-memory-graph-sidebar stme-module-body stme-mg-flat' },
                    generationRow(),
                    progressRow(),
                    retrievalRow(),
                    connectAndEdgeRow(),
                    mapModeSection(),
                    searchAndFiltersRow(),
                    statsSection(),
                    retrievalSection(),
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
        // Delete/Backspace удаляет ВЫДЕЛЕННОЕ ребро (Этап 7.4); Esc выходит из режима "Connect" (Этап 7.3) — оба
        // глобальные на `document`, а не на канвасе: клавиатурный фокус при клике по Cytoscape-канвасу не переходит
        // на него автоматически (это `<canvas>`, не фокусируемый элемент по умолчанию). Пропускает нажатия, пока
        // фокус в текстовом поле (правка label/content ноды и т.п. — Backspace там не должен трогать граф).
        function handleGlobalKeydown(event) {
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdge()) {
                const edge = selectedEdge();
                selectedEdge.set(null);
                deleteEdge(edge.source, edge.target, edge.type);
            } else if (event.key === 'Escape' && connectMode()) {
                connectMode.set(false);
                connectState.set({ selectedId: null });
                if (cy) cy.nodes().removeClass('connect-selected');
            }
        }
        document.addEventListener('keydown', handleGlobalKeydown);
        refreshUnsubscribers = [
            () => document.removeEventListener('keydown', handleGlobalKeydown),
            ...[
                'memoryGraph.nodeCreated', 'memoryGraph.nodeUpdated', 'memoryGraph.nodeDeleted', 'memoryGraph.nodeMoved',
                'memoryGraph.nodeEvicted', 'memoryGraph.nodesMerged', 'memoryGraph.nodesReconsolidated', 'memoryGraph.bootstrapped',
                'memoryGraph.edgeCreated', 'memoryGraph.edgeDeleted', 'memoryGraph.reset',
                // Сменили чат: Ядро загрузило граф нового чата — перерисовываем (и сбрасываем выбранную ноду прежнего графа).
                'memoryGraph.loaded',
                // Новый ретрив (Этап 5) — `refresh()` заново подтягивает `memoryGraph.retrievals`; пока пользователь
                // "Live" (`retrievalHistoryIndex === null`), `currentRetrieval()` сам подхватит самую свежую запись
                // без отдельной логики здесь.
                'memoryGraph.retrieved',
            ].map(event => host.events.subscribe(event, () => {
                if (event === 'memoryGraph.loaded') { closeForm(); retrievalHistoryIndex.set(null); }
                refresh();
            })),
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
        effect(() => { nodes(); regions(); isCreating(); previewPosition(); formLabel(); colorMetricId(); sizeMode(); glowMode(); syncCytoscape(); });
        // Подсветка ретрива — отдельный эффект (не завязан на изменения самого графа): переключатель/история могут
        // поменяться без единого нового узла/региона, и наоборот — обычный `refresh()` не должен лишний раз дёргать
        // подсветку, если ни то ни другое не менялось (`syncCytoscape()` всё равно СНОВА применит её в конце, это
        // просто идемпотентно, не баг — но именно ЭТОТ эффект — источник обновления, когда меняются только они).
        effect(() => { retrievalOverlayEnabled(); retrievalHistoryIndex(); retrievalHistory(); panelVisible(); applyRetrievalOverlay(); ensureRouteAnimation(); });
        effect(() => { searchQuery(); showProtected(); showOrdinary(); showUnplaced(); showEdges(); minWeightThreshold(); applySearchFilters(); });
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
