import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';

/**
 * Ядро UI для Engine — the engine's own chrome (CORES.md: settings drawer,
 * module browser, diagnostics). Distinguishing shape from Ядро UI модулей:
 * a small, FIXED set of **named slots** — one independently mount/
 * unmount-able surface each, the engine's own UI is never more than these
 * few known pieces (unlike Ядро UI модулей's unbounded, one-per-enabled-
 * module registry).
 *
 * Both Ядра share the exact same underlying mechanism
 * (libraries/shared/ui-mount-registry.js) — kept as separate, thin Core
 * files rather than one, since each is a genuinely distinct architectural
 * concept (CORES.md) free to grow its own domain-specific behavior later
 * without the two needing to awkwardly diverge from a shared base.
 */
export function createUiEngineCore(createFinalUi) {
    return createUiMountRegistry(createFinalUi);
}
