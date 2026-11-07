/**
 * Один алгоритм повтора для всех ролей (часть 19). Чистые правила: что
 * считать сбоем, сколько ждать, когда менять подключение и в какой бюджет
 * укладываться. Ни моделей, ни хранения — этим пользуются резолвер
 * (`cores/decision/retry.js`), писатель (`writer-proxy.js`) и сборщики банков.
 *
 * Сеть, 5xx, 429, тайм-аут и обрыв потока повторяются с растущей паузой
 * (1 с, 3 с, 8 с; не больше трёх попыток), `Retry-After` уважается. Пустой
 * ответ повторяется один раз с бо́льшим лимитом выхода и ризонингом ниже.
 * Два пустых подряд от одной модели — повод перейти на запасное подключение
 * роли, если оно задано.
 */

export const RETRY_WAITS_MS = Object.freeze([1000, 3000, 8000]);
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_MAX_WAIT_MS = 20000;
export const BLOCKING_ROLES = Object.freeze(['resolver', 'writer']);

const NETWORK_FAILURE = /failed to fetch|networkerror|network error|load failed|err_[a-z0-9_]+|econnreset|econnrefused|socket hang up|fetch failed|stream (?:ended|closed|broke)|premature close|terminated/i;
const TIMEOUT_FAILURE = /timeout|timed out|stall|aborted due to timeout|deadline/i;

const text = value => String(value ?? '').trim();

/** `Retry-After` из текста ответа (секунды) или `retryAfterMs` ошибки. */
export function readRetryAfterMs(source, fallbackMs = null) {
    const direct = Number(source?.retryAfterMs ?? source?.retry_after_ms);
    if (Number.isFinite(direct) && direct > 0) return Math.min(RETRY_MAX_WAIT_MS, direct);
    const header = /["']?retry-after["']?\s*:\s*"?(\d+(?:\.\d+)?)/i.exec(String(source?.text ?? source?.message ?? source ?? ''));
    if (header && Number(header[1]) > 0) return Math.min(RETRY_MAX_WAIT_MS, Math.round(Number(header[1]) * 1000));
    const seconds = Number(source?.retryAfter ?? source?.retry_after);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(RETRY_MAX_WAIT_MS, Math.round(seconds * 1000));
    if (fallbackMs !== null && fallbackMs !== undefined && Number.isFinite(Number(fallbackMs)) && Number(fallbackMs) >= 0) return Number(fallbackMs);
    return null;
}

/** Пауза перед следующей попыткой: `Retry-After`, иначе 1 / 3 / 8 с. */
export function retryWaitMs(failedAttempt, retryAfterMs = null) {
    if (retryAfterMs !== null && retryAfterMs !== undefined && Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) >= 0) {
        return Math.min(RETRY_MAX_WAIT_MS, Math.round(Number(retryAfterMs)));
    }
    const index = Math.max(0, Math.min(RETRY_WAITS_MS.length - 1, Number(failedAttempt) - 1));
    return RETRY_WAITS_MS[index];
}

/**
 * Сбой → можно ли повторять. Внешний обрыв («Стоп», смена чата) не повторяется
 * никогда; 4xx кроме 408/429 — тоже (это не сеть, а неверный запрос).
 */
export function classifyFailure(error, { signal = null } = {}) {
    if (signal?.aborted) return { retry: false, kind: 'stopped', reason: 'the request was stopped' };
    const message = text(error?.message ?? error);
    const status = Number(error?.status ?? error?.statusCode) || Number(/\bHTTP\s+(\d{3})\b/i.exec(message)?.[1]) || null;
    if (error?.code === 'thinking-cut' || /thinking limit/i.test(message)) {
        return { retry: false, kind: 'thinking-cut', reason: 'the reasoning hit its limit' };
    }
    if (status === 429) {
        return { retry: true, kind: 'rate', status, retryAfterMs: readRetryAfterMs(error), reason: `HTTP 429${message ? `: ${message}` : ''}` };
    }
    if (status && status >= 500) {
        return { retry: true, kind: 'server', status, retryAfterMs: readRetryAfterMs(error), reason: `HTTP ${status}${message ? `: ${message}` : ''}` };
    }
    if (status === 408) {
        return { retry: true, kind: 'timeout', status, retryAfterMs: readRetryAfterMs(error), reason: 'HTTP 408' };
    }
    if (status && status >= 400) {
        return { retry: false, kind: 'request', status, reason: `HTTP ${status}${message ? `: ${message}` : ''}` };
    }
    if (TIMEOUT_FAILURE.test(message) || error?.code === 'ETIMEDOUT' || error?.timeout === true) {
        return { retry: true, kind: 'timeout', retryAfterMs: readRetryAfterMs(error), reason: message || 'timeout' };
    }
    if (NETWORK_FAILURE.test(message) || error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED') {
        return { retry: true, kind: 'network', retryAfterMs: readRetryAfterMs(error), reason: message || 'network failure' };
    }
    return { retry: false, kind: 'unknown', reason: message || 'unknown failure' };
}

/** Пустой ответ: ни текста, ни вызова инструмента. */
export function isEmptyAnswer(answer) {
    if (typeof answer === 'string') return !text(answer);
    return !text(answer?.text) && !(Array.isArray(answer?.toolCalls) && answer.toolCalls.length);
}

/** Ответ обрезан лимитом: текст есть, но он оборван на полуслове (или finish_reason говорит об этом). */
export function isCutAnswer(answer) {
    const finish = text(answer?.finishReason).toLowerCase();
    return finish === 'length' || finish === 'max_tokens' || finish === 'max_output_tokens';
}

/** Настройки роли: лимит попыток, бюджет времени и запасное подключение. */
export function retryConfig(settings, role, budget = null) {
    const retry = settings?.retry && typeof settings.retry === 'object' ? settings.retry : {};
    const blocking = budget === 'turn' || (budget === null && BLOCKING_ROLES.includes(role));
    return {
        role,
        blocking,
        maxAttempts: Math.max(1, Number(retry.maxAttempts) || RETRY_MAX_ATTEMPTS),
        budgetMs: Math.max(1000, Number(blocking ? retry.turnBudgetMs : retry.backgroundBudgetMs) || (blocking ? 120000 : 600000)),
        backupWorkerId: text(retry.backups?.[role]),
    };
}

/** Причина сбоя для журнала: роль, попытка N/3, причина. */
export function retryLine({ role, attempt, maxAttempts, reason }) {
    const roleLabel = text(role) || 'role';
    return `${roleLabel}: retry ${Number(attempt) || 1}/${Number(maxAttempts) || RETRY_MAX_ATTEMPTS} — ${text(reason) || 'unknown reason'}`;
}

/** Ошибка после исчерпанных попыток: причина и, для пустого ответа, последний ответ. */
export class RetryExhaustedError extends Error {
    constructor(message, { kind = 'unknown', attempts = 0, answer = null } = {}) {
        super(message);
        this.name = 'RetryExhaustedError';
        this.code = 'retry-exhausted';
        this.retryKind = kind;
        this.attempts = attempts;
        this.answer = answer;
    }
}
