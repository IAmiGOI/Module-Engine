import { createGate } from './gate.js';

/**
 * Гейт для внешних запросов в интернет — a SEPARATE Gate from the regular
 * one (gate.js), not just another instance of it. Reaching the internet is
 * a categorically different risk (data can leave the user's machine
 * entirely), so it's checked as its own, separate grant
 * (`rightsCore.hasNetworkAccess()`) — not folded into the regular
 * per-contract `allowedContracts` check, and not implied by trust tier
 * (even `official` gets no automatic "all network allowed", see
 * cores/rights/index.js's own register() doc comment).
 *
 * Composes the regular Gate rather than duplicating its own logic — network
 * access is an ADDITIONAL check layered in front of it, checked both at
 * subscribe() time and on every delivery (same "a quarantine mid-session
 * must take effect immediately" discipline the regular Gate already has).
 *
 * `targetBus` MUST be a bus no non-network contract is ever registered on
 * (see engine.js's own `buses.network`) — otherwise a caller could reach
 * the exact same contract through the ordinary Шина сервисов accessor
 * instead, bypassing this check entirely. This Gate enforces the network
 * grant; keeping `http.*` off any OTHER bus is what makes that enforcement
 * actually mean something.
 */
export function createNetworkGate(rightsCore, targetBus) {
    const baseGate = createGate(rightsCore, targetBus);

    function denial(callerId) {
        return { ok: false, error: { message: `Access denied: "${callerId}" has no network access.` } };
    }

    function subscribe(contract, options, callback) {
        const callerId = options?.callerId;
        if (!rightsCore.hasNetworkAccess(callerId)) {
            callback(denial(callerId));
            return () => {};
        }
        const guardedCallback = result => {
            if (!rightsCore.hasNetworkAccess(callerId)) { callback(denial(callerId)); return; }
            callback(result);
        };
        return baseGate.subscribe(contract, options, guardedCallback);
    }

    return { subscribe, register: baseGate.register };
}
