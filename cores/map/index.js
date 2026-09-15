import { request } from '../../libraries/shared/request.js';
import {
    sanitizeSettings, sanitizeNodeInput, sanitizeEdgeInput,
    wouldCreateCycle, findAdjacentNodeIds, findNodesWithinDistance, computeDistanceBetweenNodes,
    resolveEdgeDistance, computeTravelTimeMinutes, findRoutes, buildContainmentPath,
} from '../../libraries/core/map-graph.js';

const SETTINGS_NAMESPACE = 'core.map';
const GRAPH_KEY = 'graph';
const SETTINGS_KEY = 'settings';
const ROOT_IMAGE_KEY = 'rootImage';
const CHAT_NAMESPACE = 'core.map';
const POSITION_KEY = 'position';
const MOVEMENT_LOG_KEY = 'movementLog';
const MOVEMENT_LOG_LIMIT = 500;

function generateId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ядро карты локаций (CORES.md, MAP.md) — вся тяжесть намеренно здесь, не в
 * будущем Модуле-редакторе: узлы/рёбра/pathfinding/дистанция/время/лог
 * перемещений — контракты этого Ядра, Модуль (когда появится) будет только
 * тонкой UI-обвязкой поверх них. См. [[feedback-engine-vs-module-depth]] —
 * прямое требование владельца "движок делает максимум работы".
 *
 * **Карта — данные мира, не чата** (`storage.settings`, как Lorebook): узлы,
 * рёбра и настройки масштаба общие для всех чатов, использующих этот мир.
 * **Текущая позиция и лог перемещений — ПЕР ЧАТ** (`storage.chatMemory`,
 * как `cast` у Ядра определения говорящего) — разные истории обычно
 * находятся в разных точках одного и того же мира одновременно.
 *
 * **Контейнмент vs смежность.** `node.parentId` — вложенность (дерево,
 * произвольная глубина, никакой фиксированной схемы уровней — 7 пунктов
 * "Страна...Помещение" это ТОЛЬКО дефолтные подсказки будущего UI, не часть
 * этой схемы данных). Рёбра в `edges` — смежность ("можно дойти пешком"),
 * либо авто-созданные при касании границ полигонов
 * (`findAdjacentNodeIds()`), либо явно добавленные (`map.edges.create`,
 * умеет мостить два РАЗНЫХ локальных пространства координат через
 * `distanceOverrideUnits` — единственный способ соединить, например, комнату
 * в одном здании с районным узлом напрямую).
 *
 * **`map.pathfind` не объявляет триаду** started/completed/failed — по
 * критерию из ARCHITECTURE.md триада нужна только реальной непредсказуемой
 * по длительности асинхронной работе (сеть, LLM); поиск маршрута — чистый
 * синхронный расчёт над уже загруженным графом, поэтому только одно
 * событие-факт `map.pathfind.performed`, для наблюдаемости (требование
 * "максимум ивентов"), не для ожидания результата.
 *
 * **`graphRegionId` (item 7) намеренно ничего не делает здесь** — поле
 * зарезервировано в `sanitizeNodeInput()` под будущую привязку узла карты к
 * региону Ядра графа памяти (MEMORY_GRAPH.md), это отдельный заход.
 */
