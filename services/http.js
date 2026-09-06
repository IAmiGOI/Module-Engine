/**
 * Сервис HTTP — the real, single leaf implementation of "reach the
 * internet". Просто логический адаптер (ARCHITECTURE.md): no logic of its
 * own beyond making one real request — every decision (whether this caller
 * is even ALLOWED to reach the network at all) happens in
 * libraries/shared/network-gate.js, before this Сервис is ever reached.
 *
 * Registered on `buses.network` (engine.js), NEVER `buses.services` — that
 * separation is what makes the dedicated network Gate's check actually
 * mean something (see network-gate.js's own doc comment for the bypass
 * this closes).
 */
export function registerHttpService(networkBus, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    return networkBus.register('http.request', async ({ url, method = 'GET', headers, body }) => {
        const response = await fetchImpl(url, { method, headers, body });
        const text = await response.text();
        return {
            status: response.status,
            ok: response.ok,
            headers: Object.fromEntries(response.headers?.entries?.() ?? []),
            text,
        };
    }, { loadMetric: () => 0 });
}
