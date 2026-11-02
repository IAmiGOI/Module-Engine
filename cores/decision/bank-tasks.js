import { bankPromptFor } from '../../libraries/core/decision-banks.js';

const BANK_MAX_TOKENS = 4000;
export const bankSteps = settings => Math.max(2, Number(settings?.researcher?.bankMaxSteps) || 12);
export const bankConcurrency = settings => Math.max(1, Number(settings?.researcher?.bankConcurrency) || 4);

/** Задачи субагента на сборку банков: не больше двух одновременно, как у исследователя. */
export function createBankTasks({ getSettings, researcher, publishEvent }) {
    async function build(source) {
        if (!researcher) throw new Error('The researcher is not available.');
        const settings = getSettings();
        if (!String(settings.researcher?.workerId ?? '').trim()) throw new Error('No researcher connection is configured — the bank keeps its raw source.');
        // Банку не нужны 50 шагов исследования: свой короткий лимит и запас токенов на сам текст банка (и ризонинг).
        const steps = bankSteps(settings);
        const system = bankPromptFor({
            name: source.name, sourceKind: source.sourceKind, source: source.source,
            canonHint: source.canonHint ?? '', aliases: source.aliases ?? '', sizeBand: source.sizeBand ?? 'minor',
            steps,
        });
        const started = researcher.start({ task: 'Build the data bank now.', system, kind: 'bank', notify: false, maxSteps: steps, maxTokens: BANK_MAX_TOKENS });
        if (!started.ok) throw new Error(started.error || 'The bank task did not start.');
        const done = await started.done;
        if (done?.error) throw new Error(done.error);
        const text = String(done?.report ?? '').trim();
        if (!text) throw new Error('The subagent returned an empty bank.');
        publishEvent('decision.bank.ready', { sourceKey: source.sourceKey, name: source.name, text });
        return text;
    }

    /**
     * `onDone(source, text)` / `onError(source, error)` вызываются по мере
     * готовности; промис ждёт все задачи. Таймаут решает вызывающий.
     */
    function runQueue(sources, { concurrency = 2, onDone = async () => {}, onError = async () => {} } = {}) {
        const queue = [...sources];
        const worker = async () => {
            while (queue.length) {
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
