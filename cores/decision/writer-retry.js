import {
    classifyFailure, isEmptyAnswer, retryConfig, retryLine, retryWaitMs, RetryExhaustedError,
} from '../../libraries/core/retry-policy.js';

/**
 * Повторы писателя (часть 19). Проверенный путь держит поток у себя, поэтому
 * повтор безопасен: ни один кадр ещё не ушёл в ST и состояние не менялось.
 * Сеть/5xx/429/тайм-аут/обрыв — общая пауза 1/3/8 с; пустой ответ — один
 * повтор с большим лимитом; два пустых подряд — запасное подключение писателя.
 */
export function createWriterRetry({ getSettings, publishEvent = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
    function announce({ attempt, maxAttempts, reason, kind }) {
        publishEvent('decision.retry', {
            role: 'writer', attempt, maxAttempts, reason, kind,
            line: retryLine({ role: 'writer', attempt, maxAttempts, reason }), at: now(),
        });
    }

    async function run({ request } = {}) {
        const config = retryConfig(getSettings?.() ?? {}, 'writer', 'turn');
        let attempt = 0;
        let empties = 0;
        let usedBackup = false;
        let lastEmpty = null;
        let lastError = null;
        while (attempt < config.maxAttempts) {
            attempt += 1;
            try {
                const answer = await request({
                    attempt,
                    boost: empties > 0 ? 2 : 1,
                    backupWorkerId: usedBackup ? config.backupWorkerId : '',
                });
                if (!isEmptyAnswer(answer?.text ?? answer)) return answer;
                lastEmpty = answer;
                if (empties === 0) {
                    empties = 1;
                    announce({ attempt, maxAttempts: config.maxAttempts, kind: 'empty', reason: 'the writer returned empty text; retrying with a larger output limit' });
                    continue;
                }
                if (config.backupWorkerId && !usedBackup) {
                    usedBackup = true;
                    empties = 0;
                    announce({ attempt, maxAttempts: config.maxAttempts, kind: 'backup', reason: `the writer returned empty twice; switching to the backup connection "${config.backupWorkerId}"` });
                    continue;
                }
                break;
            } catch (error) {
                lastError = error;
                const failure = classifyFailure(error);
                if (!failure.retry || attempt >= config.maxAttempts) throw error;
                announce({ attempt, maxAttempts: config.maxAttempts, kind: failure.kind, reason: failure.reason });
                await sleep(retryWaitMs(attempt, failure.retryAfterMs));
            }
        }
        if (lastEmpty) {
            throw new RetryExhaustedError(`The writer returned an empty reply${config.backupWorkerId ? ' even on the backup connection' : ''}.`, {
                kind: 'empty', attempts: attempt, answer: lastEmpty,
            });
        }
        throw lastError ?? new RetryExhaustedError('The writer returned no reply.', { attempts: attempt });
    }

    return { run, config: () => retryConfig(getSettings?.() ?? {}, 'writer', 'turn') };
}

/** Ошибка ответа писателя с `status` и `Retry-After` — её читает общий классификатор. */
export function writerFailure(id, status, text) {
    const error = new Error(`Writer connection "${id}" replied with HTTP ${status}.`);
    error.status = Number(status) || null;
    error.text = String(text ?? '');
    return error;
}
