/**
 * Библиотека исполнения ОБЪЯВЛЕННОГО набора этапов (PIPELINE.md) —
 * полностью чистая: ни шин, ни Гейтов, ни ST, ни сети, ни собственных
 * таймеров сверх инъектируемого `sleep`. Всё, что она умеет — разложить
 * объявленные этапы по порядку зависимостей и прогнать их, отдав саму
 * работу наружу через `execute`. Кто такой этап, чьими правами он
 * исполняется и куда уходят события — забота Ядра пайплайнов.
 *
 * **Этап — это ДАННЫЕ, а не колбэк** (подтверждено): ссылка на контракт +
 * `params` + `needs`. Иначе Гейт не может проверить права на то, что этап
 * реально делает, а определение пайплайна нельзя ни показать в панели, ни
 * сохранить.
 *
 * **Два режима, одна машина.** Параллельность — не режим, а следствие
 * графа: `computeStageLevels()` кладёт в один уровень всё, что друг от
 * друга не зависит.
 *  - `collect` — уровни исполняются параллельно, результат каждого этапа
 *    ложится под его `id` (это `beforeSend`: сбор вкладов).
 *  - `fold` — тот же порядок, но строго по одному, и выход этапа становится
 *    новым переносимым значением (это `completed`: цепочка переписывания).
 *
 * **Провал этапа — не просто повтор, а пересборка.** `fallbacks` это
 * ЦЕПОЧКА ПОПЫТОК, каждая из которых может отличаться от предыдущей: тот же
 * контракт с другим воркером, другой контракт вообще, или просто тот же
 * запрос после паузы. Прямо из разбора реальных отказов SideCar'а в Alpha
 * (второй воркер → главная модель ST; отдельно — что голый сетевой сбой
 * лечится обычной паузой не хуже, чем 429). Когда цепочка исчерпана —
 * по умолчанию `onExhausted: 'abort'`: отказ ВСЕГО пайплайна, а для
 * `beforeSend` это значит, что генерации в этом цикле не будет.
 * `'flag'` (пометить провал и идти дальше) уже работает, но по умолчанию
 * выключен — это будущий пользовательский переключатель, а не текущее
 * поведение.
 */

/** Значение, доступное в `{ $from: ... }` как вход всего пайплайна. */
export const INPUT_REF = '$input';
/** Текущее переносимое значение в режиме `fold` — в `collect` его нет. */
export const VALUE_REF = '$value';

/**
 * Раскладывает этапы по УРОВНЯМ зависимостей: уровень N зависит только от
 * уровней меньше N, поэтому внутри уровня всё независимо и может идти
 * параллельно. Порядок объявления внутри уровня сохраняется — два этапа без
 * связи между собой не должны молча меняться местами от прогона к прогону.
 */
export function computeStageLevels(stages) {
    const byId = new Map();
    for (const stage of stages) {
        if (!stage?.id) throw new Error('pipeline: every stage needs an "id".');
        if (byId.has(stage.id)) throw new Error(`pipeline: duplicate stage id "${stage.id}".`);
        byId.set(stage.id, stage);
    }
    for (const stage of stages) {
        for (const need of stage.needs ?? []) {
            if (!byId.has(need)) throw new Error(`pipeline: stage "${stage.id}" needs "${need}", which is not registered.`);
        }
    }

    const pending = new Set(byId.keys());
    const satisfied = new Set();
    const levels = [];
    while (pending.size) {
        const level = stages.filter(stage => pending.has(stage.id) && (stage.needs ?? []).every(need => satisfied.has(need)));
        // Ни один этап не готов, а незакрытые остались — значит они держат
        // друг друга по кругу. Имена в сообщении: без них цикл в графе из
        // десятка этапов ищется вручную и долго.
        if (!level.length) throw new Error(`pipeline: dependency cycle between stages: ${[...pending].join(', ')}.`);
        for (const stage of level) pending.delete(stage.id);
        for (const stage of level) satisfied.add(stage.id);
        levels.push(level);
    }
    return levels;
}

/**
 * Разворачивает этап в цепочку попыток. Первая — как объявлено; каждая
 * следующая наследует контракт и параметры этапа и накладывает поверх свои,
 * поэтому `{ delayMs: 500 }` это «то же самое, но через полсекунды», а
 * `{ params: { workerId: 'backup' } }` — «то же самое другим воркером».
 */
export function buildAttempts(stage) {
    const baseParams = stage.params ?? {};
    return [
        { contract: stage.contract, params: baseParams, delayMs: 0 },
        ...(stage.fallbacks ?? []).map(fallback => ({
            contract: fallback.contract ?? stage.contract,
            params: { ...baseParams, ...(fallback.params ?? {}) },
            delayMs: fallback.delayMs ?? 0,
        })),
    ];
}

function readPath(source, path) {
    return path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), source);
}

/**
 * Подставляет в параметры этапа выходы тех этапов, от которых он зависит:
 * `{ $from: 'worldInfo' }` — весь выход целиком, `{ $from: 'worldInfo.text' }`
 * — поле внутри него. Ссылка это ДАННЫЕ, поэтому объявление этапа остаётся
 * сериализуемым (его можно сохранить и показать), в отличие от «передайте
 * функцию, она сама возьмёт что надо».
 */
export function resolveStageParams(params, outputs) {
    if (Array.isArray(params)) return params.map(item => resolveStageParams(item, outputs));
    if (params && typeof params === 'object') {
        if (typeof params.$from === 'string') return readPath(outputs, params.$from);
        const resolved = {};
        for (const [key, value] of Object.entries(params)) resolved[key] = resolveStageParams(value, outputs);
        return resolved;
    }
    return params;
}

