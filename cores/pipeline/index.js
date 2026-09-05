import { computeStageLevels, runPipeline } from '../../libraries/core/pipeline-runner.js';

/**
 * Ядро пайплайнов (CORES.md, PIPELINE.md) — генерический исполнитель
 * объявленного набора этапов. Оно НЕ знает ни про генерацию, ни про промпт,
 * ни про ST: Ядро жизненного цикла генерации — его первый потребитель, а не
 * владелец. Любое Ядро/Модуль может определить свой пайплайн и получить тот
 * же DAG/цепочку с той же обработкой отказов.
 *
 * **Реестр этапов ЕСТЬ Блок** (ARCHITECTURE.md, «Блоки — организующая
 * единица внутри любой шины»). Отдельной сущности «Блок prompt-contributions»
 * рядом с пайплайном не заводится: `pipeline.stages.add` и есть регистрация
 * в блоке, а смена состава публикует `pipeline.stagesChanged` — ровно тот
 * сигнал «Блок изменился целиком», который описан в архитектуре. Поэтому
 * «новое Ядро/Модуль участвует в сборке промпта без единой правки в Prompt
 * Manager» получается само, без второго механизма discovery.
 *
 * **Этап исполняется под правами СВОЕГО владельца, а не Ядра пайплайнов.**
 * Владелец берётся не из `params` (их пишет сам вызывающий — подделал бы
 * чужое имя в одну строку), а от Директора, который единственный знает
 * настоящего отправителя. Исполняет `resolveAs()` — привилегированная
 * возможность, выдаваемая при сборке движка ровно этому Ядру (та же форма,
 * что `publish` у Ядра событий). Без неё пайплайн был бы отмывочной для
 * прав: достаточно объявить этап — и дотянешься куда угодно чужими руками.
 *
 * **Таймаут — динамический**, как требует PIPELINE.md. Ядра статистики ещё
 * нет, поэтому здесь ровно тот шов, который оно потом займёт: если контракт
 * `statistics.expectedDuration` зарегистрирован — спрашиваем его; если нет —
 * считаем сами по своим же замерам этого этапа (каждый прогон публикует
 * `durationMs`). Появится Ядро статистики — этот код не изменится, оно
 * просто станет поставщиком контракта.
 */

const STATS_CONTRACT = 'statistics.expectedDuration';
/** Границы динамического таймаута. `slack` — во сколько раз этапу дают больше его обычного времени, прежде чем считать зависшим. Настраиваются (Раннер вправе иначе, тесты — чтобы не ждать секундами), но НЕ отключаются. */
export const DEFAULT_TIMEOUTS = Object.freeze({ minMs: 2000, maxMs: 120000, slack: 4 });
/** Вес свежего замера в скользящем среднем — новое поведение провайдера должно проступать за несколько прогонов, а не за сотню. */
const EMA_ALPHA = 0.3;

