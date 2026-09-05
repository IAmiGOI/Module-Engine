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

let activeTracker = null;

/** A reactive value. `sig()` reads (and tracks, if called during a computed()/effect()); `sig.set(v)` / `sig.update(fn)` write; `sig.peek()` reads without tracking. */
export function signal(initialValue) {
    let value = initialValue;
    const dependents = new Set();

    function read() {
        if (activeTracker) dependents.add(activeTracker);
        return value;
    }
    read.set = next => {
        if (Object.is(value, next)) return;
        value = next;
        // Snapshot before iterating — a dependent re-running here may itself
        // synchronously subscribe a NEW dependent to this same signal (e.g. a
        // computed() re-evaluating and re-reading); mutating `dependents`
        // while iterating it would either skip or double-visit an entry.
        for (const dependent of [...dependents]) dependent();
    };
    read.update = fn => read.set(fn(value));
    read.peek = () => value;
    read.isSignal = true;
    return read;
}

/** A signal derived from other signals — re-evaluates only when a signal it actually read last time changes. */
export function computed(fn) {
    const result = signal(undefined);
    const recompute = () => {
        const previousTracker = activeTracker;
        activeTracker = recompute;
        try { result.set(fn()); }
        finally { activeTracker = previousTracker; }
    };
    recompute();
    return result;
}

/**
 * Runs `fn` immediately, then again every time a signal it read changes.
 * Returns a dispose function — after calling it, `fn` never runs again
 * (a stale effect from a torn-down UI subtree must not keep firing).
 */
export function effect(fn) {
    let disposed = false;
    const run = () => {
        if (disposed) return;
        const previousTracker = activeTracker;
        activeTracker = run;
        try { fn(); }
        finally { activeTracker = previousTracker; }
    };
    run();
    return () => { disposed = true; };
}