function errorOf(reason) {
    if (reason && typeof reason === 'object' && reason.message) return { message: String(reason.message) };
    return { message: String(reason) };
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** `execute` может и вернуть конверт, и бросить — снаружи это одинаковый провал попытки. */
async function callExecute(execute, call) {
    try {
        const result = await execute(call);
        if (result && result.ok === false) return { ok: false, error: errorOf(result.error ?? { message: 'stage failed' }) };
        return { ok: true, value: result && 'value' in result ? result.value : result };
    } catch (error) {
        return { ok: false, error: errorOf(error) };
    }
}

async function withTimeout(promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: { message: `timed out after ${timeoutMs}ms` } }), timeoutMs); }),
        ]);
    } finally {
        // Таймер снимается ВСЕГДА, даже когда выиграл сам этап: иначе
        // каждый успешный этап оставлял бы висеть таймер до срабатывания, и
        // процесс не завершался бы, пока не истечёт самый долгий из них.
        if (timer !== null) clearTimeout(timer);
    }
}

/**
 * Прогоняет один этап по всей его цепочке попыток. Возвращает либо успех,
 * либо провал ПОСЛЕ исчерпания цепочки — решение «отменять ли весь
 * пайплайн» принимается уровнем выше, здесь его нет.
 */
async function runStage({ stage, outputs, execute, resolveTimeout, onEvent, sleep, now }) {
    const attempts = buildAttempts(stage);
    const failures = [];
    const startedAt = now();
    onEvent('stageStarted', { stageId: stage.id, contract: stage.contract, attempts: attempts.length });

    for (const [index, attempt] of attempts.entries()) {
        if (attempt.delayMs > 0) await sleep(attempt.delayMs);
        const params = resolveStageParams(attempt.params, outputs);
        const timeoutMs = resolveTimeout ? await resolveTimeout({ stage, attempt: index }) : null;
        const attemptStartedAt = now();
        const result = await withTimeout(
            callExecute(execute, { stageId: stage.id, contract: attempt.contract, params, attempt: index }),
            timeoutMs,
        );
        if (result.ok) {
            const record = { stageId: stage.id, ok: true, attempt: index, durationMs: now() - startedAt, attemptDurationMs: now() - attemptStartedAt, failures };
            onEvent('stageFinished', record);
            return { ...record, value: result.value };
        }
        failures.push({ attempt: index, contract: attempt.contract, error: result.error });
        onEvent('stageAttemptFailed', { stageId: stage.id, attempt: index, contract: attempt.contract, error: result.error, remaining: attempts.length - index - 1 });
    }

    const record = { stageId: stage.id, ok: false, durationMs: now() - startedAt, failures, error: failures.at(-1)?.error ?? { message: 'stage failed' } };
    onEvent('stageExhausted', record);
    return record;
}

/**
 * Исполняет пайплайн целиком.
 *
 * `execute({ stageId, contract, params, attempt })` — единственный выход
 * наружу: Ядро пайплайнов подставляет сюда резолвинг контракта ПОД ПРАВАМИ
 * ВЛАДЕЛЬЦА этапа. Библиотека намеренно не знает, чем это кончится и кто
 * такой владелец.
 */
export async function runPipeline({
    stages,
    mode = 'collect',
    input = null,
    execute,
    resolveTimeout = null,
    onEvent = () => {},
    sleep = defaultSleep,
    now = () => Date.now(),
} = {}) {
    if (typeof execute !== 'function') throw new Error('pipeline: runPipeline() needs an execute() function.');
    if (mode !== 'collect' && mode !== 'fold') throw new Error(`pipeline: unknown mode "${mode}" (expected "collect" or "fold").`);

    const levels = computeStageLevels(stages ?? []);
    const outputs = { [INPUT_REF]: input };
    const records = [];
    const flagged = [];
    let value = input;

    for (const level of levels) {
        // `fold` — цепочка переписывания одного значения, параллелить её
        // нечем: второй этап обязан видеть выход первого. `collect` —
        // наоборот, весь смысл уровня в том, что он идёт разом.
        const run = stage => runStage({
            stage,
            outputs: mode === 'fold' ? { ...outputs, [VALUE_REF]: value } : outputs,
            execute,
            resolveTimeout,
            onEvent,
            sleep,
            now,
        });

        let results;
        if (mode === 'fold') {
            results = [];
            for (const stage of level) {
                const record = await run(stage);
                results.push(record);
                if (record.ok) value = record.value;
                outputs[record.stageId] = record.ok ? record.value : undefined;
            }
        } else {
            results = await Promise.all(level.map(run));
            for (const record of results) outputs[record.stageId] = record.ok ? record.value : undefined;
        }
        records.push(...results);

        const fatal = results.find(record => !record.ok && (level.find(stage => stage.id === record.stageId)?.onExhausted ?? 'abort') === 'abort');
        for (const record of results) {
            if (record.ok || record === fatal) continue;
            flagged.push(record.stageId);
            onEvent('stageFlagged', { stageId: record.stageId, error: record.error });
        }
        if (fatal) {
            onEvent('aborted', { stageId: fatal.stageId, error: fatal.error });
            return { ok: false, error: { message: `pipeline aborted at stage "${fatal.stageId}": ${fatal.error.message}` }, failedStage: fatal.stageId, outputs, value, stages: records, flagged };
        }
    }

    return { ok: true, outputs, value, stages: records, flagged };
}
