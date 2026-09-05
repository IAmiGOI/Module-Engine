/**
 * The Event Bus — broadcast pub/sub, the one primitive every other bus's
 * `when` condition is built on top of (see ARCHITECTURE.md's Директор
 * section, PIPELINE.md's lifecycle events). Carries both translated native
 * ST events (a Service would emit them here) and dynamically-registered
 * custom events (any Core/Module can register+emit its own) — a subscriber
 * never distinguishes origin, both are just `emit(name, payload)`.
 */
export function createEventBus() {
    const listeners = new Map(); // eventName -> Set<callback>

    /** Fires every current subscriber for `eventName`. One throwing subscriber never stops the rest (see ARCHITECTURE.md's "Контракт на ошибки"). */
    function emit(eventName, payload) {
        for (const callback of [...(listeners.get(eventName) ?? [])]) {
            try { callback(payload); }
            catch (error) { console.error(`[event-bus] a subscriber to "${eventName}" threw:`, error); }
        }
    }

    /** Registers `callback` for every future `emit(eventName, ...)`. Returns an unsubscribe function. */
    function subscribe(eventName, callback) {
        const set = listeners.get(eventName) ?? new Set();
        set.add(callback);
        listeners.set(eventName, set);
        return () => { listeners.get(eventName)?.delete(callback); };
    }

    return { emit, subscribe };
}
