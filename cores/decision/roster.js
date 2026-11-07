import { interruptPlan, removeOnLeavingRoster } from '../../libraries/core/decision-library.js';

const key = value => String(value ?? '').trim().toLowerCase();

/**
 * Ростер — одна операция для двух входов: отдельного `update_roster` (в
 * фоновых циклах и bootstrap) и поля `roster` внутри `inscribe`. Правила
 * одни: входящие добавляются, вышедшие убираются, план вошедшего
 * прерывается, план вышедшего ждёт нового.
 */
export function createRosterApplier({ store, banks = null, state = {}, window: turnWindow = null }) {
    return async function applyRoster({ add = [], remove = [] } = {}) {
        const before = store.roster().active;
        const removedNames = new Set((Array.isArray(remove) ? remove : []).map(name => String(name).trim()).filter(Boolean));
        // Имена в ростере сравниваются без регистра, а хранится тот вид, каким его ввели.
        const next = before.filter(name => ![...removedNames].some(gone => key(gone) === key(name)));
        const added = [];
        for (const entry of Array.isArray(add) ? add : []) {
            const name = String(entry?.name ?? '').trim();
            if (name && !next.some(existing => key(existing) === key(name))) { next.push(name); added.push(name); }
        }
        const removed = before.filter(name => !next.includes(name));
        if (!added.length && !removed.length) return { ok: true, active: next, added: [], removed: [], warnings: [] };
        await store.saveRoster({ active: next });

        let plans = store.plans();
        for (const name of added) plans = interruptPlan(plans, { character: name });
        let library = store.library();
        for (const name of removed) {
            library = removeOnLeavingRoster(library, { character: name }).library;
            plans = plans.map(plan => (key(plan.character) === key(name) && !plan.resolvedAt
                ? { ...plan, interrupted: false, approximate: false, dueAt: store.clock().minutes, needsNewPlan: true }
                : plan));
        }
        await store.saveLibrary(library);
        await store.savePlans(plans);
        if (added.length && banks) await banks.noteRosterAdded(added).catch(() => {});
        const parts = [];
        if (added.length) parts.push(`+ ${added.join(', ')}`);
        if (removed.length) parts.push(`− ${removed.join(', ')}`);
        await turnWindow?.addFact(`roster: ${parts.join(', ')}`, { turn: state.turnCounter });
        return { ok: true, active: next, added, removed, warnings: [] };
    };
}
