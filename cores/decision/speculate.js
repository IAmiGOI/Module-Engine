import {
    draftFeatures, predictReady, learnReady, defaultWeights, emptyHistory,
    rememberSentLength, rememberPause,
} from '../../libraries/core/draft-readiness.js';
import { DECISION_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { hashText } from '../../libraries/core/hash-text.js';

/**
 * Резолвер заранее, по черновику. Пока игрок печатает, движок раз в секунду
 * смотрит на поле и спрашивает маленькую модель «похоже, это уже сообщение?».
 * Если да — ход решается в отдельной ветке. При отправке ровно того же текста
 * ветка вливается в журнал, и писатель стартует сразу.
 *
 * Модель учится только на самом игроке: каждая пауза — пример «ушло как есть»
 * (1) или «игрок дописал» (0). Веса и история лежат в `storage.settings`, не в
 * чате: это привычка человека, а не состояние истории.
 */

const MODEL_KEY = 'draftReadiness';
const CHAT_LIMIT = 100000;
const FINGERPRINT_MESSAGES = 12;
/** Меньше этого пауза — не пауза, а обычный набор: примеру нечему учить. */
const MIN_PAUSE_MS = 250;
const LEARNING_RATE = 0.1;
/** Сколько ждать брошенную ветку, прежде чем идти обычным ходом (как PREEMPT_WAIT_MS в цикле). */
const SETTLE_WAIT_MS = 3000;

const clone = value => {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
};

function normalizeMessage(message) {
    return {
        user: message?.is_user === true || message?.isUser === true,
        text: String(message?.mes ?? message?.content ?? message?.text ?? ''),
        swipeIndex: Number.isInteger(message?.swipe_id) ? message.swipe_id : (Number.isInteger(message?.swipeIndex) ? message.swipeIndex : 0),
        swipeCount: Array.isArray(message?.swipes) ? message.swipes.length : (Number.isFinite(Number(message?.swipeCount)) ? Number(message.swipeCount) : 1),
    };
}

function fingerprintOf(chat, store, settings) {
    const list = Array.isArray(chat) ? chat : [];
    return {
        chatLength: list.length,
        chatHash: hashText(JSON.stringify(list.slice(-FINGERPRINT_MESSAGES).map(normalizeMessage))),
        roster: JSON.stringify(store?.roster?.()?.active ?? []),
        clock: Number(store?.clock?.()?.minutes) || 0,
        log: (store?.cycles?.() ?? []).length,
        settings: hashText(JSON.stringify(settings ?? {})),
        // Настройки игры — в памяти чата, отдельно от настроек ядра: правка между стартом и отправкой тоже ломает ветку.
        game: JSON.stringify(store?.gameSettings?.() ?? null),
    };
}

const sameFingerprint = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function lastUserText(chat) {
    const list = Array.isArray(chat) ? chat : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index]?.is_user === true || list[index]?.isUser === true) {
            return String(list[index]?.mes ?? list[index]?.content ?? list[index]?.text ?? '').trim();
        }
    }
    return '';
}

/** База без отправленного черновика: последняя пользовательская реплика снята. */
function withoutSentDraft(chat, sentText) {
    const list = Array.isArray(chat) ? chat : [];
    const last = list.at(-1);
    const isUser = last?.is_user === true || last?.isUser === true;
    if (!isUser) return list;
    const body = String(last?.mes ?? last?.content ?? last?.text ?? '').trim();
    return body === String(sentText ?? '').trim() ? list.slice(0, -1) : list;
}

