// @ts-check
import { createEventBus } from './event-bus.js';
import { createContractBus } from './contract-bus.js';
import { createGate } from './gate.js';
import { createNetworkGate } from './network-gate.js';
import { createRightsCore } from '../../cores/rights/index.js';
import { request } from './request.js';

/** @typedef {import('./bus-types.js').Engine} Engine */
/** @typedef {import('./bus-types.js').Host} Host */
/** @typedef {import('./bus-types.js').Domain} Domain */
/** @typedef {import('./bus-types.js').HomeDomain} HomeDomain */
/** @typedef {import('./bus-types.js').GateAccessor} GateAccessor */
/** @typedef {import('./bus-types.js').RightsConfig} RightsConfig */
/** @typedef {import('./bus-types.js').Envelope} Envelope */

/**
 * Assembles the real connectivity skeleton (ARCHITECTURE.md) into one
 * object: the shared Event Bus, contract buses (modules/cores/services/
 * network), one Rights Core, and a Gate guarding every CROSS-domain path.
 * This IS the "Ядро → Директор своей шины → Гейт → Директор шины-адресата"
 * chain from ARCHITECTURE.md's own worked example, assembled and wired.
 *
 * A caller reaches its OWN domain's bus directly (registering there needs
 * no Gate — nothing crosses a domain boundary) but reaches any OTHER
 * domain only through that pair's Gate, which checks ITS rights on every
 * single delivery (see gate.js).
 *
 * `network` is a genuinely SEPARATE bus from `services`, not just a
 * differently-named accessor onto the same one — `http.*` contracts only
 * ever get registered there (see services/http.js), so `host.services`
 * structurally cannot reach them at all. If `network` shared a bus with
 * `services`, a caller with SOME unrelated `allowedContracts` grant could
 * reach `http.request` through the ordinary (non-network-checked) Gate,
 * bypassing `hasNetworkAccess()` entirely — seeing this once and closing it
 * was the whole reason this is a separate bus, not a separate label.
 *
 * @returns {Engine}
 */
