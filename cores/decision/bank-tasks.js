import { bankPromptFor } from '../../libraries/core/decision-banks.js';
import { classifyFailure, retryConfig, retryLine, retryWaitMs } from '../../libraries/core/retry-policy.js';

const BANK_MAX_TOKENS = 4000;
// Свой лимит банка: 12 не успевали найти канон, а 50 шагов исследователя растягивали один банк на 10+ минут.
export const BANK_STEPS_DEFAULT = 20;
export const bankSteps = settings => Math.max(2, Number(settings?.researcher?.bankMaxSteps) || BANK_STEPS_DEFAULT);
export const bankConcurrency = settings => Math.max(1, Number(settings?.researcher?.bankConcurrency) || 4);

/** Задачи субагента на сборку банков: свой лимит, отдельно от двух слотов исследователя. */
const SLOT_WAIT_MS = 2000;
const SLOT_WAIT_LIMIT_MS = 30 * 60 * 1000;

export function createBankTasks({ getSettings, researcher, publishEvent, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    // Все сборщики заняты — ждём место, а не падаем: раньше банк нового персонажа ростера навсегда оставался ошибкой «busy».
    async function startWhenFree(options) {
        const startedAt = Date.now();
        for (;;) {
            const started = researcher.start(options);
            if (started.ok || !/busy/i.test(String(started.error ?? ''))) return started;
            if (Date.now() - startedAt > SLOT_WAIT_LIMIT_MS) return started;
            await sleep(SLOT_WAIT_MS);
        }
    }

    async function build(source) {
        if (!researcher) throw new Error('The researcher is not available.');
        const settings = getSettings();
        if (!String(settings.researcher?.workerId ?? '').trim()) throw new Error('No researcher connection is configured — the bank keeps its raw source.');
        // Банку не нужны 50 шагов исследования: свой короткий лимит и запас токенов на сам текст банка (и ризонинг).
        const steps = bankSteps(settings);
        const system = bankPromptFor({
            name: source.name, sourceKind: source.sourceKind, source: source.source,
            canonHint: source.canonHint ?? '', aliases: source.aliases ?? '', timeline: source.timeline ?? '', guide: source.guide ?? '',
            sizeBand: source.sizeBand ?? 'minor', steps,
        });
        publishEvent('decision.bank.started', { sourceKey: source.sourceKey, name: source.name });
        // Сборщик — фоновая роль части 19: сеть/5xx/429 повторяются с паузой, пустой банк — один раз с большим лимитом.
        const config = retryConfig(settings, 'banks', 'background');
        let attempt = 0;
        let maxTokens = BANK_MAX_TOKENS;
        let workerId = null;
        let lastError = null;
        while (attempt < config.maxAttempts) {
            attempt += 1;
            try {
                const started = await startWhenFree({
                    task: 'Build the data bank now.', system, kind: 'bank', notify: false, maxSteps: steps, maxTokens,
                    ...(workerId ? { workerId } : {}),
                });
                if (!started.ok) throw new Error(started.error || 'The bank task did not start.');
                const done = await started.done;
                if (done?.error) throw new Error(done.error);
                const text = String(done?.report ?? '').trim();
                if (!text) {
                    lastError = new Error('The subagent returned an empty bank.');
                    if (attempt < config.maxAttempts) {
                        maxTokens = Math.min(32768, maxTokens * 2);
                        // Второй пустой банк — запасное подключение сборщика, если оно задано.
                        if (attempt >= 2 && config.backupWorkerId) workerId = config.backupWorkerId;
                        publishEvent('decision.retry', {
                            role: 'banks', attempt, maxAttempts: config.maxAttempts, kind: 'empty',
                            reason: 'the subagent returned an empty bank; retrying with a larger output limit',
                            line: retryLine({ role: 'banks', attempt, maxAttempts: config.maxAttempts, reason: 'the subagent returned an empty bank' }),
                            at: Date.now(),
                        });
                        continue;
                    }
                    throw lastError;
                }
                publishEvent('decision.bank.ready', { sourceKey: source.sourceKey, name: source.name, text });
                return text;
            } catch (error) {
                lastError = error;
                const failure = classifyFailure(error);
                if (!failure.retry || attempt >= config.maxAttempts) throw error;
                publishEvent('decision.retry', {
                    role: 'banks', attempt, maxAttempts: config.maxAttempts, kind: failure.kind, reason: failure.reason,
                    line: retryLine({ role: 'banks', attempt, maxAttempts: config.maxAttempts, reason: failure.reason }), at: Date.now(),
                });
                await sleep(retryWaitMs(attempt, failure.retryAfterMs));
            }
        }
        throw lastError ?? new Error('The bank task did not start.');
    }

    /**
     * `onDone(source, text)` / `onError(source, error)` вызываются по мере
     * готовности; промис ждёт все задачи. Таймаут решает вызывающий.
     */
    function runQueue(sources, { concurrency = 2, onDone = async () => {}, onError = async () => {}, isCurrent = () => true } = {}) {
        const queue = [...sources];
        const worker = async () => {
            // Чат сменился — очередь старого чата больше не берёт новых банков.
            while (queue.length && isCurrent()) {
                const source = queue.shift();
                try {
                    const text = await build(source);
                    await onDone(source, text);
                } catch (error) {
                    await onError(source, error);
                }
            }
        };
        return Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, sources.length)) }, worker));
    }

    return { build, runQueue };
}
