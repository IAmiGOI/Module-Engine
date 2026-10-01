import { request } from '../../libraries/shared/request.js';
import { buildJevRequest, readJevAnswers, describeJevFailure, JEV_DEFAULT_ENDPOINT, JEV_DEFAULT_MODEL, JEV_DEFAULT_TIMEOUT_MS } from '../../libraries/core/jev-request.js';
import { hashText } from '../../libraries/core/jev-question.js';

const NAMESPACE = 'core.classifier';
const SETTINGS_KEY = 'settings';
const CACHE_LIMIT = 500;
const RETRY_STATUSES = new Set([429, 529]);
const RETRY_DELAY_MS = 1200;
const TIMEOUT_BOUNDS = Object.freeze({ min: 500, max: 20000 });
const MAX_CONNECTIONS = 20;
const LEGACY_CONNECTION_ID = 'jev';

export const DEFAULT_CONNECTION = Object.freeze({ endpoint: JEV_DEFAULT_ENDPOINT, model: JEV_DEFAULT_MODEL, apiKey: '', timeoutMs: JEV_DEFAULT_TIMEOUT_MS });

/** Одно подключение к классификатору: имя обязательно (по нему на него ссылаются условия), остальное — с границами и умолчаниями. */
export function sanitizeConnection(raw) {
    const text = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
    const timeout = Number(raw?.timeoutMs);
    return {
        id: text(raw?.id, ''),
        endpoint: text(raw?.endpoint, DEFAULT_CONNECTION.endpoint),
        model: text(raw?.model, DEFAULT_CONNECTION.model),
        apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '',
        timeoutMs: Number.isFinite(timeout) ? Math.min(TIMEOUT_BOUNDS.max, Math.max(TIMEOUT_BOUNDS.min, Math.round(timeout))) : DEFAULT_CONNECTION.timeoutMs,
    };
}

/** Список подключений из сохранённого. Раньше подключение было одно, без имени: оно становится первым и получает имя `jev`, чтобы сохранённый ключ не пропал. */
export function sanitizeConnections(stored) {
    const list = Array.isArray(stored?.connections) ? stored.connections : (stored && (stored.apiKey || stored.endpoint) ? [{ ...stored, id: LEGACY_CONNECTION_ID }] : []);
    const seen = new Set();
    return list.map(sanitizeConnection).filter(connection => connection.id && !seen.has(connection.id) && seen.add(connection.id)).slice(0, MAX_CONNECTIONS);
}

/**
 * Ядро классификатора — ответы классификатора (Jev) на вопросы-утверждения: вероятность 0…1 (режим Noul), с кэшем и жёстким сроком. Подключений может быть несколько
 * (отдельная категория моделей, как diffusion): условие ссылается на подключение по имени, без имени берётся первое. Им пользуется Prompt Manager для условий блоков, но
 * Ядро о PM ничего не знает: оно принимает срезы чата и вопросы, отдаёт вероятности.
 *
 * Контракты: `classifier.connections.get`, `classifier.connections.set { connections }`, `classifier.decide { calls: [{ state, questions: { id: утверждение }, connectionId? }] }` →
 * `{ answers: { id: 0…1 }, failed: [id], error? }`, `classifier.test { connectionId? }`, `classifier.clearCache`. Сбой, тайм-аут, нет подключения или ключа — НЕ исключение:
 * вопрос остаётся без ответа, а как это читать, решает вызывающий (у PM условие без ответа истинно). Ответ на тот же срез и то же утверждение берётся из кэша, поэтому
 * реролл и свайп не стоят повторного вызова.
 */
