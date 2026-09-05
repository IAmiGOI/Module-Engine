import { request } from '../shared/request.js';

/**
 * Bridges an in-memory "configureX(list)" setter to real persistence via
 * `storage.settings` — closes the "config resets on reload" stub every
 * `configureX()`-shaped Core (models/tracking/macros) has carried since
 * before Ядро сохранения existed (see each Core's own doc comment history).
 *
 * `apply(list)` is the Core's OWN existing logic for "adopt this list into
 * my in-memory state" (rebuilding a dispatch pool, re-subscribing triggers,
 * whatever that Core already does) — this file never touches that shape,
 * only read/write timing. `restore()` is called ONCE, explicitly, by
 * whoever assembles the engine (see harness/engine-wiring.js) — not
 * self-triggered inside the Core's own constructor, which would race
 * against a caller's own `configureX()` call happening before the async
 * read resolves.
 */
export function createPersistedList(host, { namespace, key, apply }) {
    async function restore() {
        const result = await request(host.own, 'storage.settings.get', { params: { namespace, key, fallback: [] } });
        if (!result.ok) throw new Error(result.error.message);
        apply(result.value);
        return result.value;
    }

    async function save(list) {
        apply(list);
        const result = await request(host.own, 'storage.settings.set', { params: { namespace, key, value: list } });
        if (!result.ok) throw new Error(result.error.message);
    }

    return { restore, save };
}
