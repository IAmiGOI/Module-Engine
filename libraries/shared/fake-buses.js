import { createEventBus } from './event-bus.js';
import { createContractBus } from './contract-bus.js';

/**
 * All 5 offline-fake Шины (LIBRARIES.md's "Библиотека офлайн-фейков",
 * ROADMAP.md step 1) — everything a Core/Module needs to be written and
 * tested against, with no real Сервис (ST/DOM/network) anywhere underneath.
 *
 * One shared Event Bus (the real architecture's own primitive every other
 * bus's `when` builds on — see contract-bus.js), plus independent
 * Module/Core/Service/Network contract buses layered on top of it. `network`
 * is its own bus here too, mirroring engine.js's real one — see
 * network-gate.js's doc comment for why that separation (not just a
 * separate Gate on the shared Service bus) is load-bearing. No Финальный UI
 * fake yet — that's a separate, later piece (see LIBRARIES.md).
 */
export function createFakeBuses() {
    const events = createEventBus();
    return {
        events,
        modules: createContractBus(events),
        cores: createContractBus(events),
        services: createContractBus(events),
        network: createContractBus(events),
    };
}
