import { createEngine } from '../libraries/shared/engine.js';
import { FIRST_LAUNCH_EVENT } from '../cores/first-load/index.js';
import { wireServices } from './wiring/services.js';
import { wireDataCores } from './wiring/data-cores.js';
import { wireUiCores } from './wiring/ui-cores.js';
import { wireShell } from './wiring/shell.js';
import { wireBoot } from './wiring/boot.js';

// Реестр и рантайм Модулей живут в своих файлах (harness/module-*.js), проводка — по слоям в harness/wiring/*.js. Реэкспорт — чтобы существующие импорты не менялись.
export { ENGINE_VERSION, BUILTIN_MODULES, createBuiltinRunner, createModuleRuntime } from './module-runtime.js';
export { createModuleRegistry } from './module-registry.js';
export { CORE_REPO, BACKGROUNDS_REPO } from './wiring/config.js';

/**
 * Wires one real `createEngine()` with every Core/Service built so far —
 * shared verbatim between the standalone browser harness
 * ([harness/main.js](main.js), fake ST context) and the real SillyTavern
 * entry point ([../index.js](../index.js), real ST context) so the two can
 * never drift apart. NOT the real Раннер from ARCHITECTURE.md/ROADMAP.md —
 * that still needs generic Module loading and a real semver/compatibility
 * gate; this is deliberately just enough hardcoded wiring to prove the
 * built Ядра/Сервисы actually run, in a browser and inside real ST.
 *
 * `getContext`/`fetch` are the only two things that differ between the
 * harness and real ST — everything else is identical.
 *
 * Async — `restoreWorkers()`/`restoreTrackers()`/`restorePrograms()` each
 * do a real `storage.settings.get` round trip so configuration genuinely
 * survives a reload (see [persisted-list.js](../libraries/core/persisted-list.js))
 * instead of resetting to empty every boot, which is what all three did
 * before Ядро сохранения existed.
 *
 * Тело разнесено по слоям — harness/wiring/: services → dataCores → uiCores → shell → boot. Каждый слой получает общий контекст `ctx` (всё,
 * что создано до него) и возвращает своё; порядок вызова ровно тот, что был в одной длинной функции, поэтому порядок запуска не менялся.
 */
// `fetch` по умолчанию ПРИВЯЗАН к глобальному объекту: браузерный `fetch`
// требует, чтобы `this` был окном, и вызов «голой» ссылки отвечает «Illegal
// invocation».
export async function wireEngine({ getContext, fetch = globalThis.fetch?.bind(globalThis), interceptTarget = globalThis, scriptUrl = import.meta.url }) {
    const engine = createEngine();
    // Ссылки, которые появляются ПОЗЖЕ, чем читаются (панель открывается в конце запуска, а реестр Модулей обращается к ней из колбэков).
    const late = { panelUi: null, enginePanel: null, hub: null };
    const ctx = { getContext, fetch, interceptTarget, scriptUrl, engine, late, baseUrl: import.meta.url };
    Object.assign(ctx, await wireServices(ctx));
    Object.assign(ctx, await wireDataCores(ctx));
    Object.assign(ctx, await wireUiCores(ctx));
    Object.assign(ctx, await wireShell(ctx));
    Object.assign(ctx, await wireBoot(ctx));

    const { musicServer, promptManagerCore, promptManagerPanel, modelsCore, trackingCore, macrosCore, lorebookCore, characterCardsCore, classifierCore, summaryCore, memoryGraphCore, memoryGraphPanel, picturePanel, eventsCore, generationCore, pipelineCore, uiEngine, uiModules, notifications, activityLight, glAnimations, backgrounds, syncCore, startup, messageFooter, chatViewport, inputBar, home, hub, selfUpdate, updateOverlay, modules, enginePanel, firstLoad, firstLoadResult, guide } = ctx;
    return { engine, FIRST_LAUNCH_EVENT, musicServer, promptManagerCore, promptManagerPanel, modelsCore, trackingCore, macrosCore, lorebookCore, characterCardsCore, classifierCore, summaryCore, memoryGraphCore, memoryGraphPanel, picturePanel, eventsCore, generationCore, pipelineCore, uiEngine, uiModules, notifications, activityLight, glAnimations, backgrounds, syncCore, startup, messageFooter, chatViewport, inputBar, home, hub, selfUpdate, updateOverlay, modules, enginePanel, panelUi: late.panelUi, firstLoad, firstLoadResult, guide };
}
