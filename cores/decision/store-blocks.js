import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Простые блоки состояния директора: арки, заметки, библиотека, планы, часы.
 * Вынесено из `store.js`, чтобы файл держался в пределах 300 строк; правила
 * формы — в своих библиотеках.
 */
export function createBlocksStore({ enqueue, call }) {
    let arcs = [];
    let notes = {};
    let library = {};
    let plans = [];
    let clock = { minutes: 0, updatedAt: 0 };

    function load(data) {
        arcs = Array.isArray(data?.arcs) ? data.arcs : [];
        notes = data?.notes && typeof data.notes === 'object' && !Array.isArray(data.notes) ? data.notes : {};
        library = data?.library && typeof data.library === 'object' && !Array.isArray(data.library) ? data.library : {};
        plans = Array.isArray(data?.plans) ? data.plans : [];
        clock = data?.clock && typeof data.clock === 'object' ? data.clock : { minutes: 0, updatedAt: 0 };
    }

    const put = (key, value) => call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key, value });

    function saveArcs(next) {
        return enqueue(async () => {
            arcs = Array.isArray(next) ? next : [];
            await put('arcs', arcs);
            return arcs;
        });
    }

    function saveNotes(next) {
        return enqueue(async () => {
            notes = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
            await put('notes', notes);
            return notes;
        });
    }

    function saveLibrary(next) {
        return enqueue(async () => {
            library = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
            await put('library', library);
            return library;
        });
    }

    function savePlans(next) {
        return enqueue(async () => {
            plans = Array.isArray(next) ? next : [];
            await put('plans', plans);
            return plans;
        });
    }

    function saveClock(next) {
        return enqueue(async () => {
            clock = { minutes: Number(next?.minutes) || 0, updatedAt: Number(next?.updatedAt) || Date.now() };
            await put('clock', clock);
            return clock;
        });
    }

    return {
        load, saveArcs, saveNotes, saveLibrary, savePlans, saveClock,
        arcs: () => arcs.map(arc => ({ ...arc, stages: [...(arc.stages ?? [])] })),
        notes: () => JSON.parse(JSON.stringify(notes)),
        library: () => JSON.parse(JSON.stringify(library)),
        plans: () => plans.map(plan => ({ ...plan, steps: [...(plan.steps ?? [])] })),
        clock: () => ({ ...clock }),
    };
}
