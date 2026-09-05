import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';

/**
 * Ядро UI модулей — per-module content UI (CORES.md), unbounded: one
 * independently mount/unmount-able tree per currently-ENABLED module, tied
 * to that module's own enable()/disable() lifecycle — unlike Ядро UI для
 * Engine's small, fixed set of named slots. Same underlying mechanism
 * (libraries/shared/ui-mount-registry.js), module-lifecycle-flavored
 * naming on top: `enable`/`disable` read as exactly what a module author
 * (and the engine's own module registry) actually calls this for.
 */
export function createUiModulesCore(createFinalUi) {
    const registry = createUiMountRegistry(createFinalUi);
    return {
        enable: (moduleId, node) => registry.mount(moduleId, node),
        disable: moduleId => registry.unmount(moduleId),
        disableAll: () => registry.unmountAll(),
        isEnabled: moduleId => registry.isMounted(moduleId),
        getFinalUi: moduleId => registry.getFinalUi(moduleId),
        settled: moduleId => registry.settled(moduleId),
        enabledModuleIds: () => registry.keys(),
    };
}
