import { request } from '../../libraries/shared/request.js';

const SETTINGS_NAMESPACE = 'core.summary';
const MEMORY_NAMESPACE = 'core.summary';
const SUMMARIES_KEY = 'summaries';
const PREPARE_PIPELINE = 'generation.prepare';
const BEFORE_SEND_PIPELINE = 'generation.beforeSend';
const FOLD_CONTRACT = 'summary.check';
const INJECT_CONTRACT = 'summary.inject';
const FOLD_STAGE_ID = 'summary:fold';
const INJECT_STAGE_ID = 'summary:inject';
/** Запас сверх protectedWindow+batchSize, который реально запрашивается у chatHistory.messages — цепочка ToolCall/сирота может съесть несколько сообщений, не дав ни одной новой единицы для подсчёта. */
const FETCH_MARGIN = 30;

export const DEFAULT_SETTINGS = Object.freeze({
    // Один уровень — один проход свёртки: N нижних элементов (сырых сообщений
    // для уровня 1, саммари уровня N-1 для остальных) → 1 саммари этого уровня.
    // Число уровней — это просто длина массива, тоже настраиваемая.
    levels: [{ batchSize: 10 }, { batchSize: 5 }, { batchSize: 5 }],
    // «Второй порог» из обсуждения с пользователем: сколько последних единиц
    // никогда не сворачиваются. Активация мгновенная (без ручного шага), как
    // только за пределами этого окна накопился целый батч уровня 1.
    protectedWindow: 20,
    workerId: null,
});

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/** Защитный клэмп — та же дисциплина, что у `clampNoteSettings()` (modules/tools/notebook.js): ручная правка файла настроек не должна осесть как есть. */
export function clampSummarySettings(values = {}) {
    const levels = Array.isArray(values.levels) && values.levels.length
        ? values.levels.map(level => ({ batchSize: clampInt(level?.batchSize, 2, 200, 5) }))
        : DEFAULT_SETTINGS.levels.map(level => ({ ...level }));
    return {
        levels,
        protectedWindow: clampInt(values.protectedWindow, 1, 2000, DEFAULT_SETTINGS.protectedWindow),
        workerId: values.workerId ?? null,
    };
}

function makeSummaryId(now, random) {
    return `sum_${now().toString(36)}_${random().toString(36).slice(2, 8)}`;
}

/**
 * Сообщения → логические единицы для подсчёта порога. Цепочка ToolCall
 * (одно или несколько подряд `isToolCall`-сообщений — та же «черновик по
 * пути» форма, что документирована в cores/generation/index.js) вместе со
 * следующим за ней настоящим ответом — ОДНА единица, не три и не N+1. CoT
 * (`hasReasoning`) ничего дополнительно не требует: рассуждение уже лежит
 * ВНУТРИ одного объекта сообщения, а не отдельной записью.
 *
 * Незавершённая цепочка (`isToolCall`, а следующего настоящего ответа ещё
 * нет — конец окна) — orphan: остаётся ЗА пределами возвращённых единиц
 * целиком, а не «единицей из одного сообщения». Свёртка никогда не должна
 * разрезать цепочку пополам.
 */
export function groupIntoUnits(messages) {
    const units = [];
    let i = 0;
    while (i < messages.length) {
        if (messages[i].isToolCall) {
            let j = i;
            while (j < messages.length && messages[j].isToolCall) j += 1;
            if (j >= messages.length) break; // orphan chain at the tail — hold back entirely
            units.push(messages.slice(i, j + 1));
            i = j + 1;
        } else {
            units.push([messages[i]]);
            i += 1;
        }
    }
    return units;
}

/** `true`, когда единиц за пределами защищённого окна набрался полный батч — «мгновенная активация», без ручного шага. */
export function shouldFold(unitCount, protectedWindow, batchSize) {
    return unitCount >= protectedWindow + batchSize;
}

/** Единый порядок сортировки для UI и для инъекции: по СТАРШЕЙ (самой ранней) стороне охвата — «саммари идут по тайм-стампам и сами сортируются». */
export function sortByStart(records) {
    return [...records].sort((a, b) => a.startIndex - b.startIndex);
}

export function activeSummaries(all) {
    return sortByStart(all.filter(record => !record.folded));
}

