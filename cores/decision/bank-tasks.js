import { bankPromptFor } from '../../libraries/core/decision-banks.js';

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
        const started = await startWhenFree({ task: 'Build the data bank now.', system, kind: 'bank', notify: false, maxSteps: steps, maxTokens: BANK_MAX_TOKENS });
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
