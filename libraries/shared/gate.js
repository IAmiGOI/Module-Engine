/**
 * A Gate — a light connector between two bus Directors, checking rights on
 * a crossing (see ARCHITECTURE.md's "Директора vs Гейты"). NOT a resolver —
 * it never picks a supplier or decides timing itself; it only asks the
 * Rights Core "is this caller allowed to reach this contract" and, if so,
 * forwards straight through to `targetBus`.
 *
 * Checked on every delivery, not just at subscribe() time — a quarantine
 * applied mid-session must take effect immediately, even for an already
 * active repeating subscription (`when: { every: ... }`), not just for a
 * caller's next fresh subscribe() call.
 */
export function createGate(rightsCore, targetBus) {
    function subscribe(contract, options, callback) {
        const callerId = options?.callerId;
        const guardedCallback = result => {
            const decision = rightsCore.checkAccess(callerId, contract);
            if (!decision.allowed) { callback({ ok: false, error: { message: `Access denied: ${decision.reason}` } }); return; }
            callback(result);
        };
        const initialDecision = rightsCore.checkAccess(callerId, contract);
        if (!initialDecision.allowed) {
            callback({ ok: false, error: { message: `Access denied: ${initialDecision.reason}` } });
            return () => {};
        }
        return targetBus.subscribe(contract, options, guardedCallback);
    }

    // register() is a plain pass-through — a supplier registering itself is
    // guarded by the namespace-prefix rule (NAMING_PHILOSOPHY.md), a
    // separate mechanism, not by this Gate.
    function register(contract, handler, opts) {
        return targetBus.register(contract, handler, opts);
    }

    return { subscribe, register };
}