export function createBasicSummaryCore(host, { publish, now = Date.now, random = Math.random } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let settings = clampSummarySettings(DEFAULT_SETTINGS);
    let summaries = []; // все саммари ТЕКУЩЕГО чата — и активные, и уже свёрнутые в уровень выше (история, не мусор)

    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    // Своя очередь на запись — тот же приём, что у Ядра лорбука/истории чата:
    // read-modify-write над ОДНИМ списком `summaries`, и без сериализации два
    // параллельных фолда (например уровень 1 и случайно совпавший ручной
    // `summary.check`) рисковали бы затереть друг друга.
    let writeTail = Promise.resolve();
    function enqueueWrite(task) {
        const run = writeTail.then(task, task);
        writeTail = run.then(() => {}, () => {});
        return run;
    }

    async function loadSettings() {
        const result = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: 'settings', fallback: null });
        if (result.ok && result.value) settings = clampSummarySettings(result.value);
        return settings;
    }

    async function configure(next) {
        settings = clampSummarySettings({ ...settings, ...next });
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: 'settings', value: settings });
        return settings;
    }

    async function loadSummaries() {
        const result = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: SUMMARIES_KEY, fallback: [] });
        summaries = result.ok ? result.value ?? [] : [];
        return summaries;
    }

    /**
     * Перезагрузка при смене активного чата — ТА ЖЕ гонка, что задокументирована
     * у Модуля «Notebook» (modules/tools/notebook.js, doc-comment на
     * `st.chatChanged`): `load()` выполняется один раз при старте движка, часто
     * ДО того, как ST успел подгрузить `chatMetadata` текущего чата — первый
     * `loadSummaries()` видел пустоту. Но если у Notebook устаревший пустой
     * список лишь «прятал» заметки от панели, здесь пустой `summaries` ещё и
     * ЗАПИСЫВАЕТСЯ НАЗАД: следующий `checkAndFold()` собирает `list` из
     * устаревшего (пустого) массива и `saveSummaries()` затирает на диске ВСЕ
     * старые саммари одним новым — реальная жалоба пользователя, «пропадали не
     * только свежие, но и старые саммари». Тот же приём, что у Notebook,
     * Tracker'а и reloadForActiveChat() Ядра графа памяти: подписка на
     * `st.chatChanged` (ловит и самый первый чат после перезагрузки страницы).
     * Перезагрузка идёт ЧЕРЕЗ `enqueueWrite()` — иначе параллельный с ней фолд
     * мог бы начать с предсменного списка и записать его уже ПОСЛЕ перезагрузки.
     *
     * После перезагрузки публикуется `summary.reloaded` — панель движка
     * перечитывает список по этому событию и показывает саммари УЖЕ ТЕКУЩЕГО
     * чата сразу при заходе в него, без ручного «Fold now» (тот же паттерн
     * «Ядро объявляет факт — слушатели решают сами», что и `summary.folded`).
     */
    function reloadSummariesForChat() {
        return enqueueWrite(async () => {
            await loadSummaries();
            publishEvent('summary.reloaded', { count: activeSummaries(summaries).length });
        });
    }

    async function saveSummaries(next) {
        summaries = next;
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: SUMMARIES_KEY, value: next });
        // Явный flush сразу после записи — тот же фикс, что уже стоит у Ядра
        // графа памяти после бутстрапа (cores/memory-graph/index.js). Обычный
        // `set()` лишь взводит ST-шный debounce (saveMetadataDebounced, 1000ms);
        // перезагрузка страницы в течение этой секунды после фолда теряла
        // саммари молча — при этом скрытые сообщения УЖЕ реально сохранены
        // (foldRawUnits() ходит через chatHistory.hide → context.saveChat()),
        // и после релоада оставалась обратная дыра: сообщения спрятаны, а
        // саммари для них нет. flush() идёт через ту же очередь Ядра памяти,
        // так что порядок с параллельными фолдами сохраняется.
        await call('storage.chatMemory.flush');
    }

    /** Тихий вызов модели — тот же контракт и та же форма запроса, что у cores/tracking/index.js's poll() (workerId пиннит на конкретный сайдкар). Здесь ответ — голый текст, не JSON: свёртке нечего парсить. */
    // `maxTokens: 5000` — явно, а не молчаливый дефолт Ядра моделей (1000):
    // свёртка батча в 10 сообщений регулярно упиралась в потолок и обрезала
    // саммари на полуслове. Реальная жалоба пользователя.
    const FOLD_MAX_TOKENS = 5000;
    async function askModelToFold(systemPrompt, prompt) {
        const result = await call('model.generate', { prompt, systemPrompt, maxTokens: FOLD_MAX_TOKENS, workerId: settings.workerId ?? undefined });
        if (!result.ok) throw new Error(result.error.message);
        return String(result.value ?? '').trim();
    }

    function buildLevel1Prompt(units) {
        return units.flat().map(message => `${message.name || (message.isUser ? 'User' : 'Character')}: ${message.text}`).join('\n');
    }

    function buildLevelNPrompt(children) {
        return children.map(child => child.text).join('\n\n');
    }

    /** Level-1: сворачивает `batchSize` старейших единиц СЫРЫХ сообщений в одно саммари и прячет их через chatHistory.hide (is_system=true — mesid не сдвигается, см. doc-comment services/st-chat.js). */
    async function foldRawUnits(units) {
        const flat = units.flat();
        const mesids = flat.map(message => message.mesid);
        const text = await askModelToFold(
            'Summarize the following conversation excerpt concisely, in third person, preserving important facts, character goals, and plot developments. Output ONLY the summary text, no preamble.',
            buildLevel1Prompt(units),
        );
        const record = {
            id: makeSummaryId(now, random),
            level: 1,
            coveredIds: mesids,
            startIndex: Math.min(...mesids.map(Number)),
            endIndex: Math.max(...mesids.map(Number)),
            startTime: flat[0]?.sendDate ?? null,
            endTime: flat[flat.length - 1]?.sendDate ?? null,
            text,
            createdAt: now(),
            edited: false,
            folded: false,
        };
        for (const mesid of mesids) {
            const hidden = await call('chatHistory.hide', { mesid, hidden: true });
            if (!hidden.ok) throw new Error(hidden.error.message);
        }
        return record;
    }

    /** Level N>1: сворачивает `batchSize` старейших активных саммари уровня N-1 в одно саммари уровня N — без повторного чтения сырых сообщений, только тексты детей. */
    async function foldChildSummaries(children, level) {
        const text = await askModelToFold(
            'Combine the following summaries into one, more condensed summary. Preserve important facts, character goals, and plot developments. Output ONLY the summary text, no preamble.',
            buildLevelNPrompt(children),
        );
        return {
            id: makeSummaryId(now, random),
            level,
            coveredIds: children.map(child => child.id),
            startIndex: Math.min(...children.map(child => child.startIndex)),
            endIndex: Math.max(...children.map(child => child.endIndex)),
            startTime: children[0]?.startTime ?? null,
            endTime: children[children.length - 1]?.endTime ?? null,
            text,
            createdAt: now(),
            edited: false,
            folded: false,
        };
    }

    /**
     * Порог + каскад — этап `generation.prepare` (то же «освежить своё
     * состояние до ответа», что и у Tracker'а). Уровень 1 читает реальные
     * сообщения; каждый следующий уровень — уже готовые тексты уровня ниже,
     * поэтому цена каскада не растёт с глубиной истории.
     */
    /**
     * `summary.folded` уходит СРАЗУ после каждого сохранённого батча, не
     * только один раз в конце всей функции — раньше был именно так, и это
     * пряталось за тем же наблюдением, что уже отражено в комментарии ниже
     * про построчное `saveSummaries()`: упади батч ПОСЛЕ хотя бы одного
     * удачного (второй уровень, второй проход уровня 1 — что угодно дальше
     * по цепочке), исключение уходит из `checkAndFold()` до строки с
     * `publishEvent`, и УЖЕ СОХРАНЁННЫЙ на диск батч остаётся невидим
     * панели — `cores/ui/engine-panel.js` перечитывает список ТОЛЬКО по
     * этому событию (см. его doc-comment на `summary.folded`), а не при
     * каждом открытии. Данные не терялись (это уже проверяет отдельный
     * тест), терялось только уведомление панели о том, что они появились.
     */
    async function checkAndFold() {
        try {
            return await enqueueWrite(async () => {
                let list = [...summaries];

                // Сохраняем ПОСЛЕ КАЖДОГО удачного фолда, а не одним разом в конце:
                // `foldRawUnits()` уже скрыло реальные сообщения через `chatHistory.hide`
                // до того, как эта функция вообще узнаёт, удался ли фолд — и упади
                // следующий батч в цепочке (например, второй уровень или второй
                // проход уровня 1), запись «в один присест» потеряла бы уже
                // состоявшийся, необратимый фолд: сообщения скрыты, а саммари для
                // них — нет. Обнаружено живой проверкой в браузере (сеть реально
                // упала на втором вызове модели), не придумано заранее.
                const level1 = settings.levels[0];
                if (level1) {
                    const fetched = await call('chatHistory.messages', { limit: settings.protectedWindow + level1.batchSize + FETCH_MARGIN });
                    const messages = fetched.ok ? fetched.value ?? [] : [];
                    const units = groupIntoUnits(messages);
                    while (shouldFold(units.length, settings.protectedWindow, level1.batchSize)) {
                        const batch = units.splice(0, level1.batchSize);
                        const record = await foldRawUnits(batch);
                        list = [...list, record];
                        await saveSummaries(list);
                        publishEvent('summary.folded', { count: list.length });
                    }
                }

                for (let levelIndex = 1; levelIndex < settings.levels.length; levelIndex += 1) {
                    const level = settings.levels[levelIndex];
                    const parentLevel = levelIndex; // саммари уровня `levelIndex` (1-based level number == levelIndex here, since levels[0] produces level:1)
                    let pool = activeSummaries(list).filter(record => record.level === parentLevel);
                    while (pool.length >= level.batchSize) {
                        const batch = pool.slice(0, level.batchSize);
                        const record = await foldChildSummaries(batch, parentLevel + 1);
                        const batchIds = new Set(batch.map(child => child.id));
                        list = list.map(item => (batchIds.has(item.id) ? { ...item, folded: true } : item));
                        list = [...list, record];
                        pool = pool.slice(level.batchSize);
                        await saveSummaries(list);
                        publishEvent('summary.folded', { count: list.length });
                    }
                }

                return activeSummaries(list);
            });
        } catch (error) {
            // Автоматический фолд идёт этапом `generation.prepare` с
            // `onExhausted: 'flag'` — его отказ НЕ идёт через ручной путь
            // «Fold now» (`engine-panel.js`'s `forceSummaryFold()`), который
            // сам показывает `result.error.message`. Без этого события
            // автоматический сбой был не виден вообще НИГДЕ: сообщение уже
            // не свёрнуто, а почему — неизвестно ни пользователю, ни при
            // отладке. Модуль/панель решает, показывать ли это как тост —
            // здесь только объявление факта, тот же приём, что и `tracking.
            // poll.failed` у Ядра трекинга.
            publishEvent('summary.foldFailed', { message: error?.message ?? String(error) });
            throw error;
        }
    }

    async function updateSummary({ id, text } = {}) {
        return enqueueWrite(async () => {
            const index = summaries.findIndex(record => record.id === id);
            if (index < 0) throw new Error(`summary.update: no summary with id "${id}".`);
            const next = [...summaries];
            next[index] = { ...next[index], text: String(text ?? '').trim(), edited: true };
            await saveSummaries(next);
            return next[index];
        });
    }

    async function deleteSummary({ id } = {}) {
        return enqueueWrite(async () => {
            const next = summaries.filter(record => record.id !== id);
            if (next.length === summaries.length) return false;
            await saveSummaries(next);
            return true;
        });
    }

    /**
     * Инъекция — этап `generation.beforeSend`, живая мутация `chat` (тот же
     * приём, что modules/tools/notebook.js's injectIntoPrompt). Все активные
     * саммари ВСЕГДА старше любого оставшегося сырого сообщения (сворачиваются
     * только те, что уже вне защищённого окна) — поэтому их не нужно
     * вперемешку вставлять по всему массиву, достаточно вставить блоком в
     * самое начало, отсортировав между собой по `startIndex`. Каждое —
     * ОТДЕЛЬНЫМ сообщением, не одним слитым блоком: у ST бюджет промпта
     * заполняется от новых к старым и режет ровно на границе (проверено по
     * script.js), и только отдельные сообщения вытесняются по-настоящему
     * строго от старых к новым — слитый блок пришлось бы выкидывать целиком.
     *
     * СКРЫТЫЕ ТУЛ-КОЛЛЫ ВЫРЕЗАЮТСЯ, а не скрываются (живая проблема 11.09):
     * ST при сборке промпта фильтрует `is_system`, но с ИСКЛЮЧЕНИЕМ для
     * тул-коллов — `script.js`: `coreChat = chat.filter(x => !x.is_system ||
     * (canUseTools && Array.isArray(x.extra?.tool_invocations)))`. Поэтому
     * `chatHistory.hide` прячет обычные сообщения, а сообщения с
     * `extra.tool_invocations` всё равно попадают в промпт — вместе со всем
     * содержимым вызовов и результатов. Здесь они удаляются из мутируемой
     * копии `chat` целиком: пара «assistant с tool_calls + role:'tool'
     * ответы» живёт ВНУТРИ одного объекта сообщения (`extra.tool_invocations`,
     * ST синтезирует `role:'tool'` строки из него при сборке payload), так
     * что вырезание одного элемента убирает и вызов, и его результат.
     *
     * Граница «свежести» — от КОНЦА истории (решение архитектора 11.09):
     * тул-колл рождается в ST уже системным, поэтому «скрыт саммари» и
     * «просто свежий тул-колл» по is_system не различаются. Режутся скрытые
     * тул-коллы только СТАРЕЕ защищённого окна (protectedWindow от конца
     * истории); свежие вызовы внутри окна не трогаются никогда.
     */
    /**
     * Заголовок саммари — ЯВНОЕ объявление «это саммари» + период, который оно
     * замещает (запрос архитектора 11.09). Период берётся из record.startTime/
     * endTime — а они у КАЖДОГО уровня привязаны к ПЕРВОМУ и ПОСЛЕДНЕМУ
     * замещённому сообщению: уровень 1 пишет их из сырых сообщений батча,
     * уровень N>1 — из крайних ДЕТЕЙ (foldChildSummaries), так что при
     * слиянии слоёв период честно расширяется и остаётся привязанным к
     * реальным сообщениям, а не к моменту свёртки.
     */
    function formatSummaryMessage(record) {
        const from = record.startTime ? String(record.startTime) : 'unknown time';
        const to = record.endTime ? String(record.endTime) : from;
        return `[Summary of earlier messages #${record.startIndex}–#${record.endIndex}, covering ${from} → ${to}]\n${record.text}`;
    }

    async function injectIntoPrompt({ chat } = {}) {
        if (!Array.isArray(chat)) return true;
        const active = activeSummaries(summaries);
        if (active.length) {
            // Вырезание скрытых тул-коллов СТАРЕЕ защищённого окна (позиция
            // считается ОТ КОНЦА — решение архитектора 11.09), затем unshift
            // саммари. Один проход фильтром: у выживших индексы сдвигаются
            // равномерно, поэтому «позиция от конца» считается по ИСХОДНОЙ
            // длине массива.
            const windowStart = chat.length - settings.protectedWindow; // всё < этого индекса — старая зона
            const pruned = chat.filter((message, index) => {
                const isToolCall = Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0;
                return !(isToolCall && message.is_system && index < windowStart);
            });
            if (pruned.length !== chat.length) chat.splice(0, chat.length, ...pruned);
            const messages = active.map(record => ({ is_user: false, is_system: true, name: 'Summary', mes: formatSummaryMessage(record) }));
            chat.unshift(...messages);
        }
        return true;
    }

    async function load() {
        await loadSettings();
        await loadSummaries();
        host.own.register(FOLD_CONTRACT, () => checkAndFold());
        host.own.register(INJECT_CONTRACT, params => injectIntoPrompt(params));
        await call('pipeline.stages.add', {
            pipelineId: PREPARE_PIPELINE,
            stage: { id: FOLD_STAGE_ID, contract: FOLD_CONTRACT, onExhausted: 'flag' },
        });
        await call('pipeline.stages.add', {
            pipelineId: BEFORE_SEND_PIPELINE,
            stage: { id: INJECT_STAGE_ID, contract: INJECT_CONTRACT, params: { chat: { $from: '$input.chat' } }, onExhausted: 'flag' },
        });
    }

    const unregisters = [
        host.own.register('summary.settings', () => settings),
        host.own.register('summary.configure', params => configure(params ?? {})),
        host.own.register('summary.list', () => activeSummaries(summaries)),
        host.own.register('summary.update', params => updateSummary(params)),
        host.own.register('summary.delete', params => deleteSummary(params)),
    ];

    const unsubscribeChatChanged = host.events.subscribe('st.chatChanged', () => { reloadSummariesForChat(); });

    return {
        load,
        checkAndFold,
        settings: () => settings,
        list: () => activeSummaries(summaries),
        unregister: async () => {
            await call('pipeline.stages.remove', { pipelineId: PREPARE_PIPELINE, stageId: FOLD_STAGE_ID }).catch(() => {});
            await call('pipeline.stages.remove', { pipelineId: BEFORE_SEND_PIPELINE, stageId: INJECT_STAGE_ID }).catch(() => {});
            unsubscribeChatChanged();
            for (const unregister of unregisters) unregister();
        },
    };
}
