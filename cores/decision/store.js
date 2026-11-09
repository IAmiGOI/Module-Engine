import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { createJournal } from './journal.js';
import { createLogStore } from './store-log.js';
import { createWindowStore } from './store-window.js';
import { loadChatMemory } from './store-load.js';
import { createPapersStore } from './store-papers.js';
import { createBlocksStore } from './store-blocks.js';

/** Хранение состояния директора в памяти чата; запись сериализована очередью,
 * чтобы `persist()` и правки блоков не затирали друг друга. */
export function createDecisionStore({ call, publishEvent }) {
    let runs = {};
    let roster = { active: [] };
    let directorPlan = null;
    let memoryBank = {};
    let research = [];
    let issuedNames = [];
    let snapshots = {};
    let draft = null;
    let chatBrief = null;
    let gameSettings = null;
    let tail = Promise.resolve();

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    const logs = createLogStore({ enqueue, call, namespace: DECISION_MEMORY_NAMESPACE });

    const journal = createJournal({
        enqueue,
        call,
        getBank: () => memoryBank,
        setBank: value => { memoryBank = value; },
        getNames: () => issuedNames,
        setNames: value => { issuedNames = value; },
        getLog: logs.log,
        setLog: logs.setLog,
        getArchive: logs.archive,
        setArchive: logs.setArchive,
    });
    const windows = createWindowStore({ enqueue, call, namespace: DECISION_MEMORY_NAMESPACE });
    const papersStore = createPapersStore({ enqueue, call });
    const blocks = createBlocksStore({ enqueue, call });

    async function reload() {
        const data = await loadChatMemory(call);
        runs = data.runs;
        logs.load(data);
        roster = data.roster;
        directorPlan = data.directorPlan;
        blocks.load(data);
        memoryBank = data.memoryBank;
        research = data.research;
        issuedNames = data.issuedNames;
        snapshots = data.snapshots;
        draft = data.draft;
        chatBrief = data.chatBrief;
        gameSettings = data.gameSettings;
        papersStore.load(data);
        windows.load({ window: data.window, frozenWindows: data.frozenWindows, windowBoundary: data.windowBoundary });
        return { runs, log: logs.log() };
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

    function saveGameSettings(value) {
        return enqueue(async () => {
            gameSettings = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'gameSettings', value: gameSettings });
            return gameSettings ? { ...gameSettings } : null;
        });
    }

    function saveChatBrief(value) {
        return enqueue(async () => {
            chatBrief = value && typeof value === 'object' ? value : null;
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'chatBrief', value: chatBrief });
            return chatBrief;
        });
    }

    function saveDraft(value) {
        return enqueue(async () => {
            draft = value && typeof value === 'object' ? value : null;
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'draft', value: draft });
            return draft;
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
                assessments: Array.isArray(record.assessments) ? record.assessments : [],
                game: record.game && typeof record.game === 'object' ? record.game : null,
                sourceRunId: record.sourceRunId ?? null,
                writerText: String(last?.text ?? last?.mes ?? last?.content ?? '').trim(),
                reasoning: record.reasoning ?? '', steps: record.steps ?? [], workerId: record.workerId ?? null,
                warnings: record.warnings ?? [],
            };
            runs = { ...runs, [mesid]: stored };
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'runs', value: runs });
            if (record.snapshot) {
                const entries = Object.entries(snapshots);
                if (entries.length >= 50) delete snapshots[entries[0][0]];
                snapshots[mesid] = record.snapshot;
                // Great Bank тяжёлый (сотни КБ): держим его только в трёх последних снимках — переигрывают почти всегда последний ход.
                for (const [key] of Object.entries(snapshots).slice(0, -3)) {
                    if (snapshots[key]?.greatBank) { const { greatBank: _dropped, ...rest } = snapshots[key]; snapshots[key] = rest; }
                }
                await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'snapshots', value: snapshots });
            }
            return stored;
        });
    }

    return {
        reload, persist, lastRun,
        runs: () => runs,
        cycles: logs.log,
        archive: logs.archive,
        roster: () => ({ active: [...roster.active] }),
        saveRoster,
        plan: () => (directorPlan ? { ...directorPlan, stages: [...(directorPlan.stages ?? [])] } : null),
        savePlan,
        arcs: blocks.arcs,
        saveArcs: blocks.saveArcs,
        notes: blocks.notes,
        saveNotes: blocks.saveNotes,
        library: blocks.library,
        saveLibrary: blocks.saveLibrary,
        plans: blocks.plans,
        savePlans: blocks.savePlans,
        clock: blocks.clock,
        saveClock: blocks.saveClock,
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
        chatBrief: () => (chatBrief ? JSON.parse(JSON.stringify(chatBrief)) : null),
        saveChatBrief,
        gameSettings: () => (gameSettings ? { ...gameSettings } : null),
        saveGameSettings,
        ledger: papersStore.ledger,
        unreviewedLedger: papersStore.unreviewed,
        appendLedger: papersStore.appendLedger,
        saveLedger: papersStore.saveLedger,
        markLedgerReviewed: papersStore.markLedgerReviewed,
        papers: papersStore.papers,
        petitions: papersStore.petitions,
        addPetition: papersStore.addPetition,
        prayers: papersStore.prayers,
        addPrayer: papersStore.addPrayer,
        conversation: papersStore.conversation,
        addConversation: papersStore.addConversation,
        counsellor: papersStore.counsellor,
        saveCounsellor: papersStore.saveCounsellor,
        addTelegram: papersStore.addTelegram,
        saveAwaitingDecree: papersStore.saveAwaitingDecree,
        markPetitionsRead: papersStore.markPetitionsRead,
        markTelegramsRead: papersStore.markTelegramsRead,
        director: papersStore.director,
        saveDirector: papersStore.saveDirector,
        markPrayersRead: papersStore.markPrayersRead,
        god: papersStore.god,
        addGodQuestions: papersStore.addGodQuestions,
        answerGod: papersStore.answerGod,
        consumeDeclaration: papersStore.consumeDeclaration,
        saveGod: papersStore.saveGod,
        boundary: windows.boundary,
        saveBoundary: windows.saveBoundary,
        window: windows.window,
        saveWindow: windows.saveWindow,
        frozen: windows.frozen,
        saveFrozen: windows.saveFrozen,
        appendCycle: logs.appendCycle,
        upsertCycle: logs.upsertCycle,
        saveLog: logs.saveLog,
        logTokens: logs.logTokens,
    };
}
