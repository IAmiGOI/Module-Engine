import { request } from '../shared/request.js';
import { restoreSecrets } from './sync-settings.js';

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
    let watching = false;

    async function read() {
        const result = await request(host.own, 'storage.settings.get', { params: { namespace, key, fallback: [] } });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    }

    async function restore() {
        // Сначала вернуть ключи, стёртые перезаписью `settings.json` (копия в браузере, cores/settings): иначе список загрузится без ключа.
        await request(host.own, 'settings.secrets.heal', {}).catch(() => {});
        const value = await read();
        apply(value);
        watchApplied();
        return value;
    }

    /** Синк принял настройки этого раздела: перечитать список, иначе Ядро держало бы устаревший и потом записало бы его поверх принятого. */
    function watchApplied() {
        if (watching || typeof host.events?.subscribe !== 'function') return;
        watching = true;
        host.events.subscribe('settings.applied', payload => {
            if (Array.isArray(payload?.namespaces) && payload.namespaces.includes(namespace)) read().then(apply).catch(() => {});
        });
    }

    async function save(list) {
        apply(list);   // сразу и синхронно, как всегда: вызывающий не ждёт запись, чтобы увидеть новый список в памяти
        // Записываемый список не должен ронять ключ, который уже лежит в хранилище (устаревшая копия в памяти, список без поля):
        // отсутствующее поле берётся из хранилища, явно пустое — это решение человека, оно остаётся.
        let toWrite = list;
        try {
            const merged = restoreSecrets(list, await read());
            if (JSON.stringify(merged) !== JSON.stringify(list)) { toWrite = merged; apply(merged); }
        } catch { /* хранилище недоступно — пишем как есть */ }
        const result = await request(host.own, 'storage.settings.set', { params: { namespace, key, value: toWrite } });
        if (!result.ok) throw new Error(result.error.message);
    }

    return { restore, save };
}