export function createMapCore(host, { publish } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let nodes = {};
    let edges = {};
    let settings = sanitizeSettings({});
    /** `null` = no image uploaded yet; otherwise `{ assetId, width, height }` — the ONLY thing this Core knows about the image, never the bytes (see doc-comment "rootImage" below). */
    let rootImage = null;

    async function saveGraph() {
        await request(host.own, 'storage.settings.set', { params: { namespace: SETTINGS_NAMESPACE, key: GRAPH_KEY, value: { nodes, edges } } });
    }

    async function saveSettings() {
        await request(host.own, 'storage.settings.set', { params: { namespace: SETTINGS_NAMESPACE, key: SETTINGS_KEY, value: settings } });
    }

    async function saveRootImage() {
        await request(host.own, 'storage.settings.set', { params: { namespace: SETTINGS_NAMESPACE, key: ROOT_IMAGE_KEY, value: rootImage } });
    }

    async function loadGraph() {
        const graphResult = await request(host.own, 'storage.settings.get', { params: { namespace: SETTINGS_NAMESPACE, key: GRAPH_KEY, fallback: null } });
        if (graphResult.ok && graphResult.value) {
            nodes = graphResult.value.nodes ?? {};
            edges = graphResult.value.edges ?? {};
        }
        const settingsResult = await request(host.own, 'storage.settings.get', { params: { namespace: SETTINGS_NAMESPACE, key: SETTINGS_KEY, fallback: null } });
        settings = sanitizeSettings(settingsResult.ok && settingsResult.value ? settingsResult.value : {});
        const rootImageResult = await request(host.own, 'storage.settings.get', { params: { namespace: SETTINGS_NAMESPACE, key: ROOT_IMAGE_KEY, fallback: null } });
        rootImage = rootImageResult.ok ? (rootImageResult.value ?? null) : null;
    }

    async function readPosition() {
        const result = await request(host.own, 'storage.chatMemory.get', { params: { namespace: CHAT_NAMESPACE, key: POSITION_KEY, fallback: null } });
        return result.ok ? (result.value ?? null) : null;
    }

    async function writePosition(value) {
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: CHAT_NAMESPACE, key: POSITION_KEY, value } });
    }

    async function readMovementLog() {
        const result = await request(host.own, 'storage.chatMemory.get', { params: { namespace: CHAT_NAMESPACE, key: MOVEMENT_LOG_KEY, fallback: null } });
        return result.ok && Array.isArray(result.value) ? result.value : [];
    }

    async function appendMovementLog(entry) {
        const log = await readMovementLog();
        const next = [...log, entry].slice(-MOVEMENT_LOG_LIMIT);
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: CHAT_NAMESPACE, key: MOVEMENT_LOG_KEY, value: next } });
        return next;
    }

    function listNodes() {
        return Object.entries(nodes).map(([id, node]) => ({ id, ...node }));
    }

    function listEdges(nodeId) {
        const all = Object.entries(edges).map(([id, edge]) => ({ id, ...edge }));
        return nodeId ? all.filter(edge => edge.fromId === nodeId || edge.toId === nodeId) : all;
    }

    /**
     * Re-runs auto-adjacency for `nodeId` against its CURRENT siblings and
     * reconciles auto edges — removes stale ones no longer qualifying, adds
     * newly-qualifying ones. Never touches manually-added edges. Two
     * independent ways a pair can qualify, unioned: polygon borders actually
     * touching (`findAdjacentNodeIds()`) OR — when
     * `settings.autoConnectDistanceUnits` is set — real-world proximity
     * (`findNodesWithinDistance()`), for owners who don't want to draw full
     * region borders everywhere (ROADMAP.md 5.50).
     */
    async function reconcileAutoEdges(nodeId) {
        const created = [];
        const removed = [];
        const shouldTouch = new Set([
            ...findAdjacentNodeIds(nodes, nodeId),
            ...findNodesWithinDistance(nodes, settings, nodeId, settings.autoConnectDistanceUnits),
        ]);
        for (const [edgeId, edge] of Object.entries(edges)) {
            if (!edge.auto) continue;
            const otherId = edge.fromId === nodeId ? edge.toId : (edge.toId === nodeId ? edge.fromId : null);
            if (otherId == null) continue;
            if (!shouldTouch.has(otherId)) {
                delete edges[edgeId];
                removed.push(edgeId);
            } else {
                shouldTouch.delete(otherId);
            }
        }
        for (const otherId of shouldTouch) {
            const edgeId = generateId('edge');
            // `id` stored ON the value (not just as the object key) — the
            // Library's findRoutes()/buildTraversalGraph() reads `edge.id`
            // off each value (Object.values(edges)) to build path edgeIds;
            // a value missing it silently produced `edgeIds: [null]` on
            // every route (caught live in the browser harness — no test
            // fixture ever omitted `id`, since `sanitizeEdgeInput()` doesn't
            // set it, only the Core is supposed to, and this one call site
            // didn't).
            edges[edgeId] = { id: edgeId, ...sanitizeEdgeInput({ fromId: nodeId, toId: otherId, auto: true }) };
            created.push(edgeId);
        }
        return { created, removed };
    }

    async function createNode(params = {}) {
        if (params.parentId && !nodes[params.parentId]) throw new Error(`map.nodes.create: unknown parentId "${params.parentId}".`);
        const sanitized = sanitizeNodeInput(params);
        if (!sanitized.name) throw new Error('map.nodes.create: "name" is required.');
        const id = generateId('node');
        const now = Date.now();
        nodes[id] = { ...sanitized, createdAt: now, updatedAt: now };
        // Always reconciled, not just when a polygon exists — distance-based
        // auto-connect (`autoConnectDistanceUnits`) applies to plain markers
        // too, unlike border-touch adjacency which needs a polygon on both sides.
        const { created, removed } = await reconcileAutoEdges(id);
        await saveGraph();
        publishEvent('map.node.created', { id, node: nodes[id] });
        for (const edgeId of created) publishEvent('map.edge.created', { id: edgeId, edge: edges[edgeId] });
        for (const edgeId of removed) publishEvent('map.edge.removed', { id: edgeId });
        return { id, ...nodes[id] };
    }

    async function updateNode({ id, ...patch } = {}) {
        if (!nodes[id]) throw new Error(`map.nodes.update: unknown node "${id}".`);
        if (patch.parentId !== undefined && patch.parentId && wouldCreateCycle(nodes, id, patch.parentId)) {
            throw new Error(`map.nodes.update: setting parentId to "${patch.parentId}" would make "${id}" its own ancestor.`);
        }
        if (patch.parentId !== undefined && patch.parentId && !nodes[patch.parentId]) {
            throw new Error(`map.nodes.update: unknown parentId "${patch.parentId}".`);
        }
        nodes[id] = { ...sanitizeNodeInput(patch, nodes[id]), createdAt: nodes[id].createdAt, updatedAt: Date.now() };
        const { created, removed } = await reconcileAutoEdges(id);
        await saveGraph();
        publishEvent('map.node.updated', { id, node: nodes[id] });
        for (const edgeId of created) publishEvent('map.edge.created', { id: edgeId, edge: edges[edgeId] });
        for (const edgeId of removed) publishEvent('map.edge.removed', { id: edgeId });
        return { id, ...nodes[id] };
    }

    /** Cascades to every descendant (containment tree) and every edge touching any of them — a location is meaningless once its container is gone. */
    async function removeNode({ id } = {}) {
        if (!nodes[id]) throw new Error(`map.nodes.remove: unknown node "${id}".`);
        const toRemove = new Set([id]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const [nodeId, node] of Object.entries(nodes)) {
                if (!toRemove.has(nodeId) && node.parentId && toRemove.has(node.parentId)) { toRemove.add(nodeId); grew = true; }
            }
        }
        const removedEdgeIds = Object.entries(edges).filter(([, edge]) => toRemove.has(edge.fromId) || toRemove.has(edge.toId)).map(([edgeId]) => edgeId);
        for (const edgeId of removedEdgeIds) delete edges[edgeId];
        for (const nodeId of toRemove) delete nodes[nodeId];
        await saveGraph();
        for (const edgeId of removedEdgeIds) publishEvent('map.edge.removed', { id: edgeId });
        for (const nodeId of toRemove) publishEvent('map.node.removed', { id: nodeId });
        return true;
    }

    async function createEdge(params = {}) {
        const { fromId, toId } = params;
        if (!nodes[fromId] || !nodes[toId]) throw new Error('map.edges.create: both "fromId" and "toId" must be existing nodes.');
        const sanitized = sanitizeEdgeInput({ ...params, auto: false });
        if (resolveEdgeDistance(nodes, settings, sanitized) == null) {
            throw new Error('map.edges.create: nodes do not share a local coordinate space — provide "distanceOverrideUnits" for a manual cross-map edge.');
        }
        const id = generateId('edge');
        edges[id] = { id, ...sanitized };
        await saveGraph();
        publishEvent('map.edge.created', { id, edge: edges[id] });
        return { id, ...edges[id] };
    }

    async function updateEdge({ id, ...patch } = {}) {
        if (!edges[id]) throw new Error(`map.edges.update: unknown edge "${id}".`);
        edges[id] = { id, ...sanitizeEdgeInput(patch, edges[id]) };
        await saveGraph();
        publishEvent('map.edge.updated', { id, edge: edges[id] });
        return { id, ...edges[id] };
    }

    async function removeEdge({ id } = {}) {
        if (!edges[id]) throw new Error(`map.edges.remove: unknown edge "${id}".`);
        delete edges[id];
        await saveGraph();
        publishEvent('map.edge.removed', { id });
        return true;
    }

    async function updateSettings(patch = {}) {
        const previousDistanceThreshold = settings.autoConnectDistanceUnits;
        settings = sanitizeSettings({ ...settings, ...patch });
        await saveSettings();
        publishEvent('map.settings.changed', { settings });
        // The threshold affects EVERY node's auto edges at once, not just
        // whichever one is next created/edited — reconcile the whole graph
        // now rather than leaving stale/missing auto edges until each node
        // happens to be touched again.
        if (settings.autoConnectDistanceUnits !== previousDistanceThreshold) {
            for (const nodeId of Object.keys(nodes)) {
                const { created, removed } = await reconcileAutoEdges(nodeId);
                for (const edgeId of created) publishEvent('map.edge.created', { id: edgeId, edge: edges[edgeId] });
                for (const edgeId of removed) publishEvent('map.edge.removed', { id: edgeId });
            }
            await saveGraph();
        }
        return settings;
    }

    /**
     * The root map's image is stored as bytes in the `image.*` Service
     * (IndexedDB, [services/image-store.js](../../services/image-store.js)),
     * NOT here — this Core only remembers WHICH asset id is current plus its
     * pixel dimensions (needed to interpret nodes' normalized 0..1
     * coordinates against it). Uploading/fetching the actual bytes is UI-side
     * work (drag-and-drop, `createImageBitmap` for dimensions) — the Модуль
     * calls `image.put` itself, THEN tells this Core the resulting id via
     * `map.rootImage.set`, mirroring how the Music Модуль already owns its
     * own audio bytes through the same kind of Service directly (see
     * [[feedback-engine-vs-module-depth]] — the "engine does the max work"
     * rule stops at bytes a Core has no way to interpret anyway; the Core
     * still owns the one thing that DOES matter to pathfinding/geometry: the
     * dimensions and which asset is authoritative right now).
     */
    async function setRootImage({ assetId, width, height } = {}) {
        if (!assetId) throw new Error('map.rootImage.set: "assetId" is required.');
        if (!(Number(width) > 0) || !(Number(height) > 0)) throw new Error('map.rootImage.set: "width"/"height" must be positive numbers.');
        rootImage = { assetId: String(assetId), width: Number(width), height: Number(height) };
        await saveRootImage();
        publishEvent('map.rootImage.changed', { rootImage });
        return rootImage;
    }

    async function clearRootImage() {
        rootImage = null;
        await saveRootImage();
        publishEvent('map.rootImage.changed', { rootImage: null });
        return true;
    }

    function pathfind({ fromId, toId, maxRoutes } = {}) {
        const result = findRoutes(nodes, edges, settings, { fromId, toId, maxRoutes });
        publishEvent('map.pathfind.performed', { fromId, toId, routeCount: result.routes.length, reason: result.reason });
        return result;
    }

    function distance({ fromId, toId } = {}) {
        if (!nodes[fromId] || !nodes[toId]) return { distanceUnits: null, timeMinutes: null, reason: 'unknown-node' };
        const distanceUnits = computeDistanceBetweenNodes(nodes, settings, fromId, toId);
        return { distanceUnits, timeMinutes: computeTravelTimeMinutes(distanceUnits, settings), reason: distanceUnits == null ? 'different-local-map' : null };
    }

    /** Direct placement (teleport/initial spawn) — no route required, no movement-log entry (nothing was "traveled"), just a hard position write. */
    async function setPosition({ nodeId } = {}) {
        if (!nodes[nodeId]) throw new Error(`map.position.set: unknown node "${nodeId}".`);
        const position = { nodeId, updatedAt: Date.now() };
        await writePosition(position);
        publishEvent('map.position.changed', { position, via: 'set' });
        return position;
    }

    function getPosition() {
        return readPosition();
    }

    /** Real movement — requires an actual route from the CURRENT position; a disconnected/abstract-only destination is refused (use `map.position.set` for an explicit teleport instead). */
    async function move({ toId, routeIndex = 0 } = {}) {
        if (!nodes[toId]) throw new Error(`map.position.move: unknown node "${toId}".`);
        const current = await readPosition();
        if (!current) throw new Error('map.position.move: no current position set — call "map.position.set" first.');
        const { routes, reason } = findRoutes(nodes, edges, settings, { fromId: current.nodeId, toId, maxRoutes: routeIndex + 1 });
        const route = routes[routeIndex];
        if (!route) throw new Error(`map.position.move: no route from "${current.nodeId}" to "${toId}" (${reason ?? 'route index out of range'}).`);

        const position = { nodeId: toId, updatedAt: Date.now() };
        await writePosition(position);
        const logEntry = {
            fromId: current.nodeId, toId, nodeIds: route.nodeIds, edgeIds: route.edgeIds,
            distanceUnits: route.totalDistanceUnits, timeMinutes: route.totalTimeMinutes, at: position.updatedAt,
        };
        const log = await appendMovementLog(logEntry);
        publishEvent('map.position.changed', { position, via: 'move', route });
        publishEvent('map.movementLog.appended', { entry: logEntry, count: log.length });
        return { position, route };
    }

    async function movementLogList({ limit } = {}) {
        const log = await readMovementLog();
        return limit ? log.slice(-Math.max(0, Number(limit) || 0)) : log;
    }

    async function movementLogClear() {
        await request(host.own, 'storage.chatMemory.set', { params: { namespace: CHAT_NAMESPACE, key: MOVEMENT_LOG_KEY, value: [] } });
        publishEvent('map.movementLog.cleared', {});
        return true;
    }

    const unregisters = [
        host.own.register('map.nodes.list', () => listNodes()),
        host.own.register('map.nodes.get', ({ id } = {}) => (nodes[id] ? { id, ...nodes[id] } : null)),
        host.own.register('map.nodes.create', params => createNode(params)),
        host.own.register('map.nodes.update', params => updateNode(params)),
        host.own.register('map.nodes.remove', params => removeNode(params)),
        host.own.register('map.nodes.containmentPath', ({ id } = {}) => buildContainmentPath(nodes, id)),
        host.own.register('map.edges.list', params => listEdges(params?.nodeId)),
        host.own.register('map.edges.create', params => createEdge(params)),
        host.own.register('map.edges.update', params => updateEdge(params)),
        host.own.register('map.edges.remove', params => removeEdge(params)),
        host.own.register('map.settings.get', () => settings),
        host.own.register('map.settings.update', params => updateSettings(params)),
        host.own.register('map.rootImage.get', () => rootImage),
        host.own.register('map.rootImage.set', params => setRootImage(params)),
        host.own.register('map.rootImage.clear', () => clearRootImage()),
        host.own.register('map.pathfind', params => pathfind(params)),
        host.own.register('map.distance', params => distance(params)),
        host.own.register('map.position.get', () => getPosition()),
        host.own.register('map.position.set', params => setPosition(params)),
        host.own.register('map.position.move', params => move(params)),
        host.own.register('map.movementLog.list', params => movementLogList(params)),
        host.own.register('map.movementLog.clear', () => movementLogClear()),
    ];

    return {
        /** Explicit startup hook, same discipline as the other persisted Ядра — called once by whoever assembles the engine, after storage is wired. */
        async restore() {
            await loadGraph();
        },
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}
