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
const MAX_RADIUS = 240;

// --- Геометрия: региональная сетка ↔ экранные координаты (чистые функции) --

/**
 * Экранная позиция узла внутри его региона. `indexInRegion`/`countInRegion`
 * веерно разводят НЕСКОЛЬКО узлов одного региона по небольшому угловому
 * спреду внутри своей ячейки, чтобы они не легли друг на друга.
 */
export function regionLayoutPosition(sector, ring, { maxRadius = MAX_RADIUS, sectors = 5, rings = 3, indexInRegion = 0, countInRegion = 1 } = {}) {
    const sectorAngle = (2 * Math.PI) / sectors;
    const centerAngle = sector * sectorAngle + sectorAngle / 2 - Math.PI / 2; // сектор 0 начинается сверху
    const ringInner = (ring / rings) * maxRadius;
    const ringOuter = ((ring + 1) / rings) * maxRadius;
    const radius = (ringInner + ringOuter) / 2;
    const spread = sectorAngle * 0.7;
    const angleOffset = countInRegion > 1 ? (indexInRegion / (countInRegion - 1) - 0.5) * spread : 0;
    const angle = centerAngle + angleOffset;
    return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
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
        formLabel.set('');
        formContent.set('');
        formImportance.set(0);
        formProtected.set(false);
    }

    function closeForm() {
        selectedNodeId.set(null);
        isCreating.set(false);
        creatingAt.set(null);
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
                    position = regionLayoutPosition(sector, ring, { indexInRegion: index, countInRegion: members.length });
                }
                elements.push({
                    data: { id: node.id, label: node.label, degree: node.degree ?? 0, protectedNode: Boolean(node.protectedNode) },
                    position,
                });
            });
        }
        return elements;
    }

    async function ensureCytoscape() {
        if (cy) return cy;
        const container = document.getElementById(CANVAS_ID);
        if (!container) return null;
        const cytoscape = await loadCytoscape();
        cy = cytoscape({
            container,
            elements: [...nodeElements(), ...edgeElements()],
            layout: { name: 'preset' },
            style: [
                { selector: 'node', style: { label: 'data(label)', 'background-color': '#4a9eff', color: '#fff', 'font-size': 9, 'text-valign': 'bottom', 'text-margin-y': 4, width: 20, height: 20 } },
                { selector: 'node[?protectedNode]', style: { 'background-color': '#ffb454', 'border-width': 2, 'border-color': '#fff' } },
                { selector: 'edge', style: { width: 1.5, 'line-color': '#888', 'curve-style': 'bezier', label: 'data(type)', 'font-size': 7, color: '#aaa' } },
            ],
            wheelSensitivity: 0.2,
        });
        cy.on('tap', 'node', event => openEditForm(nodes().find(node => node.id === event.target.id())));
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
            if (isCreating()) creatingAt.set(pixelToRegion(event.position.x, event.position.y, {}));
            else closeForm();
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
        cy.add([...nodeElements(), ...edgeElements()]);
        cy.layout({ name: 'preset' }).run();
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
                onClose: () => { panelVisible.set(false); saveWindowState(); },
                drag: createDragHandlers(panelPosition, { onDrop: dropped => { panelPosition.set(clampToViewport(dropped, { width: panelSize.peek().width ?? 720, height: panelSize.peek().height ?? 560, viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })); saveWindowState(); } }),
                onResize: next => { panelSize.set(next); saveWindowState(); },
            },
            h('div', { class: 'stme-memory-graph-body', style: { display: 'flex', gap: '8px', minWidth: '680px', minHeight: '480px' } },
                h('div', {
                    id: CANVAS_ID,
                    style: { width: '480px', height: '480px', background: '#1a1a1a', borderRadius: '8px', flexShrink: '0' },
                }),
                h('div', { class: 'stme-memory-graph-sidebar', style: { flex: '1', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' } },
                    Row(
                        Button('+ Node', () => openCreateForm({ sector: 0, ring: 0 })),
                        Button('Refresh', refresh),
                    ),
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
        effect(() => { nodes(); regions(); syncCytoscape(); });
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
