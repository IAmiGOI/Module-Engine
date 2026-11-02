import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { trimThinking, totalLogTokens } from '../../libraries/core/decision-log.js';

/**
 * Хранение блоков и записей прогонов директора в памяти чата. Вынесено из
 * самого ядра, чтобы у него осталась только логика хода (и файл не рос за
 * 300 строк). Запись сериализована собственной очередью: `persist()`
 * читает-меняет-пишет и `runs`, и `blocks`, поэтому два одновременных
 * завершения не должны затирать друг друга.
 */
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
    let appendCount = 0;
    let tail = Promise.resolve();

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    function sanitizeRuns(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const out = {};
        for (const [mesid, record] of Object.entries(value)) {
            if (!record || typeof record !== 'object') continue;
            if (!String(record.decision ?? '').trim()) continue;
            out[mesid] = { ...record, mesid: String(record.mesid ?? mesid) };
        }
        return out;
    }

    function sanitizeCycles(value) {
        return (Array.isArray(value) ? value : []).filter(cycle => cycle && typeof cycle === 'object');
    }

    async function reload() {
        const [storedRuns, storedLog, storedArchive, storedRoster, storedPlan, storedArcs, storedNotes, storedLibrary, storedPlans, storedClock, storedBank, storedResearch, storedNames, storedSnapshots, storedDraft] = await Promise.all([
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'runs', fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'log', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'logArchive', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'roster', fallback: { active: [] } }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'directorPlan', fallback: null }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'arcs', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'notes', fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'library', fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'plans', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'clock', fallback: { minutes: 0, updatedAt: 0 } }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'memoryBank', fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'research', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'names', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'snapshots', fallback: {} }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'draft', fallback: null }),
        ]);
        runs = sanitizeRuns(storedRuns);
        log = sanitizeCycles(storedLog);
        logArchive = sanitizeCycles(storedArchive);
        roster = { active: Array.isArray(storedRoster?.active) ? storedRoster.active.map(String) : [] };
        directorPlan = storedPlan && typeof storedPlan === 'object' ? storedPlan : null;
        arcs = Array.isArray(storedArcs) ? storedArcs.filter(arc => arc && typeof arc === 'object') : [];
        notes = storedNotes && typeof storedNotes === 'object' && !Array.isArray(storedNotes) ? storedNotes : {};
        library = storedLibrary && typeof storedLibrary === 'object' && !Array.isArray(storedLibrary) ? storedLibrary : {};
        plans = Array.isArray(storedPlans) ? storedPlans.filter(plan => plan && typeof plan === 'object') : [];
        clock = Number.isFinite(storedClock?.minutes) ? { minutes: Number(storedClock.minutes), updatedAt: Number(storedClock.updatedAt) || 0 } : { minutes: 0, updatedAt: 0 };
        memoryBank = storedBank && typeof storedBank === 'object' && !Array.isArray(storedBank) ? storedBank : {};
        research = Array.isArray(storedResearch) ? storedResearch.filter(task => task && typeof task === 'object') : [];
        issuedNames = Array.isArray(storedNames) ? storedNames.map(String) : [];
        snapshots = storedSnapshots && typeof storedSnapshots === 'object' && !Array.isArray(storedSnapshots) ? storedSnapshots : {};
        draft = storedDraft && typeof storedDraft === 'object' ? storedDraft : null;
        return { runs, log };
    }

    /**
     * Дописать цикл в лог. Через ту же очередь, что и прогоны: лог не должен
     * терять запись, если рядом сохраняется решение.
     */
    function appendCycle(cycle) {
        return enqueue(async () => {
            log = [...log, cycle];
            appendCount += 1;
            // Thinking — за текущий цикл и два предыдущих. Чистим ПАЧКОЙ на
            // границе трёх циклов (e0: так платится одно падение префикса раз
            // в три хода, а не каждый).
            if (appendCount % 3 === 0) log = trimThinking(log, 2);
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

    /** Заменить лог (после хранения thinking/архива). Архив — отдельным ключом, чтобы он не искал старые записи. */
    function saveLog(next, { archived = [] } = {}) {
        return enqueue(async () => {
            log = sanitizeCycles(next);
            if (archived.length) logArchive = [...logArchive, ...sanitizeCycles(archived)];
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
    };
}
