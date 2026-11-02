import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { totalLogTokens } from '../../libraries/core/decision-log.js';
import { createJournal } from './journal.js';
import { createDigestStore } from './store-digests.js';
import { loadChatMemory } from './store-load.js';
import { sanitizeCycles } from './store-sanitize.js';

/** Хранение состояния директора в памяти чата; запись сериализована очередью,
 * чтобы `persist()` и правки блоков не затирали друг друга. */
export function createDecisionStore({ call, publishEvent }) {
    let runs = {};
    let log = [];
    let logArchive = [];
    let roster = { active: [] };
    let directorPlan = null;
    let arcs = [];
    let notes = {};
    let library = {};
    let plans = [];
    let clock = { minutes: 0, updatedAt: 0 };
    let memoryBank = {};
    let research = [];
    let issuedNames = [];
    let snapshots = {};
    let draft = null;
    let tail = Promise.resolve();

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    const journal = createJournal({
        enqueue,
        call,
        getBank: () => memoryBank,
        setBank: value => { memoryBank = value; },
        getNames: () => issuedNames,
        setNames: value => { issuedNames = value; },
        getLog: () => log,
        setLog: value => { log = value; },
        getArchive: () => logArchive,
        setArchive: value => { logArchive = value; },
    });
    const digests = createDigestStore({ enqueue, call, namespace: DECISION_MEMORY_NAMESPACE });

    async function reload() {
        const data = await loadChatMemory(call);
        runs = data.runs;
        log = data.log;
        logArchive = data.logArchive;
        roster = data.roster;
        directorPlan = data.directorPlan;
        arcs = data.arcs;
        notes = data.notes;
        library = data.library;
        plans = data.plans;
        clock = data.clock;
        memoryBank = data.memoryBank;
        research = data.research;
        issuedNames = data.issuedNames;
        snapshots = data.snapshots;
        draft = data.draft;
        digests.load(data.turnDigests);
        return { runs, log };
    }

    /**
     * Дописать цикл в лог. Через ту же очередь, что и прогоны: лог не должен
     * терять запись, если рядом сохраняется решение.
     */
    function appendCycle(cycle) {
        return enqueue(async () => {
            log = [...log, cycle];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'log', value: log });
            return cycle;
        });
    }

    function logTokens() {
        return totalLogTokens(log);
    }

    function saveRoster(next) {
        return enqueue(async () => {
            roster = { active: [...new Set((Array.isArray(next?.active) ? next.active : []).map(String).map(name => name.trim()).filter(Boolean))] };
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'roster', value: roster });
            return roster;
        });
    }

    function savePlan(plan) {
        return enqueue(async () => {
            directorPlan = plan && typeof plan === 'object' ? plan : null;
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'directorPlan', value: directorPlan });
            return directorPlan;
        });
    }

    function saveArcs(next) {
        return enqueue(async () => {
            arcs = Array.isArray(next) ? next : [];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'arcs', value: arcs });
            return arcs;
        });
    }

    function saveNotes(next) {
        return enqueue(async () => {
            notes = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'notes', value: notes });
            return notes;
        });
    }

    function saveLibrary(next) {
        return enqueue(async () => {
            library = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'library', value: library });
            return library;
        });
    }

    function savePlans(next) {
        return enqueue(async () => {
            plans = Array.isArray(next) ? next : [];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'plans', value: plans });
            return plans;
        });
    }

    function saveClock(next) {
        return enqueue(async () => {
            clock = { minutes: Number(next?.minutes) || 0, updatedAt: Number(next?.updatedAt) || Date.now() };
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'clock', value: clock });
            return clock;
        });
    }

    function saveBank(next) {
        return enqueue(async () => {
            journal.rememberBank(memoryBank, next);
            memoryBank = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'memoryBank', value: memoryBank });
            return memoryBank;
        });
    }

    function saveResearch(next) {
        return enqueue(async () => {
            research = Array.isArray(next) ? next : [];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'research', value: research });
            return research;
        });
    }

    /** Добавить/обновить задачу под той же очередью: два отчёта одновременно не затирают друг друга. */
    function addResearch(task) {
        return enqueue(async () => {
            research = [...research, task];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'research', value: research });
            return research;
        });
    }

    function updateResearch(id, patch) {
        return enqueue(async () => {
            research = research.map(task => (task.id === id ? { ...task, ...patch } : task));
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'research', value: research });
            return research;
        });
    }

    function saveNames(next) {
        return enqueue(async () => {
            issuedNames = [...new Set((Array.isArray(next) ? next : []).map(String))];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'names', value: issuedNames });
            return issuedNames;
        });
    }

    function addName(key) {
        return enqueue(async () => {
            if (!issuedNames.includes(key)) issuedNames = [...issuedNames, key];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'names', value: issuedNames });
            return issuedNames;
        });
    }

    function snapshot(mesid) {
        return snapshots[String(mesid)] ? JSON.parse(JSON.stringify(snapshots[String(mesid)])) : null;
    }

    function deleteSnapshot(mesid) {
        return enqueue(async () => {
            const key = String(mesid);
            if (!(key in snapshots)) return false;
            delete snapshots[key];
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'snapshots', value: snapshots });
            return true;
        });
    }

    function saveDraft(value) {
        return enqueue(async () => {
            draft = value && typeof value === 'object' ? value : null;
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'draft', value: draft });
            return draft;
        });
    }

    /** Заменить лог (после переноса старых ходов в архив). Архив — отдельным ключом. */
    function saveLog(next, { archived = [], archiveLimitTokens = 0 } = {}) {
        return enqueue(async () => {
            log = sanitizeCycles(next);
            if (archived.length) logArchive = [...logArchive, ...sanitizeCycles(archived)];
            if (archiveLimitTokens > 0) {
                while (logArchive.length > 1 && totalLogTokens(logArchive) > archiveLimitTokens) logArchive = logArchive.slice(1);
            }
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'log', value: log });
            if (archived.length) await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'logArchive', value: logArchive });
            return log;
        });
    }

    function lastRun() {
        const list = Object.values(runs).sort((a, b) => (Number(a.mesid) || 0) - (Number(b.mesid) || 0) || (Number(a.at) || 0) - (Number(b.at) || 0));
        return list.at(-1) ?? null;
    }

    function persist(record) {
        return enqueue(async () => {
            const messages = await call('chatHistory.messages', { limit: 1, includeSystem: true });
            const last = Array.isArray(messages) ? messages.at(-1) : null;
            const mesid = String(last?.mesid ?? Math.max(0, record.chatLength));
            const stored = {
                id: record.runId, mesid, at: Date.now(), type: record.type, decision: record.decision,
                push: record.push ?? record.decision ?? '', form: record.form ?? null,
                reasoning: record.reasoning ?? '', steps: record.steps ?? [], workerId: record.workerId ?? null,
                warnings: record.warnings ?? [],
            };
            runs = { ...runs, [mesid]: stored };
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'runs', value: runs });
            if (record.snapshot) {
                const entries = Object.entries(snapshots);
                if (entries.length >= 50) delete snapshots[entries[0][0]];
                snapshots[mesid] = record.snapshot;
                await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'snapshots', value: snapshots });
            }
            return stored;
        });
    }

    return {
        reload, persist, lastRun,
        runs: () => runs,
        cycles: () => log,
        archive: () => logArchive,
        roster: () => ({ active: [...roster.active] }),
        saveRoster,
        plan: () => (directorPlan ? { ...directorPlan, stages: [...(directorPlan.stages ?? [])] } : null),
        savePlan,
        arcs: () => arcs.map(arc => ({ ...arc, stages: [...(arc.stages ?? [])] })),
        saveArcs,
        notes: () => JSON.parse(JSON.stringify(notes)),
        saveNotes,
        library: () => JSON.parse(JSON.stringify(library)),
        saveLibrary,
        plans: () => plans.map(plan => ({ ...plan, steps: [...(plan.steps ?? [])] })),
        savePlans,
        clock: () => ({ ...clock }),
        saveClock,
        bank: () => JSON.parse(JSON.stringify(memoryBank)),
        saveBank,
        research: () => research.map(task => ({ ...task })),
        saveResearch,
        addResearch,
        beginTurn: journal.beginTurn,
        restoreJournal: journal.restoreJournal,
        markRejected: journal.markRejected,
        updateResearch,
        names: () => [...issuedNames],
        saveNames,
        addName,
        snapshot,
        deleteSnapshot,
        draft: () => (draft ? JSON.parse(JSON.stringify(draft)) : null),
        saveDraft,
        appendCycle,
        saveLog,
        logTokens,
        digests: digests.digests,
        saveDigests: digests.saveDigests,
    };
}
