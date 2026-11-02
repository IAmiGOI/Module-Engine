import { bankPromptFor } from '../../libraries/core/decision-banks.js';

/** Задачи субагента на сборку банков: не больше двух одновременно, как у исследователя. */
export function createBankTasks({ getSettings, researcher, publishEvent }) {
    async function build(source) {
        if (!researcher) throw new Error('The researcher is not available.');
        const settings = getSettings();
        if (!String(settings.researcher?.workerId ?? '').trim()) throw new Error('No researcher connection is configured — the bank keeps its raw source.');
        const system = bankPromptFor({
            name: source.name, sourceKind: source.sourceKind, source: source.source,
            canonHint: source.canonHint ?? '', aliases: source.aliases ?? '', sizeBand: source.sizeBand ?? 'minor',
            steps: settings.researcher.maxSteps,
        });
        const started = researcher.start({ task: 'Build the data bank now.', system, kind: 'bank', notify: false });
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
