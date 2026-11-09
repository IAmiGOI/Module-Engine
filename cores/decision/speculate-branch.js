import { createDecisionCycle } from './cycle.js';
import { createDecisionStore } from './store.js';

/**
 * Ветка спекулятивного хода: отдельный store и отдельный `call`. Чтения идут
 * насквозь, но видят записи самой ветки; записи копятся списком операций и в
 * настоящий мир не уходят. События и живой показ тоже копятся — их выпускают
 * только при вливании, в том же порядке, что у обычного хода.
 *
 * Почему второй экземпляр цикла, а не общий: у цикла есть своё `state`
 * (броски, счётчики, режимы, текст сцены). Ветка не имеет права испортить
 * настоящий ход, поэтому у неё свой state и своя карта бросков.
 */

const key = value => String(value ?? '').trim();
const clone = value => {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
};
const overlayKey = (namespace, name) => `${key(namespace)}:${key(name)}`;

/** Методы store, которые что-то пишут. Их повторяем на настоящем store при вливании. */
const MUTATING_STORE = new Set([
    'persist', 'saveRoster', 'savePlan', 'saveBank', 'saveResearch', 'addResearch', 'updateResearch',
    'saveNames', 'addName', 'deleteSnapshot', 'saveGameSettings', 'saveChatBrief', 'saveDraft',
    'saveArcs', 'saveNotes', 'saveLibrary', 'savePlans', 'saveClock',
    'appendLedger', 'saveLedger', 'markLedgerReviewed', 'addPetition', 'addPrayer', 'addConversation',
    'saveCounsellor', 'addTelegram', 'saveAwaitingDecree', 'markPetitionsRead', 'markTelegramsRead',
    'saveDirector', 'markPrayersRead', 'addGodQuestions', 'answerGod', 'consumeDeclaration', 'saveGod',
    'saveBoundary', 'saveWindow', 'saveFrozen', 'appendCycle', 'upsertCycle', 'saveLog', 'markRejected',
    'restoreJournal',
]);

/** Контракты, которые меняют мир. Набор шире ходового набора — на случай будущих инструментов. */
export function isMutatingContract(contract) {
    const name = String(contract ?? '');
    if (name === 'storage.chatMemory.set' || name === 'storage.settings.set') return true;
    if (name === 'summary.force') return true;
    if (name === 'chatHistory.annotate' || name === 'chatHistory.replaceText' || name === 'chatHistory.hide') return true;
    return /^lorebook\.(write|save|create|edit)/.test(name);
}

function proxyStore(store, record) {
    const wrapped = {};
    for (const [name, value] of Object.entries(store)) {
        if (typeof value !== 'function') { wrapped[name] = value; continue; }
        wrapped[name] = MUTATING_STORE.has(name)
            ? (...args) => { record({ kind: 'store', name, args }); return value(...args); }
            : (...args) => value(...args);
    }
    return wrapped;
}

/**
 * Собрать изолированную ветку. Возвращает готовый цикл и накопленные операции
 * с событиями; запускает его вызывающий.
 */
