/**
 * Обёртка над Cytoscape.js — рендер графа памяти как настоящего интерактивного
 * канваса (узлы/рёбра, драг, клики), не самодельный SVG/Canvas-движок с нуля
 * (решено с пользователем явно — см. MEMORY_GRAPH.md, "UI графа"). Тот же
 * приём, что у `embedding.js`: ленивая загрузка с CDN, промис кэшируется в
 * модульной переменной, `importer` — точка подмены для тестов.
 *
 * `cytoscape-edgehandles` — плагин "тяни от узла к узлу — создаёшь ребро",
 * закрывает требование "редактирование связей" готовым, проверенным
 * взаимодействием вместо самодельного drag-to-connect.
 */

const CYTOSCAPE_CDN_URL = 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/+esm';
const EDGEHANDLES_CDN_URL = 'https://cdn.jsdelivr.net/npm/cytoscape-edgehandles@4.0.1/+esm';

let libraryPromise = null;

/** Подменяемо тестами — реальный импорт бьёт только по этой функции. */
export async function loadCytoscapeModules(importer = { cytoscape: () => import(/* webpackIgnore: true */ CYTOSCAPE_CDN_URL), edgehandles: () => import(/* webpackIgnore: true */ EDGEHANDLES_CDN_URL) }) {
    const [cytoscapeModule, edgehandlesModule] = await Promise.all([importer.cytoscape(), importer.edgehandles()]);
    return { cytoscape: cytoscapeModule.default, edgehandles: edgehandlesModule.default };
}

/**
 * Регистрирует `edgehandles` в cytoscape РОВНО ОДИН РАЗ (повторный
 * `cytoscape.use()` того же плагина — не ошибка сама по себе, но незачем
 * дёргать его при каждом открытии окна) и отдаёт готовый конструктор.
 */
export async function loadCytoscape({ importer } = {}) {
    if (!libraryPromise) {
        libraryPromise = loadCytoscapeModules(importer).then(({ cytoscape, edgehandles }) => {
            cytoscape.use(edgehandles);
            return cytoscape;
        });
    }
    return libraryPromise;
}

/** Сброс кэша — только для тестов. */
export function resetGraphRenderingCache() {
    libraryPromise = null;
}
