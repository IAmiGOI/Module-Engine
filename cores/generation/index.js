import { request } from '../../libraries/shared/request.js';

const MAX_REMEMBERED_RUNS = 20;

/** Стадии одного прогона. `toolCall`/`toolResult` — не стадии: они происходят ВНУТРИ прогона и повторяются. */
export const STAGES = Object.freeze(['beforeSend', 'sending', 'completed']);

/**
 * Ядро жизненного цикла генерации (CORES.md, PIPELINE.md) — владелец
 * ИСТИННОГО состояния «на какой точке прогона мы сейчас». Читает уже
 * мостированные события ST (`st.generationStarted` и т.д. — см. Ядро
 * событий) и превращает их в четыре именованных события пайплайна, плюс
 * ведёт учёт вызовов инструментов.
 *
 * **Про ToolCalls.** У SillyTavern есть `TOOL_CALLS_PERFORMED`/
 * `TOOL_CALLS_RENDERED`, но мостить их бессмысленно: оба срабатывают ОДИН
 * раз на всю пачку и УЖЕ ПОСЛЕ исполнения, отдавая массив успешных
 * инвокаций — упавшие вызовы и stealth-инструменты туда не попадают вовсе
 * (проверено по исходнику ST 1.16.0, scripts/tool-calling.js). Ни узнать о
 * вызове до исполнения, ни увидеть отказ, ни измерить время по ним нельзя.
 * Поэтому инструменты в движке регистрируются
 * ЧЕРЕЗ него (`registerTool()`, и Гейт-проверяемый `generation.registerTool`
 * для Модулей), а он оборачивает `action` определения. Поэтому вызов и
 * результат объявляются САМИ, и ни Ядру, ни Модулю не нужно помнить про
 * доклад — им остаётся только их собственная работа (то же правило
 * «минимум обработок на стороне потребителя», что и с `when` у Директора).
 * `reportToolCall()`/`reportToolResult()` остаются открытыми как запасной
 * путь для инструмента, зарегистрированного мимо движка.
 *
 * **Вызовов за прогон может быть несколько**, поэтому это последовательность,
 * а не флаг: у каждого свой `index` внутри прогона и свой `callId`, прогон
 * не считается завершённым из-за того, что один инструмент отработал, и
 * `generation.toolCall` может сработать сколько угодно раз между
 * `beforeSend` и `completed`. Вызов и его РЕЗУЛЬТАТ — разные моменты, и
 * работать нужно с обоими (см. решение по PIPELINE.md), поэтому единая
 * точка «toolCall» из документа реализована парой событий.
 *
 * **Оркестрация вкладов здесь не живёт.** Это Ядро владеет МОМЕНТАМИ, а не
 * тем, что в них происходит: на своих точках оно просто запускает пайплайн
 * с фиксированным именем ([Ядро пайплайнов](../pipeline/index.js)), а кто
 * туда зарегистрировал этапы, в каком порядке они пойдут, что делать при
 * отказе и как считать таймаут — не его дело. То же правило «минимум
 * обработок у потребителя», что и с `when` у Директора.
 *
 * **Отправка — наша.** `install()` ставит через [Сервис перехвата](../../services/st-generation.js)
 * обе точки, и с этого момента генерация ST реально проходит через движок:
 *
 *  - в перехватчике (`generate_interceptor`, ST его `await`-ит) исполняется
 *    `generation.beforeSend` с настоящими `chat`/`contextSize`/`type`, и
 *    отказ пайплайна вызывает `abort()` — генерации в этом цикле не будет;
 *  - на самой отправке исполняется `generation.payload` — цепочка `fold` над
 *    ИСХОДЯЩИМ телом запроса, так что вклад доходит до провайдера, а не
 *    остаётся благим намерением. Отказ здесь отменяет уже саму отправку.
 *
 * Важная деталь ST, из-за которой прогон иначе завис бы навсегда: отмена
 * через перехватчик НЕ эмитит `GENERATION_ENDED` — ST просто разблокирует
 * интерфейс и выходит. Поэтому прогон закрываем мы сами, исходом `aborted`.
 */
