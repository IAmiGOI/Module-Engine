import { createEventBus } from './event-bus.js';
import { createContractBus } from './contract-bus.js';
import { createGate } from './gate.js';
import { createNetworkGate } from './network-gate.js';
import { createRightsCore } from '../../cores/rights/index.js';
import { request } from './request.js';

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
 */
export function createEngine() {
    const events = createEventBus();
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

    /**
     * Registers a caller's identity/rights (see cores/rights/index.js —
     * `rightsConfig` is `{ tier, allowedContracts?, deniedContracts?,
     * networkAccess? }`) and returns the "host" surface it uses to reach
     * everything: `own` (its home bus, direct — registering a contract for
     * others to reach always happens here) plus one gated accessor per
     * OTHER reachable domain (`host.network` included, for `homeDomain`s
     * that have it).
     */
    const callers = new Map(); // callerId -> { homeDomain, host } — нужна для resolveAs() ниже

    function registerCaller(callerId, homeDomain, rightsConfig) {
        rights.register(callerId, rightsConfig);
        // `own` остаётся БЕЗ Гейта (домашняя шина — ничего не пересекает
        // границу домена), но личность несёт: иначе поставщик на своей же
        // шине не может отличить, кто из Ядер к нему пришёл.
        const own = {
            subscribe: (contract, options, callback) => buses[homeDomain].subscribe(contract, { ...options, callerId }, callback),
            register: (contract, handler, opts) => buses[homeDomain].register(contract, handler, opts),
            contracts: () => buses[homeDomain].contracts(),
        };
        const host = { events, own };
        for (const [targetDomain, gate] of Object.entries(gates[homeDomain] ?? {})) {
            host[targetDomain] = {
                subscribe: (contract, options, callback) => gate.subscribe(contract, { ...options, callerId }, callback),
                register: (contract, handler, opts) => gate.register(contract, handler, opts),
            };
        }
        callers.set(callerId, { homeDomain, host });
        return host;
    }

    /** В какой шине этот контракт вообще зарегистрирован. Никакой карты вручную — спрашиваем сами Шины (интроспекция Директора). */
    function locateDomain(contract) {
        for (const [domain, bus] of Object.entries(buses)) {
            if (bus.contracts().some(entry => entry.contract === contract)) return domain;
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
     */
    function resolveAs(callerId, contract, params) {
        const caller = callers.get(callerId);
        if (!caller) return Promise.resolve({ ok: false, error: { message: `Unknown caller "${callerId}" — an unregistered caller has no rights at all.` } });
        const domain = locateDomain(contract);
        // Контракта нет нигде — отдаём его домашней шине вызывающего, чтобы
        // ответ пришёл стандартной ошибкой Директора «поставщика нет», а не
        // особым случаем здесь (см. PIPELINE.md про выдуманный инструмент).
        const accessor = domain && domain !== caller.homeDomain ? caller.host[domain] : caller.host.own;
        if (!accessor) return Promise.resolve({ ok: false, error: { message: `Caller "${callerId}" cannot reach the "${domain}" domain.` } });
        return request(accessor, contract, { params });
    }

    return { events, buses, rights, registerCaller, resolveAs };
}
