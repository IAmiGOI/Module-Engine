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
        // `!done`: a synchronously-resolved subscribe() (a Гейт denial, or
        // any bus answering immediately) already settled the promise above,
        // in the very same call — arming a timer AFTER that would be pure
        // waste, and a real one at that: `setTimeout` keeps the event loop
        // alive for its own full `timeoutMs`, even though its callback is a
        // guaranteed no-op (`done` is already true). Caught by a whole test
        // suite silently taking `timeoutMs` longer than it should whenever
        // one denied request happened to carry a timeout.
        if (timeoutMs && !done) {
            timer = setTimeout(() => {
                if (done) return;
                done = true;
                unsubscribe();
                resolve({ ok: false, error: { message: `request(): "${contract}" timed out after ${timeoutMs}ms.` } });
            }, timeoutMs);
        }
    });
}