/**
 * «Обновить своё состояние перед ответом» — момент ДО сборки вкладов, и
 * выходы его этапов НИКУДА НЕ ИДУТ.
 *
 * Существует отдельно от `beforeSend` потому, что это разные роли, и путать
 * их вредно. Трекер, например, не вкладчик в промпт: его дело — попасть на
 * ШИНУ (`tracking.blocks.changed` + макрос), а дальше значение читают те, кому
 * оно нужно — плавающая панель, макросы ST, позже Prompt Manager. Регистрируй
 * он себя вкладом, его выход оказался бы в карте вкладов сборки промпта, то
 * есть он приписал бы себе чужую роль.
 *
 * Ждать его при этом надо по-настоящему: чтобы `{{tracker_health}}` был
 * свежим К ЭТОМУ промпту, опрос обязан завершиться до того, как ST начнёт
 * собирать промпт. Отсюда и пайплайн, а не подписка.
 */
export const PREPARE_PIPELINE = 'generation.prepare';
export const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
export const PAYLOAD_PIPELINE = 'generation.payload';
export const COMPLETED_PIPELINE = 'generation.completed';

/** Обязано совпадать с полем `generate_interceptor` в manifest.json — ST ищет функцию ПО ЭТОМУ имени и молча идёт дальше, если не находит. */
export const INTERCEPTOR_NAME = 'stModuleEngineBetaGenerateInterceptor';

