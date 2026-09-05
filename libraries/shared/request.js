/**
 * `request()` — the library sugar over `subscribe()` (ARCHITECTURE.md's
 * "Заказчик API"): subscribe once, resolve on the first delivery, always
 * auto-unsubscribe. NOT a bus primitive — this is exactly why the Шина
 * only needs to know `subscribe()` at all.
 *
 * `timeoutMs` is optional, for the "completion" condition-type only (see
 * ARCHITECTURE.md) — never a default. On timeout, resolves (never rejects)
 * with the same standard envelope any other failure uses — see "Контракт
 * на ошибки": nothing that crosses a bus boundary ever throws.
 */
export function request(bus, contract, { params, when, timeoutMs } = {}) {
    return new Promise(resolve => {
        let done = false;
        let timer = null;
        // `unsubscribe` starts as a no-op, not the real function bus.subscribe()
        // is about to return — a Гейт-denied call (or any bus that resolves
        // synchronously) invokes this very callback BEFORE subscribe() itself
        // returns, so referencing the real `unsubscribe` at that point would
        // hit it mid-initialization. The temporary no-op is harmless there —
        // nothing real is subscribed yet to tear down.
        let unsubscribe = () => {};
        unsubscribe = bus.subscribe(contract, { params, when }, result => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            unsubscribe();
            resolve(result);
        });
        if (timeoutMs) {
            timer = setTimeout(() => {
                if (done) return;
                done = true;
                unsubscribe();
                resolve({ ok: false, error: { message: `request(): "${contract}" timed out after ${timeoutMs}ms.` } });
            }, timeoutMs);
        }
    });
}
