// @ts-check
/**
 * Ядро UI — реактивные примитивы (CORES.md: "Ядро UI = примитивы:
 * реактивность, h()/DOM-диффинг"). Platform-agnostic — no DOM, no ST, no
 * network anywhere in this file; a Final UI Core (per platform) is the only
 * thing that ever touches a real rendering target (see cores/ui/tree.js and
 * cores/ui/diff.js for what actually gets handed to one).
 *
 * Synchronous dependency tracking: `computed()`/`effect()` read signals
 * through a single active-tracker stack — a signal read while some tracker
 * is active registers that tracker as a dependent; `set()` re-runs every
 * current dependent synchronously, no batching, no scheduler.
 */

/** @template [T=any] @typedef {import('./ui-types.js').Signal<T>} Signal */

/**
 * Текущий отслеживающий: `{ run, deps, owned, disposed }`. `deps` — множества подписчиков сигналов, прочитанных при
 * последнем запуске (перед новым запуском он из них выписывается); `owned` — computed(), созданные во время запуска
 * (при следующем запуске или уничтожении владельца они уничтожаются). Без этого каждый пересчёт оставлял прошлые
 * вложенные computed() подписанными навсегда: окно директора на каждое событие хода плодило новые, старые жили и
 * пересчитывались дальше — память вкладки росла до гигабайт, а лаг — с каждым ходом.
 * @type {{ run: () => void, deps: Set<Set<() => void>>, owned: any[], disposed: boolean } | null}
 */
let activeTracker = null;

function cleanup(tracker) {
    for (const dependents of tracker.deps) dependents.delete(tracker.run);
    tracker.deps.clear();
    for (const child of tracker.owned.splice(0)) disposeTracker(child);
}

function disposeTracker(tracker) {
    if (tracker.disposed) return;
    tracker.disposed = true;
    cleanup(tracker);
}

/**
 * A reactive value. `sig()` reads (and tracks, if called during a computed()/effect()); `sig.set(v)` / `sig.update(fn)` write; `sig.peek()` reads without tracking.
 *
 * @template T
 * @param {T} initialValue
 * @returns {Signal<T>}
 */
export function signal(initialValue) {
    let value = initialValue;
    /** @type {Set<() => void>} */
    const dependents = new Set();

    function read() {
        if (activeTracker && !activeTracker.disposed) {
            dependents.add(activeTracker.run);
            activeTracker.deps.add(dependents);
        }
        return value;
    }
    /** @param {T} next */
    read.set = next => {
        if (Object.is(value, next)) return;
        value = next;
        // Snapshot before iterating — a dependent re-running here may itself
        // synchronously subscribe a NEW dependent to this same signal (e.g. a
        // computed() re-evaluating and re-reading); mutating `dependents`
        // while iterating it would either skip or double-visit an entry.
        for (const dependent of [...dependents]) dependent();
    };
    /** @param {(current: T) => T} fn */
    read.update = fn => read.set(fn(value));
    read.peek = () => value;
    read.isSignal = true;
    return /** @type {Signal<T>} */ (read);
}

/**
 * A signal derived from other signals — re-evaluates only when a signal it actually read last time changes.
 * Created while another computed()/effect() runs, it belongs to that run and is disposed when the owner runs again.
 *
 * @template T
 * @param {() => T} fn
 * @returns {Signal<T>}
 */
export function computed(fn) {
    // До первого вычисления значения нет; сразу ниже `run()` кладёт настоящее — снаружи `undefined` не виден.
    const result = /** @type {Signal<T>} */ (/** @type {unknown} */ (signal(undefined)));
    const tracker = { run: () => {}, deps: new Set(), owned: [], disposed: false };
    tracker.run = () => {
        if (tracker.disposed) return;
        cleanup(tracker);
        const previousTracker = activeTracker;
        activeTracker = tracker;
        try { result.set(fn()); }
        finally { activeTracker = previousTracker; }
    };
    if (activeTracker) activeTracker.owned.push(tracker);
    tracker.run();
    /** @type {any} */ (result).dispose = () => disposeTracker(tracker);
    return result;
}

/**
 * Runs `fn` immediately, then again every time a signal it read changes.
 * Returns a dispose function — after calling it, `fn` never runs again
 * (a stale effect from a torn-down UI subtree must not keep firing).
 *
 * @param {() => void} fn
 * @returns {() => void}  Dispose.
 */
export function effect(fn) {
    // Эффект рендерера живёт, пока его не уничтожат явно, — во владение пересчёта он не берётся.
    const tracker = { run: () => {}, deps: new Set(), owned: [], disposed: false };
    tracker.run = () => {
        if (tracker.disposed) return;
        cleanup(tracker);
        const previousTracker = activeTracker;
        activeTracker = tracker;
        try { fn(); }
        finally { activeTracker = previousTracker; }
    };
    tracker.run();
    return () => disposeTracker(tracker);
}