export function createGenerationCore(host, { publish, pipelines, interceptorName = INTERCEPTOR_NAME } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    // Все три пайплайна объявляются СРАЗУ, ещё пустыми: вкладчик (Ядро или
    // Модуль) должен иметь куда зарегистрироваться независимо от того, кто
    // собрался раньше. Оркестрацию их этапов это Ядро не пишет вообще — она
    // целиком в Ядре пайплайнов, здесь только имена и моменты.
    pipelines?.define({ id: PREPARE_PIPELINE, mode: 'collect', description: 'Refresh own state before the reply — outputs are not used' });
    pipelines?.define({ id: BEFORE_SEND_PIPELINE, mode: 'collect', description: 'Contributions gathered while the generation is held' });
    pipelines?.define({ id: PAYLOAD_PIPELINE, mode: 'fold', description: 'Rewrite chain over the outgoing request body' });
    pipelines?.define({ id: COMPLETED_PIPELINE, mode: 'fold', description: 'Post-processing chain over a finished run' });

    let current = null;
    let runCounter = 0;
    const beforeSendRuns = new Map(); // runId -> Promise результата сборки вкладов
    let installed = false;
    const finished = [];
    const waiters = new Map(); // runId -> [resolve]
    const subscriptions = [];
    const registeredTools = new Set(); // чтобы снять свои инструменты при разборке, а не оставить их висеть в ST

    function snapshot(run) {
        return run && { ...run, toolCalls: run.toolCalls.map(call => ({ ...call })) };
    }

    function settle(run, outcome) {
        run.stage = 'completed';
        run.outcome = outcome;
        run.endedAt = Date.now();
        finished.unshift(run);
        finished.length = Math.min(finished.length, MAX_REMEMBERED_RUNS);
        // Вытесненный прогон — НЕ законченная генерация, и объявлять его как
        // `generation.completed` нельзя: подписчик на «ответ готов» сработал
        // бы дважды за один ответ. Ровно это и случалось — определитель
        // времени тикал и до, и после генерации, потому что ST открывает
        // прогон ещё и на сухой прогон, а тот вытеснялся настоящим.
        publishEvent(outcome === 'superseded' ? 'generation.superseded' : 'generation.completed',
            { runId: run.runId, outcome, toolCalls: run.toolCalls.length });
        // Пост-обработка — цепочка переписывания (PIPELINE.md), поэтому
        // `fold`. Переносимое значение сейчас — снимок прогона: это честно
        // всё, что движок про прогон знает, пока сама отправка не наша.
        pipelines?.run({ pipelineId: COMPLETED_PIPELINE, input: snapshot(run) });
        beforeSendRuns.delete(run.runId);
        for (const resolve of waiters.get(run.runId) ?? []) resolve(snapshot(run));
        waiters.delete(run.runId);
    }

    function startRun() {
        // ST умеет начать новый прогон, не закрыв предыдущий (прерванная
        // генерация, свайп поверх свайпа). Прогон, оставшийся открытым,
        // закрывается как вытесненный — иначе он висел бы вечно, и всё, что
        // ждёт его завершения, не дождалось бы никогда.
        if (current) settle(current, 'superseded');
        runCounter += 1;
        current = { runId: `run_${runCounter}`, stage: 'beforeSend', startedAt: Date.now(), endedAt: null, outcome: null, toolCalls: [] };
        publishEvent('generation.beforeSend', { runId: current.runId });
        // Сборку вкладов здесь НЕ запускаем. `GENERATION_STARTED` у ST
        // приходит раньше перехватчика, и в этот момент нет ни `chat`, ни
        // размера контекста — то есть нечего дать вкладчикам на вход. Пайплайн
        // стартует в перехватчике, где эти данные настоящие (и где ST нас
        // реально ждёт). Момент и работа — разные вещи.
        return current;
    }

    function advanceToSending() {
        if (!current) return;
        current.stage = 'sending';
        publishEvent('generation.sending', { runId: current.runId });
    }

    function endRun(outcome) {
        if (!current) return; // конец без начала: мы подключились в середине прогона — терять нечего
        const run = current;
        current = null;
        settle(run, outcome);
    }

    /** Инструмент ВЫЗВАН. Возвращает `callId`, который потом нужен для доклада о результате. */
    function reportToolCall({ tool, args } = {}) {
        const name = String(tool ?? '').trim();
        if (!name) throw new Error('generation.reportToolCall: "tool" is required.');
        const run = current;
        const index = run ? run.toolCalls.length : 0;
        const callId = `${run?.runId ?? 'run_none'}:${index}`;
        const call = { callId, index, tool: name, args, startedAt: Date.now(), result: undefined, error: null, durationMs: null };
        // Вызов вне активного прогона не выбрасывается: сигнал реальный, и
        // терять его хуже, чем принять с `runId: null`.
        run?.toolCalls.push(call);
        publishEvent('generation.toolCall', { runId: run?.runId ?? null, callId, index, tool: name, args });
        return callId;
    }

    /** У инструмента ЕСТЬ результат — отдельный момент от самого вызова, и работать нужно именно с ним. */
    function reportToolResult({ callId, result, error } = {}) {
        const call = current?.toolCalls.find(item => item.callId === callId);
        if (call) {
            call.result = result;
            call.error = error ?? null;
            call.durationMs = Date.now() - call.startedAt;
        }
        publishEvent('generation.toolResult', {
            runId: current?.runId ?? null,
            callId,
            index: call?.index ?? null,
            tool: call?.tool ?? null,
            result,
            error: error ?? null,
            durationMs: call?.durationMs ?? null,
        });
        return true;
    }

    /**
     * Регистрирует инструмент в ST ЧЕРЕЗ движок: `action` оборачивается так,
     * что каждый его вызов сам объявляет `generation.toolCall`, а возврат или
     * ошибка — `generation.toolResult`. Вызывающему остаётся только написать
     * сам инструмент. Ошибка инструмента пробрасывается дальше в ST после
     * доклада: подменять поведение инструмента — не наше дело.
     */
    async function registerTool(definition) {
        const name = String(definition?.name ?? '').trim();
        if (!name) throw new Error('generation.registerTool: "name" is required.');
        if (typeof definition.action !== 'function') throw new Error(`generation.registerTool: tool "${name}" has no action().`);

        const action = definition.action;
        const instrumented = {
            ...definition,
            action: async args => {
                const callId = reportToolCall({ tool: name, args });
                try {
                    const result = await action(args);
                    reportToolResult({ callId, result });
                    return result;
                } catch (error) {
                    reportToolResult({ callId, error: error?.message ?? String(error) });
                    throw error;
                }
            },
        };

        const result = await request(host.services, 'stTools.register', { params: { definition: instrumented } });
        if (!result.ok) throw new Error(result.error.message);
        registeredTools.add(name);
        return name;
    }

    async function unregisterTool(name) {
        registeredTools.delete(name);
        const result = await request(host.services, 'stTools.unregister', { params: { name } });
        if (!result.ok) throw new Error(result.error.message);
        return true;
    }

    /**
     * Промис на результат сборки вкладов — тот самый, которого ждёт перехватчик,
     * держа генерацию. Для УЖЕ закончившегося прогона отдаётся сохранённый на
     * нём результат: промис к тому моменту убран, но «что тогда собралось»
     * остаётся законным вопросом (и для пост-обработки, и для панели).
     */
    function awaitBeforeSend(runId) {
        const targetId = runId ?? current?.runId;
        const pending = beforeSendRuns.get(targetId);
        if (pending) return pending;
        return Promise.resolve(finished.find(run => run.runId === targetId)?.contributions ?? null);
    }

    /**
     * Момент, когда ST УЖЕ ЖДЁТ нас, но ещё ничего не собрал. Здесь исполняется
     * сборка вкладов с настоящими данными и здесь же принимается решение
     * «генерации не будет». `chat` — мутируемая КОПИЯ истории (см. Сервис
     * перехвата), так что этап вправе её править: промпт изменится, сохранённый
     * чат — нет.
     */
    async function onIntercept({ chat, contextSize, abort, type }) {
        // Обычно прогон уже открыт (`GENERATION_STARTED` приходит раньше), но
        // подключиться к ST мы могли и посреди генерации — тогда открываем сами,
        // иначе вкладам некуда было бы привязаться.
        const run = current ?? startRun();
        if (!pipelines) return null;

        // Сначала все, кому надо освежить СВОЁ состояние (трекеры), и только
        // потом сборка вкладов. Порядок именно такой: вкладчик вправе читать
        // уже обновлённое значение, обратное — бессмысленно. Выходы этого
        // прогона намеренно отбрасываются: его участники продукт кладут на
        // шину, а не возвращают сюда.
        const prepared = await pipelines.run({ pipelineId: PREPARE_PIPELINE, input: { runId: run.runId, chat, contextSize, type } });
        if (!prepared.ok) publishEvent('generation.prepareFailed', { runId: run.runId, stage: prepared.failedStage, error: prepared.error });

        const pipelineRun = pipelines.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { runId: run.runId, chat, contextSize, type } });
        beforeSendRuns.set(run.runId, pipelineRun);
        const result = await pipelineRun;
        run.contributions = result; // остаётся на прогоне и после его конца — см. awaitBeforeSend()

        if (result.ok) return result;
        // `true` — прервать немедленно, не спрашивая остальные перехватчики:
        // раз обязательный вклад не собрался, спрашивать дальше нечего.
        abort?.(true);
        publishEvent('generation.aborted', { runId: run.runId, stage: result.failedStage, error: result.error });
        // ST на этой ветке НЕ эмитит `GENERATION_ENDED` — просто разблокирует
        // интерфейс и выходит. Не закрой мы прогон сами, он висел бы вечно, и
        // всё, что ждёт `awaitCompletion()`, не дождалось бы никогда.
        endRun('aborted');
        return result;
    }

    /**
     * Само тело исходящего запроса, за миг до отправки. Цепочка `fold`:
     * каждый этап получает текущее тело и возвращает новое. Отказ — отмена
     * отправки, а не тихая отправка неполного промпта.
     */
    async function onSend({ endpoint, payload }) {
        publishEvent('generation.sending', { runId: current?.runId ?? null, endpoint });
        if (!pipelines) return { payload };

        const result = await pipelines.run({ pipelineId: PAYLOAD_PIPELINE, input: payload });
        if (!result.ok) {
            publishEvent('generation.aborted', { runId: current?.runId ?? null, stage: result.failedStage, error: result.error });
            endRun('aborted');
            return { cancel: true, reason: result.error.message };
        }
        return { payload: result.value };
    }

    /** Забирает у ST обе точки. До вызова движок только слушает; после — генерация физически проходит через него. */
    async function install() {
        const interceptor = await request(host.services, 'stGeneration.installInterceptor', {
            params: { name: interceptorName, handler: onIntercept },
        });
        if (!interceptor.ok) throw new Error(interceptor.error.message);
        const hook = await request(host.services, 'stGeneration.installSendHook', { params: { handler: onSend } });
        if (!hook.ok) throw new Error(hook.error.message);
        installed = true;
        return { interceptor: interceptorName };
    }

    async function uninstall() {
        if (!installed) return false;
        installed = false;
        await request(host.services, 'stGeneration.uninstallSendHook', { params: {} });
        await request(host.services, 'stGeneration.uninstallInterceptor', { params: { name: interceptorName } });
        return true;
    }

    /** Промис на завершение конкретного прогона (или текущего, если id не задан). Уже завершившийся прогон отдаётся сразу. */
    function awaitCompletion(runId) {
        const targetId = runId ?? current?.runId;
        if (!targetId) return Promise.resolve(null);
        const already = finished.find(run => run.runId === targetId);
        if (already) return Promise.resolve(snapshot(already));
        return new Promise(resolve => waiters.set(targetId, [...(waiters.get(targetId) ?? []), resolve]));
    }

    /**
     * Подписка на сырую Шину событий — намеренно: это Ядро не «опрашивает
     * контракт по условию» (для такого есть `when` Директора), а переводит
     * внешние события в состояние. Оно само — часть событийной машинерии.
     */
    function listen() {
        subscriptions.push(
            // СУХОЙ прогон пропускается. ST шлёт `GENERATION_STARTED` и на него
            // тоже (её собственный комментарий: «Occurs every time, even if the
            // generation is aborted»), третьим аргументом идёт `dryRun`, и конца
            // у такого прогона не бывает вовсе. Открой мы его — он остался бы
            // висеть до следующей настоящей генерации и был бы ею вытеснен.
            host.events.subscribe('st.generationStarted', payload => { if (!payload?.args?.[2]) startRun(); }),
            host.events.subscribe('st.generateAfterCombinePrompts', () => advanceToSending()),
            host.events.subscribe('st.generationEnded', () => endRun('ended')),
            host.events.subscribe('st.generationStopped', () => endRun('stopped')),
        );
    }

    function stop() {
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    }

    const unregisters = [
        host.own.register('generation.current', () => snapshot(current)),
        host.own.register('generation.runs', () => finished.map(snapshot)),
        host.own.register('generation.registerTool', params => registerTool(params?.definition)),
        host.own.register('generation.unregisterTool', params => unregisterTool(params?.name)),
        host.own.register('generation.reportToolCall', params => reportToolCall(params)),
        host.own.register('generation.reportToolResult', params => reportToolResult(params)),
        /** Держим ли мы отправку прямо сейчас — панель спрашивает, а не догадывается. */
        host.own.register('generation.intercepting', () => installed),
    ];

    listen();

    return {
        registerTool,
        unregisterTool,
        reportToolCall,
        reportToolResult,
        awaitBeforeSend,
        awaitCompletion,
        install,
        uninstall,
        onIntercept,
        onSend,
        current: () => snapshot(current),
        runs: () => finished.map(snapshot),
        stop,
        unregister: async () => {
            stop();
            await uninstall().catch(() => {});
            for (const name of [...registeredTools]) await unregisterTool(name).catch(() => {});
            for (const unregister of unregisters) unregister();
        },
    };
}
