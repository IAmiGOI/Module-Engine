// @ts-check
import { createEventBus } from './event-bus.js';
import { applyDeliveryFilters } from './delivery-filters.js';

/** @typedef {import('./bus-types.js').ContractBus} ContractBus */
/** @typedef {import('./bus-types.js').EventBus} EventBus */
/** @typedef {import('./bus-types.js').ContractHandler} ContractHandler */
/** @typedef {import('./bus-types.js').RegisterOptions} RegisterOptions */
/** @typedef {import('./bus-types.js').SubscribeOptions} SubscribeOptions */
/** @typedef {import('./bus-types.js').DeliveryCallback} DeliveryCallback */
/** @typedef {import('./bus-types.js').Envelope} Envelope */
/** @typedef {{ handler: ContractHandler, loadMetric?: () => number }} Supplier */

/**
 * Shared shape for the Module/Core/Service buses (ARCHITECTURE.md) — a
 * supplier `register()`s against a contract name; a consumer `subscribe()`s
 * with an optional `when` condition gating WHEN delivery happens. This is
 * the ONE real primitive a bus knows (see "Заказчик API — подтверждено") —
 * `request()`-style one-shot waiting is library sugar built on top of THIS
 * subscribe(), not part of the bus itself.
 *
 * `when` shapes (see PIPELINE.md for the concrete cases these serve):
 *   undefined            — deliver once, immediately (what a `request()`
 *                           helper subscribes with, then auto-unsubscribes).
 *   { event }             — redeliver every time that named Event Bus event
 *                            fires (completion-style waiting, e.g. Post-Turn).
 *   { every: { event, count } } — redeliver every Nth occurrence of that event
 *                                 (e.g. Tracker's "every N turns").
 *   { every: { ms } }     — redeliver on a real timer (e.g. "every N minutes").
 *
 * Modifiers, combinable with the `{ event }` form — all of them exist so a
 * Ядро/Модуль never writes this bookkeeping itself:
 *   { event, every: N }      — shorthand for `{ every: { event, count: N } }`.
 *   { event, debounceMs }    — collapse a burst, deliver once it goes quiet.
 *   { event, throttleMs }    — at most one delivery per interval.
 *   { event, dedupe: true }  — skip an event whose payload repeats the last one.
 *   { event, once: true }    — deliver once, then unsubscribe automatically.
 *
 * Test-double simplification: picks the least-loaded registered supplier for
 * a contract via its own declared `loadMetric()` — real Director sophistication
 * (rights/Gates) belongs to the eventual production bus, not this fake.
 *
 * @param {EventBus} [eventBus]  Шина событий, на которой строятся условия `when` (по умолчанию своя).
 * @returns {ContractBus}
 */