export function createEngine() {
    const events = createEventBus();
    /** @type {Record<Domain, import('./bus-types.js').ContractBus>} */
    const buses = {
        modules: createContractBus(events),
        cores: createContractBus(events),
        services: createContractBus(events),
        network: createContractBus(events),
    };
    const rights = createRightsCore();

    // One Gate per reachable (home domain -> target domain) pair — see
    // ARCHITECTURE.md's confirmed shapes: Ядро↔Ядро and Модуль↔Модуль stay
    // on the caller's OWN bus (no Gate — no domain crossing happens);
    // Ядро↔Сервис, Ядро↔Модуль, Модуль↔Сервис, Модуль↔Ядро, and both
    // ↔Сеть pairs all cross a domain boundary and go through a Gate.
    // Services/network suppliers don't originate cross-domain requests of
    // their own in this design (see ARCHITECTURE.md: "просто логический
    // адаптер").
    /** @type {Partial<Record<HomeDomain, Partial<Record<Domain, GateAccessor>>>>} */
    const gates = {
        modules: {
            services: createGate(rights, buses.services),
            cores: createGate(rights, buses.cores),
            network: createNetworkGate(rights, buses.network),
        },
        cores: {
            services: createGate(rights, buses.services),
            modules: createGate(rights, buses.modules),
            network: createNetworkGate(rights, buses.network),
        },
    };

    /** @type {Map<string, { homeDomain: HomeDomain, host: Host }>} callerId -> личность и хост — нужна для resolveAs() ниже */
    const callers = new Map();

    /**
     * Registers a caller's identity/rights (see cores/rights/index.js —
     * `rightsConfig` is `{ tier, allowedContracts?, deniedContracts?,
     * networkAccess? }`) and returns the "host" surface it uses to reach
     * everything: `own` (its home bus, direct — registering a contract for
     * others to reach always happens here) plus one gated accessor per
     * OTHER reachable domain (`host.network` included, for `homeDomain`s
     * that have it).
     *
     * @param {string} callerId
     * @param {HomeDomain} homeDomain
     * @param {RightsConfig} rightsConfig
     * @returns {Host}
     */
    function registerCaller(callerId, homeDomain, rightsConfig) {
        rights.register(callerId, rightsConfig);
        // `own` остаётся БЕЗ Гейта (домашняя шина — ничего не пересекает
        // границу домена), но личность несёт: иначе поставщик на своей же
        // шине не может отличить, кто из Ядер к нему пришёл.
        /** @type {import('./bus-types.js').OwnAccessor} */
        const own = {
            subscribe: (contract, options, callback) => buses[homeDomain].subscribe(contract, { ...options, callerId }, callback),
            register: (contract, handler, opts) => buses[homeDomain].register(contract, handler, opts),
            contracts: () => buses[homeDomain].contracts(),
        };
        /** @type {Host} */
        const host = { events, own };
        // У вызывающего без Гейтов (Сервис на своей Шине) других доменов просто нет — не ошибка.
        const homeGates = gates[homeDomain] ?? {};
        for (const targetDomain of /** @type {Domain[]} */ (Object.keys(homeGates))) {
            const gate = /** @type {GateAccessor} */ (homeGates[targetDomain]);
            /** @type {GateAccessor} */
            const accessor = {
                subscribe: (contract, options, callback) => gate.subscribe(contract, { ...options, callerId }, callback),
                register: (contract, handler, opts) => gate.register(contract, handler, opts),
            };
            host[targetDomain] = accessor;
        }
        callers.set(callerId, { homeDomain, host });
        return host;
    }

    /**
     * В какой шине этот контракт вообще зарегистрирован. Никакой карты вручную — спрашиваем сами Шины (интроспекция Директора).
     * @param {string} contract
     * @returns {Domain | null}
     */
    function locateDomain(contract) {
        for (const domain of /** @type {Domain[]} */ (Object.keys(buses))) {
            if (buses[domain].contracts().some(entry => entry.contract === contract)) return domain;
        }
        return null;
    }

    /**
     * ПРИВИЛЕГИРОВАННОЕ: исполнить контракт ОТ ИМЕНИ другого вызывающего —
     * тем же путём, через тот же Гейт, с теми же правами, что были бы у него
     * самого. Выдаётся ровно одному потребителю — Ядру пайплайнов, при
     * сборке движка (та же форма, что `publish` для Ядра событий).
     *
     * Зачем вообще: пайплайн исполняет этапы, ОБЪЯВЛЕННЫЕ чужими Ядрами и
     * Модулями. Исполняй он их под своей личностью — любой Модуль дотянулся
     * бы куда угодно, просто объявив этап, и пайплайн стал бы отмывочной
     * для прав. Ровно та же ошибка, что была бы с общей Шиной для сети,
     * закрытая тем же способом: не «структурно один путь», а физическая
     * невозможность обойти проверку.
     *
     * `priority` — тот же флаг места вызова, что у `request()`: пайплайн генерации помечает им свои этапы, чтобы запросы к моделям
     * из них шли вперёд фоновых (dispatch-queue.js).
     *
     * @param {string} callerId
     * @param {string} contract
     * @param {any} [params]
     * @param {{ priority?: string }} [options]
     * @returns {Promise<Envelope>}
     */
    function resolveAs(callerId, contract, params, { priority } = {}) {
        const caller = callers.get(callerId);
        if (!caller) return Promise.resolve({ ok: false, error: { message: `Unknown caller "${callerId}" — an unregistered caller has no rights at all.` } });
        const domain = locateDomain(contract);
        // Контракта нет нигде — отдаём его домашней шине вызывающего, чтобы
        // ответ пришёл стандартной ошибкой Директора «поставщика нет», а не
        // особым случаем здесь (см. PIPELINE.md про выдуманный инструмент).
        const accessor = domain && domain !== caller.homeDomain ? caller.host[domain] : caller.host.own;
        if (!accessor) return Promise.resolve({ ok: false, error: { message: `Caller "${callerId}" cannot reach the "${domain}" domain.` } });
        return request(accessor, contract, { params, priority });
    }

    return { events, buses, rights, registerCaller, resolveAs };
}
