import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Bootstrap нового чата: один цикл директора до первого хода, параллельно
 * холодному старту банков. Состояние в памяти чата; повторно не запускается.
 */
export function createBootstrap({ call, store, cycle, getSettings, publishEvent, now = () => Date.now() }) {
    let state = { status: 'idle', startedAt: 0, finishedAt: 0, error: null };
    let loaded = false;
    let promise = null;

    function save(patch) {
        state = { ...state, ...patch, updatedAt: now() };
        return Promise.resolve(call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'bootstrap', value: state })).catch(() => state);
    }

    async function load() {
        try {
            const stored = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'bootstrap', fallback: null });
            if (stored && typeof stored === 'object') state = { ...state, ...stored };
        } catch { /* a missing memory value is a fresh bootstrap */ }
        loaded = true;
        return { ...state };
    }

    async function isNewChat() {
        try {
            const messages = await call('chatHistory.messages', { limit: 2 });
            return (Array.isArray(messages) ? messages.length : 0) <= 1 && (typeof store.cycles === 'function' ? store.cycles().length : 0) === 0;
        } catch { return false; }
    }

    async function run() {
        const settings = getSettings();
        await save({ status: 'running', startedAt: now(), finishedAt: 0, error: null });
        publishEvent('decision.bootstrap.started', { at: now(), maxQuestions: settings.bootstrap?.maxQuestions ?? 5 });
        try {
            const result = await cycle.runBootstrap({
                runId: `bootstrap_${now()}`, maxQuestions: settings.bootstrap?.maxQuestions ?? 5,
                maxSteps: settings.bootstrap?.maxSteps ?? 30,
            });
            if (result?.briefWritten) {
                await save({ status: 'done', finishedAt: now(), error: null });
                publishEvent('decision.bootstrap.finished', { status: 'done', at: now() });
            } else {
                const message = 'The bootstrap cycle finished without a chat brief; the first turn goes on without one.';
                await save({ status: 'failed', finishedAt: now(), error: message });
                publishEvent('decision.bootstrap.warning', { message });
                publishEvent('decision.bootstrap.finished', { status: 'failed', at: now(), error: message });
            }
        } catch (error) {
            const message = `Bootstrap failed: ${error?.message ?? error}`;
            await save({ status: 'failed', finishedAt: now(), error: message });
            publishEvent('decision.bootstrap.warning', { message });
            publishEvent('decision.bootstrap.finished', { status: 'failed', at: now(), error: message });
        }
        return { ...state };
    }

    async function ensure() {
        if (!loaded) await load();
        if (state.status === 'done' || state.status === 'failed') return { ...state, skipped: true };
        if (state.status === 'idle' && !(await isNewChat())) return { ...state, skipped: true };
        if (promise) return promise;
        promise = run().finally(() => { promise = null; });
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
        if (state.status === 'done' || state.status === 'failed') return { timedOut: false, status: state.status };
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

    return { load, ensure, maybeStart, waitFirstTurn, state: () => ({ ...state }), isNewChat };
}
