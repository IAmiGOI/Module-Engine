import { createSelfUpdateCore } from '../../cores/self-update/index.js';
import { createGuideCore } from '../../cores/guide/index.js';
import { deriveExtensionName } from '../../libraries/core/update-check.js';
import { createEnginePanelCore } from '../../cores/ui/engine-panel.js';
import { createHubCore } from '../../cores/ui/hub/index.js';
import { createUpdateOverlayCore } from '../../cores/ui/update-overlay.js';
import { createModuleRuntime } from '../module-runtime.js';
import { createModuleRegistry } from '../module-registry.js';
import { CORE_REPO } from './config.js';

/** Оболочка: самообновление, реестр Модулей (рантайм), гид, хаб и панель движка. Получает общий контекст сборки (`ctx`), возвращает то, что создал. */
export async function wireShell(ctx) {
    const { scriptUrl, engine, late, baseUrl, eventsCore, uiEngine, memoryGraphPanel, uiModules, chatViewport, inputBar, home } = ctx;

    // Самообновление: единственное Ядро, которому выдано право выходить в сеть
    // помимо моделей — оно сверяет наш код с GitHub напрямую.
    const selfUpdate = createSelfUpdateCore(
        engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official', networkAccess: true }),
        {
            extensionName: deriveExtensionName(scriptUrl),
            ...CORE_REPO,
            publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.selfUpdate' }),
        },
    );

    // Экран обновления: перекрытие страницы и полоса с «Retry». Про git не
    // знает ничего — только слушает объявления самообновления.
    const updateOverlay = createUpdateOverlayCore(
        engine.registerCaller('core.ui.updateOverlay', 'cores', { tier: 'official' }),
        { mount: node => uiEngine.mount('updateOverlay', node) },
    );

    const moduleStorageHost = engine.registerCaller('core.runner', 'cores', { tier: 'official' });
    const { runner: moduleRunner, installer: moduleInstaller, ready: moduleRunnerReady, rediscover: rediscoverModules } = createModuleRuntime({ engine, storageHost: moduleStorageHost });
    void moduleRunnerReady.then(() => { late.enginePanel?.refreshModules(); void late.hub?.refresh(); });
    const modules = createModuleRegistry({
        engine,
        uiModules,
        definitions: moduleRunner.definitions,
        ready: moduleRunnerReady,
        problems: moduleRunner.problems,
        installer: moduleInstaller,
        rediscover: rediscoverModules,
        panelSettled: () => late.panelUi?.settled() ?? Promise.resolve(),
        panelRoot: () => late.panelUi?.getRoot() ?? null,
        // Своя личность на Шине ядер: состав помнится через то же Ядро
        // сохранения, что и всё остальное, а не отдельным ходом в обход.
        storageHost: moduleStorageHost,
        onChanged: () => { late.enginePanel?.refreshModules(); void late.hub?.refresh(); },
    });

    // Гид — маскот движка и его отдельный чат (не чат ST): знакомство, объяснения, ссылки на блоки, действия. Файлы сценария и знаний —
    // в папке `guide/` расширения; Модули — через реестр (действия «включить/выключить»).
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.guide' }),
        mount: node => uiEngine.mount('guide', node),
        loadText: async path => { const response = await globalThis.fetch(new URL(`../guide/${path}`, baseUrl), { cache: 'no-cache' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); },
        modules,
    });

    // Хаб — обзор панели из блоков «как глифы» с живым статусом; формы блоков остаются DOM-карточками панели (cores/ui/hub/). Привязывается к панелям в index.js.
    const hub = createHubCore(engine.registerCaller('core.ui.hub', 'cores', { tier: 'official' }), { modules });
    late.hub = hub;

    // Экран движка — тоже Ядро (движок без интерфейса не работает, и
    // пользователь его не подключает). К моделям он ходит контрактами, а не
    // по JS-ссылке: править эндпоинты и ключи в обход Шины было бы ровно тем,
    // от чего Гейты и защищают.
    const enginePanel = createEnginePanelCore(engine.registerCaller('core.ui.panel', 'cores', { tier: 'official' }), {
        mount: node => uiEngine.mount('settings', node),
        // Второе дерево Ядра — экран настроек (пресеты + апдейты, решено с
        // пользователем) — монтируется СВОИМ ключом, иначе деревья
        // столкнулись бы в одной карте реестра монтирований.
        mountSettings: node => uiEngine.mount('settingsScreen', node),
        listContracts: () => [
            ...engine.buses.cores.contracts(),
            ...engine.buses.services.contracts(),
            ...engine.buses.network.contracts(),
        ],
        modules,
        openMemoryGraphPanel: () => memoryGraphPanel.show(),
        chatViewport,
        inputBar,
        home,
    });
    late.enginePanel = enginePanel;


    return { selfUpdate, updateOverlay, moduleStorageHost, moduleRunner, moduleInstaller, moduleRunnerReady, rediscoverModules, modules, guide, hub, enginePanel };
}
