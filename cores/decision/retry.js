import {
    classifyFailure, isEmptyAnswer, isCutAnswer, retryConfig, retryLine, retryWaitMs, RetryExhaustedError,
} from '../../libraries/core/retry-policy.js';

/**
 * Повтор запроса к модели по общему алгоритму части 19. Оборачивает
 * `model.generate` резолвера, «после хода», Советника и Director; писатель и
 * сборщики банков берут те же чистые правила напрямую.
 *
 * `request({ attempt, boost, lowerReasoning, backupWorkerId })` — один запрос.
 * Повтор не пишет состояние: исполнитель применяет изменения только после
 * успешного ответа, поэтому повтор шага не задваивает записи.
 */
export function createRetryRunner({ publishEvent = () => {}, getSettings, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
    function announce({ role, attempt, maxAttempts, reason, kind = null }) {
        const line = retryLine({ role, attempt, maxAttempts, reason });
        publishEvent('decision.retry', { role, attempt, maxAttempts, reason, kind, line, at: now() });
    }

    /**
     * @returns ответ модели (после `normalize`) или `RetryExhaustedError`.
     */
    async function run({ role, budget = null, request, normalize = value => value, signal = null, maxAttempts = null } = {}) {
        if (typeof request !== 'function') throw new Error('createRetryRunner: "request" must be a function.');
        const settings = getSettings?.() ?? {};
        const config = retryConfig(settings, role, budget);
        const limit = Math.max(1, Number(maxAttempts) || config.maxAttempts);
        const startedAt = now();
        let attempt = 0;
        let empties = 0;
        let usedBackup = false;
        let lastEmpty = null;
        let lastError = null;

        while (attempt < limit) {
            if (now() - startedAt > config.budgetMs) {
                throw new RetryExhaustedError(`The ${role} retry budget of ${Math.round(config.budgetMs / 1000)} s ran out.`, {
                    kind: 'budget', attempts: attempt, answer: lastEmpty,
                });
            }
            attempt += 1;
            try {
                const answer = normalize(await request({
                    attempt,
                    boost: empties > 0 ? 2 : 1,
                    lowerReasoning: empties > 0,
                    backupWorkerId: usedBackup ? config.backupWorkerId : '',
                }));
                const empty = isEmptyAnswer(answer);
                const cut = isCutAnswer(answer);
                if (!empty && !cut) return answer;
                lastEmpty = answer;
                if (empties === 0) {
                    empties = 1;
                    announce({
                        role, attempt, maxAttempts: limit, kind: cut ? 'cut' : 'empty',
                        reason: cut
                            ? 'the answer was cut off by the output limit; retrying with a larger output limit and lower reasoning'
                            : 'the answer was empty (likely cut off by the token limit); retrying with a larger output limit and lower reasoning',
                    });
                    continue;
                }
                // Два пустых подряд от одной модели: запасное подключение роли, если оно задано.
                if (config.backupWorkerId && !usedBackup) {
                    usedBackup = true;
                    empties = 0;
                    announce({ role, attempt, maxAttempts: limit, kind: 'backup', reason: `the model returned empty twice; switching to the backup connection "${config.backupWorkerId}"` });
                    continue;
                }
                break;
            } catch (error) {
                lastError = error;
                const failure = classifyFailure(error, { signal });
                if (!failure.retry || attempt >= limit) throw error;
                const waitMs = retryWaitMs(attempt, failure.retryAfterMs);
                if (now() - startedAt + waitMs > config.budgetMs) {
                    throw new RetryExhaustedError(`The ${role} retry budget of ${Math.round(config.budgetMs / 1000)} s ran out after ${failure.reason}.`, {
                        kind: 'budget', attempts: attempt, answer: lastEmpty,
                    });
                }
                announce({ role, attempt, maxAttempts: limit, kind: failure.kind, reason: failure.reason });
                await sleep(waitMs);
            }
        }
        if (lastEmpty) {
            throw new RetryExhaustedError(
                empties > 0
                    ? `The ${role} model returned an empty answer twice${config.backupWorkerId ? ' even on the backup connection' : ''}.`
                    : `The ${role} model returned no usable answer.`,
                { kind: 'empty', attempts: attempt, answer: lastEmpty },
            );
        }
        throw lastError ?? new RetryExhaustedError(`The ${role} model returned no answer.`, { attempts: attempt });
    }

    return { run, announce, config: role => retryConfig(getSettings?.() ?? {}, role) };
}