export function createPipelineCore(host, { publish, resolveAs, timeouts } = {}) {
    const { minMs, maxMs, slack } = { ...DEFAULT_TIMEOUTS, ...(timeouts ?? {}) };
    if (typeof resolveAs !== 'function') {
        throw new Error('createPipelineCore: needs resolveAs() — a pipeline executes stages owned by OTHER callers, and running them under its own identity would launder rights.');
    }
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    const pipelines = new Map(); // id -> { id, mode, description, stages: Map<stageId, stage> }
    const durations = new Map(); // `${pipelineId}:${stageId}` -> ms (скользящее среднее)
    let runCounter = 0;

    function requirePipeline(id) {
        const pipeline = pipelines.get(id);
        if (!pipeline) throw new Error(`pipeline "${id}" is not defined.`);
        return pipeline;
    }

    function describeStage(stage) {
        return {
            id: stage.id,
            contract: stage.contract,
            needs: [...(stage.needs ?? [])],
            owner: stage.owner,
            onExhausted: stage.onExhausted,
            fallbacks: (stage.fallbacks ?? []).length,
        };
    }

    function define({ id, mode = 'collect', description = '' } = {}) {
        const pipelineId = String(id ?? '').trim();
        if (!pipelineId) throw new Error('pipeline.define: "id" is required.');
        if (mode !== 'collect' && mode !== 'fold') throw new Error(`pipeline.define: unknown mode "${mode}" (expected "collect" or "fold").`);
        // Повторное определение НЕ стирает уже зарегистрированные этапы:
        // порядок сборки движка не должен решать, чей вклад выживет.
        const existing = pipelines.get(pipelineId);
        pipelines.set(pipelineId, { id: pipelineId, mode, description, stages: existing?.stages ?? new Map() });
        return pipelineId;
    }

    function stagesOf(pipelineId) {
        return [...requirePipeline(pipelineId).stages.values()];
    }

    function addStage({ pipelineId, stage } = {}, owner) {
        const pipeline = requirePipeline(pipelineId);
        const stageId = String(stage?.id ?? '').trim();
        if (!stageId) throw new Error('pipeline.stages.add: stage "id" is required.');
        if (!String(stage?.contract ?? '').trim()) throw new Error(`pipeline.stages.add: stage "${stageId}" has no contract to call.`);
        const onExhausted = stage.onExhausted ?? 'abort';
        if (onExhausted !== 'abort' && onExhausted !== 'flag') throw new Error(`pipeline.stages.add: unknown onExhausted "${onExhausted}" (expected "abort" or "flag").`);

        const entry = {
            id: stageId,
            contract: stage.contract,
            params: stage.params ?? {},
            needs: [...(stage.needs ?? [])],
            fallbacks: [...(stage.fallbacks ?? [])],
            onExhausted,
            owner,
        };
        const next = new Map(pipeline.stages);
        next.set(stageId, entry);
        // Граф проверяется на ДОБАВЛЕНИИ, а не на прогоне: цикл или ссылка в
        // пустоту это ошибка того, кто регистрирует, и он должен узнать о ней
        // сразу, а не когда чья-то генерация не поедет.
        computeStageLevels([...next.values()]);
        pipeline.stages = next;

        publishEvent('pipeline.stagesChanged', { pipelineId, stages: pipeline.stages.size, added: stageId, owner });
        return stageId;
    }

    function removeStage({ pipelineId, stageId } = {}) {
        const pipeline = requirePipeline(pipelineId);
        if (!pipeline.stages.delete(stageId)) return false;
        publishEvent('pipeline.stagesChanged', { pipelineId, stages: pipeline.stages.size, removed: stageId });
        return true;
    }

    /** Знает ли кто-нибудь на нашей шине про статистику. Спрашиваем Директора, а не держим флаг. */
    function statisticsAvailable() {
        return (host.own.contracts?.() ?? []).some(entry => entry.contract === STATS_CONTRACT);
    }

    function rememberDuration(key, durationMs) {
        const previous = durations.get(key);
        durations.set(key, previous === undefined ? durationMs : Math.round(previous * (1 - EMA_ALPHA) + durationMs * EMA_ALPHA));
    }

    function clampTimeout(expectedMs) {
        return Math.min(maxMs, Math.max(minMs, Math.round(expectedMs * slack)));
    }

    async function resolveTimeoutFor(pipelineId, stage) {
        const key = `${pipelineId}:${stage.id}`;
        if (statisticsAvailable()) {
            const result = await resolveAs('core.pipeline', STATS_CONTRACT, { scope: 'pipeline.stage', key });
            if (result.ok && Number.isFinite(result.value)) return clampTimeout(result.value);
        }
        const own = durations.get(key);
        return own === undefined ? maxMs : clampTimeout(own);
    }

    async function run({ pipelineId, input = null } = {}) {
        const pipeline = requirePipeline(pipelineId);
        runCounter += 1;
        const runId = `pipe_${runCounter}`;
        const startedAt = Date.now();
        const stages = [...pipeline.stages.values()];
        publishEvent('pipeline.started', { pipelineId, runId, mode: pipeline.mode, stages: stages.length });

        const stageOwner = new Map(stages.map(stage => [stage.id, stage.owner]));
        const result = await runPipeline({
            stages,
            mode: pipeline.mode,
            input,
            // Вот та единственная точка, где объявление превращается в
            // работу — и она идёт ПОД ЛИЧНОСТЬЮ владельца этапа.
            execute: ({ stageId, contract, params }) => resolveAs(stageOwner.get(stageId), contract, params),
            resolveTimeout: ({ stage }) => resolveTimeoutFor(pipelineId, stage),
            onEvent: (name, payload) => {
                if (name === 'stageFinished') rememberDuration(`${pipelineId}:${payload.stageId}`, payload.attemptDurationMs);
                publishEvent(`pipeline.${name}`, { pipelineId, runId, ...payload });
            },
        });

        publishEvent('pipeline.finished', {
            pipelineId,
            runId,
            ok: result.ok,
            durationMs: Date.now() - startedAt,
            flagged: result.flagged,
            failedStage: result.failedStage ?? null,
        });
        return { runId, ...result };
    }

    const unregisters = [
        host.own.register('pipeline.define', params => define(params)),
        host.own.register('pipeline.list', () => [...pipelines.values()].map(pipeline => ({ id: pipeline.id, mode: pipeline.mode, description: pipeline.description, stages: pipeline.stages.size }))),
        // Содержимое Блока — то, что потребитель перезапрашивает по сигналу
        // `pipeline.stagesChanged`.
        host.own.register('pipeline.stages', params => stagesOf(params?.pipelineId).map(describeStage)),
        host.own.register('pipeline.stages.add', (params, meta) => addStage(params, meta?.callerId ?? 'unknown')),
        host.own.register('pipeline.stages.remove', params => removeStage(params)),
        host.own.register('pipeline.run', params => run(params)),
    ];

    return {
        define,
        addStage: (params, owner = 'core.pipeline') => addStage(params, owner),
        removeStage,
        stages: pipelineId => stagesOf(pipelineId).map(describeStage),
        run,
        unregister: () => { for (const unregister of unregisters) unregister(); },
    };
}
