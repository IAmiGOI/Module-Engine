import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { bootstrapQuestionCount } from '../../libraries/core/game-settings.js';

/**
 * Bootstrap нового чата: один цикл директора до первого хода, параллельно
 * холодному старту банков. Состояние в памяти чата; повторно не запускается.
 */
export function createBootstrap({ call, store, cycle, getSettings, getGameSettings = null, publishEvent, now = () => Date.now() }) {
    let state = { status: 'idle', startedAt: 0, finishedAt: 0, error: null };
    let loaded = false;
    let promise = null;
    let epoch = 0; // смена чата: запуск старого чата больше ничего не пишет и никого не держит

    function saveFor(patch, runEpoch = epoch) {
        if (runEpoch !== epoch) return Promise.resolve(state);
        state = { ...state, ...patch, updatedAt: now() };
        return Promise.resolve(call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'bootstrap', value: state })).catch(() => state);
    }

    async function load() {
        try {
            const stored = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'bootstrap', fallback: null });
            // Состояние — только этого чата: без записи в памяти чат начинает с idle, а не с чужого «done»/«failed».
            if (!promise) state = { status: 'idle', startedAt: 0, finishedAt: 0, error: null, ...(stored && typeof stored === 'object' ? stored : {}) };
            // «running» из памяти чата — цикл прошлой страницы, его уже нет: честно «failed», чтобы был виден повтор.
            if (state.status === 'running' && !promise) state = { ...state, status: 'failed', error: 'The bootstrap was interrupted (the page was reloaded).' };
        } catch { /* a missing memory value is a fresh bootstrap */ }
        loaded = true;
        return { ...state };
    }

    /** Открыт ли чат: на главном экране ST чата нет (null), хотя в `chat` лежит приветствие ассистента. */
    async function chatOpen() {
        try {
            // Закрыт только по явному ответу ST; нет контракта или ответа — чат считается открытым.
            const answer = await call('chatHistory.chatId');
            return answer?.open !== false;
        } catch { return true; }
    }

    async function isNewChat() {
        try {
            const messages = await call('chatHistory.messages', { limit: 2 });
            // Приветствие ассистента главного экрана ST — не карточка и не чат.
            const list = (Array.isArray(messages) ? messages : []).filter(message => message?.type !== 'assistant_message');
            // Ровно одно сообщение — приветствие карточки. Ноль — чат ещё не загружен (перезагрузка страницы):
            // раньше это принималось за новый чат, и bootstrap запускался заново по пустым данным.
            return list.length === 1 && list[0]?.is_user !== true && list[0]?.isUser !== true && (typeof store.cycles === 'function' ? store.cycles().length : 0) === 0;
        } catch { return false; }
    }

    async function run() {
        const settings = getSettings();
        const runEpoch = epoch;
        const save = patch => saveFor(patch, runEpoch);
        const publish = (name, payload) => { if (runEpoch === epoch) publishEvent(name, payload); };
        const game = typeof getGameSettings === 'function' ? getGameSettings() : null;
        const maxQuestions = game ? bootstrapQuestionCount(game) : (settings.bootstrap?.maxQuestions ?? 5);
        await save({ status: 'running', startedAt: now(), finishedAt: 0, error: null });
        publish('decision.bootstrap.started', { at: now(), maxQuestions });
        try {
            const result = await cycle.runBootstrap({
                runId: `bootstrap_${now()}`, maxQuestions,
                maxSteps: settings.bootstrap?.maxSteps ?? 30,
            });
            if (result?.briefWritten) {
                await save({ status: 'done', finishedAt: now(), error: null });
                publish('decision.bootstrap.finished', { status: 'done', at: now() });
            } else {
                const message = result?.type === 'error'
                    ? `Bootstrap failed: ${result.reason}`
                    : 'The bootstrap cycle finished without a chat brief; the first turn goes on without one.';
                await save({ status: 'failed', finishedAt: now(), error: message });
                publish('decision.bootstrap.warning', { message });
                publish('decision.bootstrap.finished', { status: 'failed', at: now(), error: message });
            }
        } catch (error) {
            const message = `Bootstrap failed: ${error?.message ?? error}`;
            await save({ status: 'failed', finishedAt: now(), error: message });
            publish('decision.bootstrap.warning', { message });
            publish('decision.bootstrap.finished', { status: 'failed', at: now(), error: message });
        }
        return { ...state };
    }

    async function ensure() {
        if (!loaded) await load();
        if (promise) return promise;
        if (state.status === 'done' || state.status === 'failed') return { ...state, skipped: true };
        if (state.status === 'idle' && !(await isNewChat())) return { ...state, skipped: true };
        if (promise) return promise;
        promise = start();
        return promise;
    }

    async function maybeStart() {
        if (!loaded) await load();
        if (state.status === 'done' || state.status === 'failed' || state.status === 'running') return { ...state };
        if (!(await isNewChat())) return { ...state };
        return ensure();
    }

    async function waitFirstTurn() {
        if (!loaded) await load();
        // Идущий bootstrap ход ждёт всегда, что бы ни было записано в памяти: иначе они идут параллельно и делят состояние цикла.
        if (!promise && (state.status === 'done' || state.status === 'failed')) return { timedOut: false, status: state.status };
        const timeoutMs = Math.max(1, Number(getSettings().bootstrap?.timeoutMs) || 180000);
        let timer = null;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
        const result = await Promise.race([ensure().then(value => ({ timedOut: false, value })), timeout]);
        if (timer) clearTimeout(timer);
        if (result.timedOut) {
            // Вопрос открыт — ввод закрыт, и первый ход ждёт ответа, а не
            // уходит без сводки. После ответа ожидание продолжается.
            if (typeof cycle.question === 'function' && cycle.question()) return waitFirstTurn();
            publishEvent('decision.bootstrap.warning', { message: `The chat bootstrap did not finish within ${timeoutMs} ms; the first turn goes on without waiting.` });
        }
        return result;
    }

    /** Повтор после неудачи — по кнопке пользователя; «новый ли чат» уже не важно. */
    async function retry() {
        if (!loaded) await load();
        if (promise) return { ok: false, error: 'The bootstrap is already running.' };
        if (state.status !== 'failed') return { ok: false, error: 'There is no failed bootstrap to retry.' };
        // Возврат сразу после запуска: кнопка повтора не должна держать «занято», пока bootstrap задаёт вопросы.
        promise = start();
        promise.catch(() => {});
        return { ok: true, started: true };
    }

    // Завершение старого запуска не должно обнулить запуск нового чата.
    function start() {
        const current = run().finally(() => { if (promise === current) promise = null; });
        return current;
    }

    /** Смена чата: запуск старого чата забыт — новый чат его не ждёт, а старый не пишет в новый. */
    function chatChanged() {
        epoch += 1;
        promise = null;
        loaded = false;
        state = { status: 'idle', startedAt: 0, finishedAt: 0, error: null };
    }

    return { load, ensure, maybeStart, waitFirstTurn, retry, chatChanged, state: () => ({ ...state }), isNewChat, chatOpen };
}
