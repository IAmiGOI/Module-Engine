import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { sanitizeCycles, sanitizeRuns } from './store-sanitize.js';

/** Прочитать всё состояние директора из памяти чата; мусор приводится к безопасной форме. */
export async function loadChatMemory(call) {
    const [storedRuns, storedLog, storedArchive, storedRoster, storedPlan, storedArcs, storedNotes, storedLibrary, storedPlans, storedClock, storedBank, storedResearch, storedNames, storedSnapshots, storedDraft, storedBoundary, storedWindow, storedFrozen, storedBrief, storedGame] = await Promise.all([
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
        call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'windowBoundary', fallback: null }),
        call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'window', fallback: null }),
        call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'frozenWindows', fallback: [] }),
        call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'chatBrief', fallback: null }),
        call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'gameSettings', fallback: null }),
    ]);
    return {
        runs: sanitizeRuns(storedRuns),
        log: sanitizeCycles(storedLog),
        logArchive: sanitizeCycles(storedArchive),
        roster: { active: Array.isArray(storedRoster?.active) ? storedRoster.active.map(String) : [] },
        directorPlan: storedPlan && typeof storedPlan === 'object' ? storedPlan : null,
        arcs: Array.isArray(storedArcs) ? storedArcs.filter(arc => arc && typeof arc === 'object') : [],
        notes: storedNotes && typeof storedNotes === 'object' && !Array.isArray(storedNotes) ? storedNotes : {},
        library: storedLibrary && typeof storedLibrary === 'object' && !Array.isArray(storedLibrary) ? storedLibrary : {},
        plans: Array.isArray(storedPlans) ? storedPlans.filter(plan => plan && typeof plan === 'object') : [],
        clock: Number.isFinite(storedClock?.minutes) ? { minutes: Number(storedClock.minutes), updatedAt: Number(storedClock.updatedAt) || 0 } : { minutes: 0, updatedAt: 0 },
        memoryBank: storedBank && typeof storedBank === 'object' && !Array.isArray(storedBank) ? storedBank : {},
        research: Array.isArray(storedResearch) ? storedResearch.filter(task => task && typeof task === 'object') : [],
        issuedNames: Array.isArray(storedNames) ? storedNames.map(String) : [],
        snapshots: storedSnapshots && typeof storedSnapshots === 'object' && !Array.isArray(storedSnapshots) ? storedSnapshots : {},
        draft: storedDraft && typeof storedDraft === 'object' ? storedDraft : null,
        chatBrief: storedBrief && typeof storedBrief === 'object' && !Array.isArray(storedBrief) ? storedBrief : null,
        gameSettings: storedGame && typeof storedGame === 'object' && !Array.isArray(storedGame) ? storedGame : null,
        windowBoundary: storedBoundary && typeof storedBoundary === 'object' && !Array.isArray(storedBoundary) ? storedBoundary : null,
        window: storedWindow && typeof storedWindow === 'object' && !Array.isArray(storedWindow) ? storedWindow : null,
        frozenWindows: Array.isArray(storedFrozen) ? storedFrozen.filter(record => record && typeof record === 'object') : [],
    };
}