export function createClassifierCore(host, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id) } = {}) {
    let connections = [];
    const cache = new Map();

    const callOwn = (contract, params) => request(host.own, contract, { params });

    async function load() {
        const stored = await callOwn('storage.settings.get', { namespace: NAMESPACE, key: SETTINGS_KEY, fallback: {} });
        connections = sanitizeConnections(stored.ok ? stored.value : {});
        return connections.map(connection => ({ ...connection }));
    }

    async function setConnections({ connections: next } = {}) {
        connections = sanitizeConnections({ connections: Array.isArray(next) ? next : [] });
        cache.clear();
        await callOwn('storage.settings.set', { namespace: NAMESPACE, key: SETTINGS_KEY, value: { connections } });
        return connections.map(connection => ({ ...connection }));
    }

    const pick = connectionId => (connectionId ? connections.find(connection => connection.id === connectionId) : connections[0]) ?? null;

    const remember = (key, chance) => {
        cache.delete(key);
        cache.set(key, chance);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    };

    async function send(connection, built) {
        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        const timer = controller ? setTimer(() => controller.abort(), connection.timeoutMs) : null;
        try {
            const result = await request(host.network, 'http.request', { params: { ...built, ...(controller ? { signal: controller.signal } : {}) }, timeoutMs: connection.timeoutMs });
            if (!result.ok) throw new Error(result.error.message);
            return result.value;
        } finally {
            if (timer !== null) clearTimer(timer);
        }
    }

    /** Один вызов классификатора: ответы по тем вопросам, что не нашлись в кэше; `error` — почему часть осталась без ответа. */
    async function decideOne({ state, questions, connectionId }) {
        const ids = Object.keys(questions ?? {});
        const answers = {};
        const connection = pick(connectionId);
        const stateKey = `${connection?.id ?? ''}.${hashText(JSON.stringify(state ?? {}))}`;
        const missing = [];
        for (const id of ids) {
            const key = `${stateKey}.${id}`;
            if (cache.has(key)) answers[id] = cache.get(key);
            else missing.push(id);
        }
        if (!missing.length) return { answers, error: '' };
        if (!connection) return { answers, error: connectionId ? `There is no classifier connection called “${connectionId}”.` : 'No classifier connection is set.' };
        if (!connection.apiKey) return { answers, error: `The classifier connection “${connection.id}” has no API key.` };
        const built = buildJevRequest(connection, { state, questions: Object.fromEntries(missing.map(id => [id, questions[id]])) });
        try {
            let response = await send(connection, built);
            if (RETRY_STATUSES.has(response.status)) { await sleep(RETRY_DELAY_MS); response = await send(connection, built); }
            let data = null;
            try { data = JSON.parse(response.text); } catch { data = null; }
            if (!response.ok || data?.error) return { answers, error: describeJevFailure(response.status, data) };
            const found = readJevAnswers(data, missing);
            for (const [id, chance] of Object.entries(found)) { answers[id] = chance; remember(`${stateKey}.${id}`, chance); }
            return { answers, error: Object.keys(found).length ? '' : 'The endpoint returned no usable answers.' };
        } catch (error) {
            return { answers, error: error?.name === 'AbortError' ? 'The request timed out.' : (error?.message ?? 'The request failed.') };
        }
    }

    async function decide({ calls } = {}) {
        const list = Array.isArray(calls) ? calls : [];
        const results = await Promise.all(list.map(decideOne));
        const answers = Object.assign({}, ...results.map(item => item.answers));
        const asked = list.flatMap(call => Object.keys(call.questions ?? {}));
        const error = results.map(item => item.error).find(Boolean) ?? '';
        return { answers, failed: asked.filter(id => !(id in answers)), ...(error ? { error } : {}) };
    }

    async function test({ connectionId } = {}) {
        const started = Date.now();
        const result = await decideOne({ state: { text: 'The door is wide open.' }, questions: { test: 'The door in `text` is open.' }, connectionId });
        cache.clear();
        return result.answers.test === undefined ? { ok: false, error: result.error || 'No answer.', ms: Date.now() - started } : { ok: true, chance: result.answers.test, ms: Date.now() - started };
    }

    const unregisters = [
        host.own.register('classifier.connections.get', () => connections.map(connection => ({ ...connection }))),
        host.own.register('classifier.connections.set', params => setConnections(params)),
        host.own.register('classifier.decide', params => decide(params)),
        host.own.register('classifier.test', params => test(params)),
        host.own.register('classifier.clearCache', () => { cache.clear(); return true; }),
    ];

    return { load, decide, connections: () => connections.map(connection => ({ ...connection })), unregister: () => { for (const unregister of unregisters) unregister(); } };
}
