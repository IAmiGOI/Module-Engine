import { appendLedger, normalizeLedger } from '../../libraries/core/decision-ledger.js';
import {
    appendConversation, appendPetitions, appendPrayers, markReviewed, normalizePrayers,
    normalizePetitions, unreviewedRows, COUNSELLOR_CHAT_LIMIT,
} from '../../libraries/core/decision-counsellor.js';
import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { answerGodQuestion, normalizeDeclaration, normalizeGodQuestions } from '../../libraries/core/decision-god-queue.js';

/**
 * Ведомость, Молитвы, Телеграммы и очередь Прошений в памяти чата. Вынесено
 * из `store.js`, чтобы файл держался в пределах 300 строк; правила — в
 * `libraries/core/decision-ledger.js` и `decision-counsellor.js`.
 */

export function createPapersStore({ enqueue, call }) {
    let ledger = [];
    let papers = empty();

    function empty() {
        return {
            prayers: [], telegrams: [], awaitingDecree: null,
            petitions: [],
            counsellor: { messages: [], lastReviewTurn: 0, lastReviewAt: 0, day: null },
            director: { lastRunAt: 0, lastReason: '' },
            // Бог: вопросы Советнику, ответы на них и след последнего разбора.
            god: { questions: [], declaration: null, lastRunAt: 0, lastReason: '' },
        };
    }

    function normalize(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const counsellor = source.counsellor && typeof source.counsellor === 'object' ? source.counsellor : {};
        const director = source.director && typeof source.director === 'object' ? source.director : {};
        const god = source.god && typeof source.god === 'object' ? source.god : {};
        return {
            prayers: normalizePrayers(source.prayers),
            telegrams: (Array.isArray(source.telegrams) ? source.telegrams : [])
                .filter(item => item && typeof item === 'object' && String(item.text ?? '').trim())
                .map(item => ({
                    ...item,
                    text: String(item.text).trim(),
                    at: Number(item.at) || 0,
                    turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
                    blocked: Boolean(item.blocked),
                    status: ['queued', 'delivered', 'read'].includes(String(item.status ?? '')) ? String(item.status) : 'queued',
                })),
            awaitingDecree: source.awaitingDecree && typeof source.awaitingDecree === 'object' ? { ...source.awaitingDecree } : null,
            petitions: normalizePetitions(source.petitions),
            director: {
                lastRunAt: Number(director.lastRunAt) || 0,
                lastReason: String(director.lastReason ?? '').trim(),
            },
            counsellor: {
                messages: (Array.isArray(counsellor.messages) ? counsellor.messages : [])
                    .filter(item => item && typeof item === 'object' && String(item.text ?? '').trim())
                    .map(item => ({ role: item.role === 'counsellor' ? 'counsellor' : 'user', text: String(item.text).trim(), at: Number(item.at) || 0 }))
                    .slice(-COUNSELLOR_CHAT_LIMIT),
                lastReviewTurn: Number(counsellor.lastReviewTurn) || 0,
                lastReviewAt: Number(counsellor.lastReviewAt) || 0,
                day: Number.isFinite(Number(counsellor.day)) ? Number(counsellor.day) : null,
            },
            god: {
                questions: normalizeGodQuestions(god.questions),
                declaration: normalizeDeclaration(god.declaration),
                lastRunAt: Number(god.lastRunAt) || 0,
                lastReason: String(god.lastReason ?? '').trim(),
            },
        };
    }

    function load(data) {
        ledger = normalizeLedger(data?.ledger);
        papers = normalize(data?.papers);
    }

    function appendRows(rows) {
        return enqueue(async () => {
            ledger = appendLedger(ledger, rows);
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'ledger', value: ledger });
            return ledger;
        });
    }

    function replaceRows(rows) {
        return enqueue(async () => {
            ledger = appendLedger([], rows);
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'ledger', value: ledger });
            return ledger;
        });
    }

    /** Разобранные Советником строки не возвращаются в его контекст. */
    function markLedgerReviewed(at) {
        return enqueue(async () => {
            const marked = markReviewed(ledger, { at });
            ledger = marked.ledger;
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'ledger', value: ledger });
            return { count: marked.count, ledger };
        });
    }

    function save(next) {
        return enqueue(async () => {
            papers = normalize(next);
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'papers', value: papers });
            return papers;
        });
    }

    const now = () => ({
        prayers: normalizePrayers(papers.prayers),
        telegrams: [...(papers.telegrams ?? [])],
        awaitingDecree: papers.awaitingDecree ?? null,
        petitions: normalizePetitions(papers.petitions),
        counsellor: {
            messages: (papers.counsellor?.messages ?? []).map(item => ({ ...item })),
            lastReviewTurn: Number(papers.counsellor?.lastReviewTurn) || 0,
            lastReviewAt: Number(papers.counsellor?.lastReviewAt) || 0,
            day: Number.isFinite(Number(papers.counsellor?.day)) ? Number(papers.counsellor.day) : null,
        },
        director: {
            lastRunAt: Number(papers.director?.lastRunAt) || 0,
            lastReason: String(papers.director?.lastReason ?? '').trim(),
        },
        god: {
            questions: normalizeGodQuestions(papers.god?.questions),
            declaration: normalizeDeclaration(papers.god?.declaration),
            lastRunAt: Number(papers.god?.lastRunAt) || 0,
            lastReason: String(papers.god?.lastReason ?? '').trim(),
        },
    });

    function addPrayer(entry) {
        const current = now();
        return save({ ...current, prayers: appendPrayers(current.prayers, [{ ...entry, source: entry?.source ?? 'resolver' }]) });
    }

    function addPetition(entry) {
        const current = now();
        return save({ ...current, petitions: appendPetitions(current.petitions, [entry]) });
    }

    function addConversation(entry) {
        const current = now();
        return save({
            ...current,
            counsellor: { ...current.counsellor, messages: appendConversation(current.counsellor.messages, entry) },
        });
    }

    function saveCounsellor(patch) {
        const current = now();
        return save({ ...current, counsellor: { ...current.counsellor, ...(patch && typeof patch === 'object' ? patch : {}) } });
    }

    function addTelegram(entry) {
        const current = now();
        return save({ ...current, telegrams: [...current.telegrams, { ...entry }].slice(-200) });
    }

    function saveAwaitingDecree(value) {
        const current = now();
        return save({ ...current, awaitingDecree: value && typeof value === 'object' ? { ...value } : null });
    }

    /** Director прочитал очередь Petition: строка больше не повод будить его. */
    function markPetitionsRead(at, ids = null) {
        const current = now();
        const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
        const petitions = current.petitions.map(item => {
            if (item.status === 'read') return item;
            // Пока Director работал, Советник мог прислать новую Petition — её не трогаем.
            if (wanted && !wanted.has(String(item.id))) return item;
            return { ...item, status: 'read', readAt: Number(at) || 0 };
        });
        return save({ ...current, petitions });
    }

    /** То же для Телеграмм; закрытый повод перестаёт держать ход. */
    function markTelegramsRead(at) {
        const current = now();
        const telegrams = current.telegrams.map(item => (item.status === 'read' ? item : { ...item, status: 'read', readAt: Number(at) || 0 }));
        return save({ ...current, telegrams });
    }

    function saveDirector(patch) {
        const current = now();
        return save({ ...current, director: { ...current.director, ...(patch && typeof patch === 'object' ? patch : {}) } });
    }

    /** Бог прочитал Молитвы: строка больше не повод будить его. */
    function markPrayersRead(at, ids = null) {
        const current = now();
        const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
        const prayers = current.prayers.map(item => {
            if (item.status === 'read') return item;
            if (wanted && !wanted.has(String(item.id))) return item;
            return { ...item, status: 'read', readAt: Number(at) || 0 };
        });
        return save({ ...current, prayers });
    }

    /** Вопросы Бога Советнику — очередью; ответы собирают Декларацию. */
    function addGodQuestions(list, { turn = null, at = 0 } = {}) {
        const current = now();
        const added = normalizeGodQuestions(list).map(item => ({ ...item, at: Number(at) || 0, turn: turn !== null && turn !== undefined && Number.isFinite(Number(turn)) ? Number(turn) : null }));
        return save({ ...current, god: { ...current.god, questions: [...current.god.questions, ...added] } });
    }

    function answerGod({ id, answer, at = 0 } = {}) {
        const current = now();
        const result = answerGodQuestion(current.god.questions, { id, answer, at });
        const next = {
            ...current,
            god: {
                ...current.god,
                questions: result.questions,
                declaration: result.declaration ?? current.god.declaration,
            },
        };
        return save(next).then(papers => ({ papers, closed: result.closed, declaration: result.declaration }));
    }

    /** Декларация доставлена Богу: следующая собирается заново. */
    function consumeDeclaration(at) {
        const current = now();
        return save({ ...current, god: { ...current.god, declaration: null, lastRunAt: Number(at) || 0 } });
    }

    function saveGod(patch) {
        const current = now();
        return save({ ...current, god: { ...current.god, ...(patch && typeof patch === 'object' ? patch : {}) } });
    }

    return {
        load, save,
        ledger: () => ledger.map(row => ({ ...row, conflict: { ...row.conflict } })),
        unreviewed: () => unreviewedRows(ledger).map(row => ({ ...row, conflict: { ...row.conflict } })),
        appendLedger: appendRows,
        saveLedger: replaceRows,
        markLedgerReviewed,
        papers: now,
        petitions: () => normalizePetitions(papers.petitions),
        addPetition,
        prayers: () => normalizePrayers(papers.prayers),
        addPrayer,
        markPrayersRead,
        conversation: () => (papers.counsellor?.messages ?? []).map(item => ({ ...item })),
        addConversation,
        counsellor: () => now().counsellor,
        saveCounsellor,
        addTelegram,
        saveAwaitingDecree,
        markPetitionsRead,
        markTelegramsRead,
        director: () => now().director,
        saveDirector,
        god: () => now().god,
        addGodQuestions,
        answerGod,
        consumeDeclaration,
        saveGod,
    };
}