export function createContractBus(eventBus = createEventBus()) {
    /** @type {Map<string, Supplier[]>} contract -> поставщики */
    const suppliers = new Map();

    /**
     * Registers `handler(params)` as a supplier of `contract`. Returns an unregister function.
     *
     * @param {string} contract
     * @param {ContractHandler} handler
     * @param {RegisterOptions} [options]
     * @returns {() => void}
     */
    function register(contract, handler, { loadMetric } = {}) {
        const list = suppliers.get(contract) ?? [];
        /** @type {Supplier} */
        const entry = { handler, loadMetric };
        list.push(entry);
        suppliers.set(contract, list);
        return () => {
            const current = suppliers.get(contract);
            if (!current) return;
            const index = current.indexOf(entry);
            if (index >= 0) current.splice(index, 1);
        };
    }

    /**
     * @param {string} contract
     * @returns {Supplier | null}
     */
    function pickSupplier(contract) {
        const list = suppliers.get(contract);
        if (!list?.length) return null;
        return [...list].sort((a, b) => (a.loadMetric?.() ?? 0) - (b.loadMetric?.() ?? 0))[0];
    }

    /**
     * Resolves `contract` once against its current best supplier — never
     * throws, always the standard envelope (see ARCHITECTURE.md's "Контракт
     * на ошибки"). `priority` rides alongside `callerId` in the same `meta`
     * object — opt-in, declared by the CALLER at this one call (see
     * request.js's doc-comment for why this specific field is a call-site
     * flag rather than a contract-registration property); a handler that
     * doesn't care about it (almost all of them) just never reads `meta.priority`.
     *
     * @param {string} contract
     * @param {any} params
     * @param {string | undefined} callerId
     * @param {string | undefined} priority
     * @returns {Promise<Envelope>}
     */
    async function resolve(contract, params, callerId, priority) {
        const supplier = pickSupplier(contract);
        if (!supplier) return { ok: false, error: { message: `No supplier registered for contract "${contract}".` } };
        try {
            // Второй аргумент — ЛИЧНОСТЬ спрашивающего, а не данные. Поставщику,
            // который что-то регистрирует ОТ ИМЕНИ вызывающего (реестр этапов
            // пайплайна), нельзя брать владельца из params: их пишет сам
            // вызывающий, и подделать чужое имя было бы тривиально. Директор —
            // единственный, кто знает настоящего отправителя.
            const stats = /** @type {{ __stmeBusStats?: Record<string, { n: number, ms: number, max: number }> }} */ (globalThis).__stmeBusStats;   // диагностика: включается из консоли `globalThis.__stmeBusStats = {}` — время ожидания по контрактам
            const started = stats ? performance.now() : 0;
            const value = await supplier.handler(params, { callerId, priority });
            if (stats) { const row = (stats[contract] ??= { n: 0, ms: 0, max: 0 }); const took = performance.now() - started; row.n += 1; row.ms += took; row.max = Math.max(row.max, took); }
            return { ok: true, value };
        } catch (error) {
            return { ok: false, error: { message: /** @type {any} */ (error)?.message ?? String(error) } };
        }
    }

    /**
     * The bus's one real primitive. Returns an unsubscribe function.
     *
     * EVERY conditional-delivery rule lives HERE, in the Директор — never
     * hand-rolled inside a Ядро/Модуль (ARCHITECTURE.md's own point: this is
     * exactly what replaced Alpha's per-module counters and timers). The
     * filtering itself is [delivery-filters.js](delivery-filters.js), so the
     * same vocabulary is available to anything that subscribes.
     *
     * @param {string} contract
     * @param {SubscribeOptions | undefined} options
     * @param {DeliveryCallback} callback
     * @returns {() => void}
     */
    function subscribe(contract, { params, when, callerId, priority } = {}, callback) {
        if (!when) {
            resolve(contract, params, callerId, priority).then(callback);
            return () => {};
        }
        // `every` бывает числом (`{ event, every: N }`) или объектом (`{ every: { event, count } }` / `{ every: { ms } }`).
        const everyObject = typeof when.every === 'object' ? when.every : undefined;
        if (everyObject?.ms) {
            const intervalMs = everyObject.ms;
            const timer = setInterval(async () => { callback(await resolve(contract, params, callerId, priority)); }, intervalMs);
            return () => clearInterval(timer);
        }

        const eventName = when.event ?? everyObject?.event;
        if (!eventName) throw new Error(`subscribe(): unrecognized "when" condition: ${JSON.stringify(when)}`);
        // `{ every: { event, count } }` (the original shape) and
        // `{ event, every: N }` (the shorthand) mean the same thing.
        const every = typeof when.every === 'number' ? when.every : everyObject?.count;

        // Initialized to a no-op BEFORE the subscription exists: `once` fires
        // from inside the filtered handler, which can run before the
        // `eventBus.subscribe()` call below has returned (same trap
        // request.js documents for a synchronously-denied Гейт).
        /** @type {() => void} */
        let unsubscribe = () => {};
        const filtered = applyDeliveryFilters(async () => {
            if (when.once) unsubscribe();
            callback(await resolve(contract, params, callerId, priority));
        }, { every, debounceMs: when.debounceMs, throttleMs: when.throttleMs, dedupe: when.dedupe });

        const stop = eventBus.subscribe(eventName, payload => filtered.deliver(payload));
        unsubscribe = () => { filtered.cancel(); stop(); };
        return unsubscribe;
    }

    /** Что на этой шине вообще зарегистрировано, с числом поставщиков. Реальная картина для UI/диагностики — не поддерживаемый вручную список. */
    function contracts() {
        return [...suppliers.entries()]
            .filter(([, list]) => list.length)
            .map(([contract, list]) => ({ contract, suppliers: list.length }))
            .sort((a, b) => a.contract.localeCompare(b.contract));
    }

    return { register, subscribe, contracts };
}