export async function createBranchScope({
    runId, signal = null, onAskUser = () => {},
    call: realCall = async () => undefined,
    callStrict: realCallStrict = async () => undefined,
    callService: realService = null,
    getSettings, getGameSettings = null, getWorkers = () => [], banks = null,
    capture = null,
    now = () => Date.now(),
}) {
    const ops = [];
    const events = [];
    const overlay = new Map();

    function remember(contract, params, { record = true } = {}) {
        if (!isMutatingContract(contract)) return false;
        if (record) ops.push({ kind: 'call', contract, params });
        if (contract === 'storage.chatMemory.set' || contract === 'storage.settings.set') {
            const value = params && typeof params === 'object' ? params : {};
            overlay.set(overlayKey(value.namespace, value.key), clone(value.value));
        }
        return true;
    }

    function readOverlay(contract, params) {
        if (contract !== 'storage.chatMemory.get' && contract !== 'storage.settings.get') return { found: false };
        const value = params && typeof params === 'object' ? params : {};
        const id = overlayKey(value.namespace, value.key);
        return overlay.has(id) ? { found: true, value: clone(overlay.get(id)) } : { found: false };
    }

    const callLoose = async (contract, params, options) => {
        if (remember(contract, params)) return true;
        const held = readOverlay(contract, params);
        if (held.found) return held.value;
        return realCall(contract, params, options);
    };

    const callStrict = async (contract, params, options) => {
        if (remember(contract, params)) return true;
        const held = readOverlay(contract, params);
        if (held.found) return held.value;
        return realCallStrict(contract, params, options);
    };

    // Store пишет через этот вызов: метод store уже записан целиком, дублировать
    // внутренний `storage.*.set` не нужно.
    const storeCall = async (contract, params, options) => {
        if (remember(contract, params, { record: false })) return true;
        const held = readOverlay(contract, params);
        if (held.found) return held.value;
        return realCall(contract, params, options);
    };

    const publishEvent = (event, payload) => {
        events.push({ event, payload });
        // Вопрос игроку из спекуляции недопустим: ветку сразу бросаем.
        if (event === 'decision.question.asked') onAskUser();
    };

    const questions = {
        ask: async () => {
            onAskUser();
            return { text: 'ask_user is not available during a speculative turn.', asked: false };
        },
        pending: () => null,
        count: () => 0,
        locked: () => false,
        answer: () => ({ ok: false, error: 'No question is open.' }),
        cancelAll: () => {},
    };

    const branchStore = createDecisionStore({ call: storeCall, publishEvent });
    await branchStore.reload();
    const store = proxyStore(branchStore, op => ops.push(op));

    // Банки — только для чтения: короткий банк вошедшего персонажа соберётся
    // при вливании настоящим `noteRosterAdded`, а не из выброшенной ветки.
    const quietBanks = banks && typeof banks === 'object'
        ? Object.assign(Object.create(banks), { noteRosterAdded: async () => [] })
        : null;

    const callService = realService
        ? async (contract, params) => {
            // Родной ввод не блокируем из ветки: там работает только вопрос, а он запрещён.
            if (contract === 'stInput.setLocked') return { ok: true, locked: Boolean(params?.locked) };
            return realService(contract, params);
        }
        : null;

    const cycle = createDecisionCycle({
        call: callStrict,
        // Чужие инструменты в ветке не трогают мир: ход резолвера — только assess и inscribe.
        callTool: async name => ({ ok: false, error: `The tool "${name}" is not available during a speculative turn.` }),
        callService,
        getSettings,
        getGameSettings,
        getWorkers,
        store,
        researcher: null,
        banks: quietBanks,
        publishEvent,
        questions,
        capture,
        now,
    });

    return {
        runId,
        signal,
        ops,
        events,
        cycle: () => branchStore.cycles().findLast(item => item?.runId === runId) ?? null,
        assessments: () => cycle.assessments(),
        api: cycle,
    };
}

function rewriteRunId(payload, from, to) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    if (String(payload.runId ?? '') !== from) return payload;
    return { ...payload, runId: to };
}

/**
 * Влить ветку: операции — в том же порядке, события — после них. Запись хода
 * получает настоящий runId и отметку `speculative`; сам ход не переспрашивает
 * модель.
 */
export async function mergeBranch({ scope, runId, store, call, publishEvent, banks = null, speculative = null }) {
    const record = scope.cycle();
    if (record) {
        record.runId = String(runId);
        if (speculative) record.speculative = { ...speculative };
    }
    const before = new Set((store.roster()?.active ?? []).map(value => String(value).trim().toLowerCase()));
    for (const op of scope.ops) {
        try {
            if (op.kind === 'store') await store[op.name]?.(...op.args);
            else await call(op.contract, op.params);
        } catch { /* одна неудавшаяся запись не должна отменять уже решённый ход */ }
    }
    for (const painted of scope.events) {
        publishEvent(painted.event, rewriteRunId(painted.payload, scope.runId, runId));
    }
    // Новый персонаж вошёл в ростере — короткий банк, как у обычного хода.
    const added = (store.roster()?.active ?? []).filter(value => !before.has(String(value).trim().toLowerCase()));
    if (added.length && typeof banks?.noteRosterAdded === 'function') await banks.noteRosterAdded(added).catch(() => []);
    return record;
}
