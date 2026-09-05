import { render } from '../../cores/ui/diff.js';

/**
 * Generic "named-key -> own independently-lifecycled UI tree" registry —
 * the shared mechanism behind both Ядро UI для Engine (a fixed, small set
 * of named slots) and Ядро UI модулей (an unbounded registry, one per
 * currently-enabled module). Each key gets its OWN Final UI instance, built
 * fresh from `createFinalUi()` at mount time — sharing ONE Final UI across
 * keys would corrupt every tree involved: every `render()` call starts its
 * own path addressing at `[]` (the root), so two independent trees inside
 * the same Final UI's node map would silently overwrite each other's root
 * entry.
 */
export function createUiMountRegistry(createFinalUi) {
    const mounted = new Map(); // key -> { dispose, finalUi }

    /** Mounts `node` under `key`, tearing down whatever was there before first — a key only ever holds one tree at a time. Returns that key's fresh Final UI instance. */
    function mount(key, node) {
        unmount(key);
        const finalUi = createFinalUi();
        const dispose = render(node, finalUi.apply);
        mounted.set(key, { dispose, finalUi });
        return finalUi;
    }

    function unmount(key) {
        mounted.get(key)?.dispose();
        mounted.delete(key);
    }

    function unmountAll() {
        for (const { dispose } of mounted.values()) dispose();
        mounted.clear();
    }

    function isMounted(key) {
        return mounted.has(key);
    }

    function getFinalUi(key) {
        return mounted.get(key)?.finalUi;
    }

    /** Resolves once `key`'s own Final UI has actually finished applying every patch queued so far — mainly for tests/diagnostics. */
    function settled(key) {
        return mounted.get(key)?.finalUi.settled?.() ?? Promise.resolve();
    }

    function keys() {
        return [...mounted.keys()];
    }

    return { mount, unmount, unmountAll, isMounted, getFinalUi, settled, keys };
}