export function createSpeculator({
    getSettings = () => ({}),
    call, callService,
    store,
    now = () => Date.now(),
    intervalMs = 1000,
    setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimer = id => clearTimeout(id),
    isReady = async () => true,
    isBusy = () => false,
    startRun, // ({ runId, chat, signal, draft, startedAt, onAskUser }) => { done, reasoning, usage, scope }
}) {
    let weights = defaultWeights();
    let history = emptyHistory();
    let loaded = false;
    let polling = false;
    let timer = null;
    let starting = false;
    let generating = false;
    let branch = null;
    let lastDiscarded = null; // брошенная ветка, которая ещё может держать слот модели
    let lastDiscard = null;
    let counter = 0;
    let session = { text: '', lastChangeAt: now(), examples: [] };

    const enabled = () => getSettings()?.speculate?.enabled === true;
    const threshold = () => {
        const value = Number(getSettings()?.speculate?.threshold);
        return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.6;
    };

    async function loadModel() {
        if (loaded) return;
        loaded = true;
        try {
            const stored = await call('storage.settings.get', { namespace: DECISION_NAMESPACE, key: MODEL_KEY, fallback: null });
            if (stored && typeof stored === 'object') {
                if (stored.weights && typeof stored.weights === 'object') weights = { ...defaultWeights(), ...stored.weights };
                if (stored.history && typeof stored.history === 'object') {
                    history = {
                        lengths: (Array.isArray(stored.history.lengths) ? stored.history.lengths : []).map(Number).filter(Number.isFinite),
                        pauses: (Array.isArray(stored.history.pauses) ? stored.history.pauses : []).map(Number).filter(Number.isFinite),
                    };
                }
            }
        } catch { /* нет настроек — начнём с разумных весов */ }
    }

    function saveModel() {
        return Promise.resolve(call('storage.settings.set', {
            namespace: DECISION_NAMESPACE, key: MODEL_KEY,
            value: { weights: clone(weights), history: clone(history) },
        })).catch(() => {});
    }

    function resetSession(at = now()) {
        session = { text: '', lastChangeAt: at, examples: [] };
    }

    function discardHandle(handle, reason) {
        if (!handle) return;
        if (!handle.discarded) { handle.discarded = true; handle.reason = reason; }
        try { handle.abort?.(reason); } catch { /* запрос уже мог закончиться */ }
        if (branch === handle) branch = null;
        lastDiscarded = handle;
        lastDiscard = { reason: handle.reason, startedAt: handle.startedAt };
    }

    /** Брошенная ветка должна отпустить слот модели (или хотя бы не держать ход дольше трёх секунд). */
    async function settle({ timeoutMs = SETTLE_WAIT_MS } = {}) {
        const handle = lastDiscarded;
        if (!handle || handle.finishedAt) { lastDiscarded = null; return; }
        let timer = null;
        await Promise.race([
            handle.done,
            new Promise(resolve => { timer = setTimer(resolve, timeoutMs); }),
        ]);
        if (timer !== null) clearTimer(timer);
        if (lastDiscarded === handle) lastDiscarded = null;
    }

    /** Смена текста: пауза, кончившаяся дописыванием, — отрицательный пример. */
    function observeText(text, at) {
        if (text === session.text) return false;
        const previous = session.text;
        const pauseMs = Math.max(0, at - session.lastChangeAt);
        if (previous.trim() && pauseMs >= MIN_PAUSE_MS) {
            history = rememberPause(history, pauseMs);
            session.examples.push({ features: draftFeatures({ draft: previous, pauseMs, history }), label: 0 });
        }
        session.text = text;
        session.lastChangeAt = at;
        if (branch) discardHandle(branch, 'changed');
        return true;
    }

    async function readChat() {
        const messages = await call('chatHistory.messages', { limit: CHAT_LIMIT, includeSystem: true }).catch(() => []);
        return (Array.isArray(messages) ? messages : []).map(message => ({
            mes: String(message?.text ?? message?.mes ?? ''),
            is_user: message?.isUser === true || message?.is_user === true,
            is_system: message?.isSystem === true || message?.is_system === true,
            name: String(message?.name ?? ''),
            ...(Number.isInteger(message?.swipeIndex) ? { swipeIndex: message.swipeIndex, swipeCount: Number(message?.swipeCount) || 1 } : {}),
        }));
    }

    async function start(text, at) {
        starting = true;
        try {
            const runId = `spec_${(counter += 1)}_${at.toString(36)}`;
            const base = await readChat();
            // Ходу — как ST: без скрытых и служебных сообщений; отпечаток — по всему чату.
            const chat = [...base.filter(message => !message.is_system), { mes: text, is_user: true, name: '' }];
            const fingerprint = fingerprintOf(base, store, getSettings());
            const controller = new AbortController();
            const handle = {
                runId, draft: text, startedAt: at, finishedAt: null, discarded: false, reason: null,
                result: null, fingerprint, scope: null, reasoning: () => '', usage: () => null,
                abort: reason => {
                    if (!handle.discarded) { handle.discarded = true; handle.reason = reason; }
                    controller.abort(new Error(reason));
                },
            };
            const started = await startRun({
                runId, chat, signal: controller.signal, draft: text, startedAt: at,
                onAskUser: () => handle.abort('ask_user'),
            });
            handle.scope = started.scope ?? null;
            handle.reasoning = started.reasoning ?? (() => '');
            handle.usage = started.usage ?? (() => null);
            handle.done = Promise.resolve(started.done)
                .then(result => { handle.result = result; return result; })
                .catch(error => {
                    if (!handle.discarded) { handle.discarded = true; handle.reason = 'error'; }
                    handle.error = error;
                    return null;
                })
                .finally(() => { handle.finishedAt = now(); });
            branch = handle;
            lastDiscarded = null;
        } catch {
            lastDiscard = { reason: 'error', startedAt: at };
        } finally {
            starting = false;
        }
    }

    async function tick() {
        if (!enabled()) { stopPolling(); return; }
        await loadModel();
        if (generating || isBusy()) return;
        let text = '';
        try {
            const answer = await callService('stInput.readText');
            text = typeof answer === 'string' ? answer : String(answer?.text ?? '');
        } catch { text = ''; }
        const at = now();
        if (observeText(text, at)) return;
        if (!session.text.trim() || branch || starting || (lastDiscarded && !lastDiscarded.finishedAt)) return;
        const pauseMs = Math.max(0, at - session.lastChangeAt);
        const features = draftFeatures({ draft: session.text, pauseMs, history });
        if (predictReady(weights, features) < threshold()) return;
        if (!(await isReady())) return;
        await start(session.text, at);
    }

    function startPolling() {
        if (timer || polling) { polling = true; return; }
        polling = true;
        const loop = async () => {
            timer = null;
            try { await tick(); } catch { /* следующий тик всё равно будет */ }
            if (polling) timer = setTimer(loop, intervalMs);
        };
        timer = setTimer(loop, intervalMs);
    }

    function stopPolling() {
        polling = false;
        if (timer !== null) { clearTimer(timer); timer = null; }
    }

    function inputBarChanged({ active } = {}) {
        if (active) startPolling();
        else stopPolling();
    }

    /** Машина генерации занята — ветку не начинаем; уже начатую при отправке ещё вливаем. */
    function setGenerating(value) {
        generating = Boolean(value);
        if (generating) stopPolling();
        else if (enabled()) startPolling();
    }

    function discard(reason = 'changed') {
        if (branch) discardHandle(branch, reason);
        resetSession(now());
    }

    /**
     * Отправка: совпадает ли ветка с текстом, обучение на паузах этого
     * сообщения и сброс сессии. Ветку не ждём — это делает `take`.
     */
    async function beginSend({ chat, runId, type = 'normal' } = {}) {
        if (!enabled()) {
            if (branch) discardHandle(branch, 'changed');
            resetSession(now());
            lastDiscard = null;
            return { handle: null, info: null, sentText: lastUserText(chat), sentAt: now(), runId };
        }
        await loadModel();
        const sentText = lastUserText(chat);
        const sentAt = now();
        // Переигровка и свайп — не сообщение игрока: ветку бросаем, но ничему не учимся.
        if (type !== 'normal') {
            if (branch) discardHandle(branch, 'changed');
            resetSession(sentAt);
            lastDiscard = null;
            return { handle: null, info: null, sentText, sentAt, runId };
        }
        const observed = session.text;
        const unchanged = observed.trim() === sentText.trim();
        const pauseMs = Math.max(0, sentAt - session.lastChangeAt);

        // Пауза, кончившаяся дописыванием, пока тикер её не увидел: отрицательный пример.
        if (observed.trim() && !unchanged && pauseMs >= MIN_PAUSE_MS) {
            history = rememberPause(history, pauseMs);
            session.examples.push({ features: draftFeatures({ draft: observed, pauseMs, history }), label: 0 });
        }
        // Последняя пауза перед отправкой: ушло ровно таким — положительный пример.
        if (unchanged && observed.trim() && pauseMs >= MIN_PAUSE_MS) {
            history = rememberPause(history, pauseMs);
            session.examples.push({ features: draftFeatures({ draft: observed, pauseMs, history }), label: 1 });
        }

        let info = null;
        let handle = branch;
        if (handle && handle.draft.trim() === sentText.trim()) {
            info = { used: false, startedAt: handle.startedAt };
        } else if (handle) {
            discardHandle(handle, 'changed');
            info = { used: false, reason: 'changed', startedAt: handle.startedAt };
            handle = null;
        } else if (lastDiscard) {
            info = { used: false, reason: lastDiscard.reason, startedAt: lastDiscard.startedAt };
        } else {
            info = { used: false };
        }

        for (const example of session.examples) weights = learnReady(weights, example.features, example.label, { rate: LEARNING_RATE });
        history = rememberSentLength(history, sentText.length);
        await saveModel();
        resetSession(sentAt);
        lastDiscard = null;
        branch = handle;
        return { handle, info, sentText, sentAt, runId };
    }

    /** Дождаться ветки и сверить отпечаток; вернуть `{ merged, handle, info }`. */
    async function take(handle, { chat, sentText, sentAt = now() } = {}) {
        if (!handle) return { merged: false, handle: null, info: null };
        await handle.done;
        if (handle.discarded) {
            if (branch === handle) branch = null;
            lastDiscard = null;
            return { merged: false, handle: null, info: { used: false, reason: handle.reason ?? 'error', startedAt: handle.startedAt } };
        }
        if (!handle.result?.ok) {
            discardHandle(handle, 'error');
            lastDiscard = null;
            return { merged: false, handle: null, info: { used: false, reason: 'error', startedAt: handle.startedAt } };
        }
        // Отпечаток — из того же источника, что при старте ветки: чат, который ST отдаёт перехватчику, другой
        // (без скрытых сообщений, со свайпами, с обработанным регэкспами текстом) и не совпал бы никогда.
        const fingerprint = fingerprintOf(withoutSentDraft(await readChat(), sentText), store, getSettings());
        if (!sameFingerprint(fingerprint, handle.fingerprint)) {
            discardHandle(handle, 'fingerprint');
            lastDiscard = null;
            return { merged: false, handle: null, info: { used: false, reason: 'fingerprint', startedAt: handle.startedAt } };
        }
        if (branch === handle) branch = null;
        const savedMs = Math.max(0, Math.min(handle.finishedAt ?? now(), sentAt) - handle.startedAt);
        return { merged: true, handle, info: { used: true, startedAt: handle.startedAt, savedMs } };
    }

    function state() {
        return {
            enabled: enabled(), weights: { ...weights }, history: clone(history),
            polling, generating,
            branch: branch ? {
                runId: branch.runId, startedAt: branch.startedAt,
                running: !branch.finishedAt, discarded: branch.discarded, reason: branch.reason,
            } : null,
            lastDiscard: lastDiscard ? { ...lastDiscard } : null,
        };
    }

    return {
        inputBarChanged, setGenerating, discard, beginSend, take, settle, tick, state,
        start: startPolling, stop: stopPolling,
    };
}
