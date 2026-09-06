import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { fillTemplate } from '../../libraries/core/fill-template.js';
import { Button, TextInput, Select, Toggle, Chip, Field, Row, EditableList, StatBlock } from '../../libraries/shared/widgets.js';
import { GenerationSettingsPanel } from '../../libraries/shared/generation-settings-panel.js';
import { SAMPLER_PRESETS, clampSamplerSettings, clampReasoningSettings, buildCustomPreset } from '../../cores/models/internal-engine.js';

/**
 * Модуль «Время» — определитель внутриигрового времени, как в Alpha.
 *
 * **Своего трекинга у него нет.** Это специализация поверх общего [Ядра
 * трекинга](../../cores/tracking/index.js): Модуль заводит там один трекер,
 * а опрос модели, разбор ответа, публикацию на шину и запись в макрос делает
 * Ядро — ровно то же, что и для любого другого трекера. Отличий ровно три, и
 * все три — предметные, а не механические:
 *
 *  1. **Свой набор полей и пресеты** (год/месяц/день/время/период и т.п.):
 *     пользователю не нужно придумывать их с нуля.
 *  2. **Свой промпт** — он объясняет модели, что от неё хотят ШАГ времени, а
 *     не абсолютную дату из воздуха.
 *  3. **Временная шкала.** Вот это и есть настоящая специализация. Одна
 *     «текущая точка» не говорит модели НИЧЕГО о том, с какой скоростью время
 *     шло до сих пор, и она каждый раз выводила темп заново — у Alpha это
 *     прямо записано как реальная причина рваных скачков. Модуль хранит
 *     несколько прошлых отметок и подаёт их в промпт как `{timeline}`.
 *
 * Шкала живёт в ПАМЯТИ ЧАТА (`storage.chatMemory`), а не в настройках: у
 * каждого чата своё время, и переносить его между ними бессмысленно. Ровно
 * поэтому же Alpha пересчитывала шкалу из самого чата — «источник правды один,
 * и откатывать после реролла ничего не нужно».
 *
 * Показывает себя в полосе под сообщением (слот `left`) — там же, где Alpha
 * рисовала свой бейдж. В промпт основной модели не попадает ничего: значение
 * уходит на шину, а оттуда в макрос и в эту полосу.
 */

export const MODULE_ID = 'module.time';
const SETTINGS_NAMESPACE = MODULE_ID;
const TRACKER_ID = 'rp-time';
const MEMORY_NAMESPACE = MODULE_ID;
/** Отметка ПОД КАЖДЫМ сообщением: `{ [mesid]: 'Day 1, 08:00' }`. Тоже память чата — бейджи обязаны пережить перезагрузку страницы. */
const BADGES_KEY = 'badges';
/** Сколько прошлых отметок показывать модели. Одной мало (нет темпа), десяток — уже шум и лишние токены. */
const MAX_TIMELINE = 5;

/**
 * Промпт специализирован под ШАГ времени. Главное в нём — запрет выдумывать
 * абсолютную дату: модели показывают, куда время двигалось, и просят продлить
 * ту же линию, а не начать новую.
 *
 * **Разделён на два сообщения** (Ядро трекинга умеет это с
 * `systemPromptTemplate` — см. doc-comment [cores/tracking/index.js](../../cores/tracking/index.js)):
 * `TIME_SYSTEM_PROMPT` — ИНСТРУКЦИЯ (что трекать, как оценивать шаг, в каком
 * виде отвечать) — не меняется от опроса к опросу, ей место в `system`.
 * `TIME_PROMPT` остался пользовательским — сама ИСТОРИЯ (шкала и переписка),
 * то, что действительно разное на каждом опросе.
 */
export const TIME_SYSTEM_PROMPT =
    'You are an in-world time tracker for a roleplay chat. Track only the fields below, ' +
    'using each note to decide how to format it:\n{fields}\n\n' +
    'Estimate the time step using ONLY the newest exchange (the character\'s latest reply, at the end ' +
    'of the context you are given): how long would plausibly pass for that one exchange to happen?\n\n' +
    'Default to a SMALL step (seconds to a few minutes) unless the newest exchange explicitly signals ' +
    'a skip (e.g. "the next morning", "hours later", "after the long walk") or a scene transition.\n\n' +
    'Return ONLY a JSON object with exactly these keys: {fieldsJson}. No markdown, no explanation.';

export const TIME_PROMPT =
    'Recent known in-world time, oldest to most recent: {timeline}. This shows the actual pace time ' +
    'has been moving at — extrapolate from it, don\'t invent a different pace.\n\n' +
    'ROLEPLAY CONTEXT:\n{context}\n\n' +
    'The roleplay text above is scene context only, not a log of elapsed time still to be counted — ' +
    'everything up through the second-to-last message is already reflected in the timeline.\n\n' +
    'The character just responded (see the end of the context above).';

export const TIME_PRESETS = Object.freeze([
    {
        id: 'full-date',
        name: 'Year · Month · Day · Time · Period',
        start: 'Year 1, Month 1, Day 1, 08:00 (Morning)',
        displayTemplate: 'Year {year}, Month {month}, Day {day}, {time} ({period})',
        fields: [
            { name: 'year', prompt: '' },
            { name: 'month', prompt: '' },
            { name: 'day', prompt: '' },
            { name: 'time', prompt: '24-hour HH:MM' },
            { name: 'period', prompt: 'One of: Morning, Afternoon, Evening, Night' },
        ],
    },
    {
        id: 'day-counter',
        name: 'Day counter · Time · Period',
        start: 'Day 0, 08:00 (Morning)',
        displayTemplate: 'Day {day}, {time} ({period})',
        fields: [
            { name: 'day', prompt: 'A counter that only ever grows' },
            { name: 'time', prompt: '24-hour HH:MM' },
            { name: 'period', prompt: 'One of: Morning, Afternoon, Evening, Night' },
        ],
    },
    {
        id: 'natural-date-12h',
        name: 'Natural date · 12-hour clock · Period',
        start: '2026 March 5 09:20 AM (Morning)',
        displayTemplate: '{year} {month} {day} {time} ({period})',
        fields: [
            { name: 'year', prompt: '' },
            { name: 'month', prompt: 'Full month name, e.g. March' },
            { name: 'day', prompt: '' },
            { name: 'time', prompt: '12-hour clock with AM/PM, e.g. 09:20 AM' },
            { name: 'period', prompt: 'One of: Morning, Afternoon, Evening, Night' },
        ],
    },
    {
        id: 'clock-only',
        name: 'Time · Period',
        start: '08:00 (Morning)',
        displayTemplate: '{time} ({period})',
        fields: [
            { name: 'time', prompt: '24-hour HH:MM' },
            { name: 'period', prompt: 'One of: Morning, Afternoon, Evening, Night' },
        ],
    },
]);

/** Строка времени из значений полей. Пустой шаблон — просто значения через запятую, чтобы что-то показать всегда. */
export function buildTimeLabel(fields, displayTemplate) {
    if (!fields.length) return '';
    const known = Object.fromEntries(fields.map(field => [field.name, field.value ?? '—']));
    if (!String(displayTemplate ?? '').trim()) return fields.map(field => known[field.name]).join(', ');
    return fillTemplate(displayTemplate, known);
}

/**
 * Шкала из отметок сообщений: значения в порядке самих сообщений, подряд
 * идущие повторы схлопнуты.
 *
 * Это ЕДИНСТВЕННЫЙ источник шкалы — отдельного списка «истории» больше нет.
 * Пока он существовал, реролл откатывал бейдж сообщения, но не шкалу: модель
 * продолжала отсчитывать от времени отброшенного варианта, а карточка в
 * панели показывала его же. Alpha пришла к тому же выводу своим путём —
 * «источник правды один, и откатывать после реролла ничего не нужно».
 *
 * `mesid` у ST — индекс, поэтому порядок числовой, а не лексический: иначе
 * «10» встало бы между «1» и «2».
 */
export function buildHistory(badges = {}) {
    return Object.keys(badges)
        .sort((a, b) => Number(a) - Number(b))
        .map(mesid => badges[mesid])
        .filter(Boolean)
        .filter((mark, index, all) => mark !== all[index - 1]);
}

/**
 * Шкала для промпта. Первая точка — заданное пользователем начало: пока
 * ничего не натикало, модели всё равно надо от чего-то отсчитывать, иначе
 * она придумает дату сама.
 */
export function buildTimeline(history, startTime) {
    const entries = (history ?? []).filter(Boolean).slice(-MAX_TIMELINE);
    const marks = entries.length ? entries : [String(startTime ?? '').trim()].filter(Boolean);
    if (!marks.length) return '"(not established yet)"';
    // Кавычки и стрелка — форма Alpha: так модель видит, где кончается одна
    // отметка и начинается другая, даже когда внутри есть запятые.
    return marks.map(mark => `"${mark}"`).join(' → ');
}

export function createTimeModule(host) {
    const preset = signal(TIME_PRESETS[0].id);
    const startTime = signal(TIME_PRESETS[0].start);
    const displayTemplate = signal(TIME_PRESETS[0].displayTemplate);
    const fields = signal(TIME_PRESETS[0].fields.map(field => ({ ...field })));
    const workerId = signal('');
    const enabled = signal(true);
    const workers = signal([]);
    // Пресет сэмплера/ризонинга — свойство ЭТОГО трекера, не воркера,
    // который его исполнит: тот же воркер может параллельно нести и
    // творческую генерацию, и её другие настройки не должны переезжать сюда
    // просто потому, что заняли один порт. `samplerPreset` (не `preset` —
    // это имя уже занято пресетом ПОЛЕЙ времени выше) хранится только ради
    // интерфейса, само Ядро трекинга смотрит на сами значения.
    const samplerPreset = signal('');
    const defaultSampler = clampSamplerSettings();
    const defaultReasoning = clampReasoningSettings();
    const temperature = signal(defaultSampler.temperature);
    const topP = signal(defaultSampler.topP);
    const topK = signal(defaultSampler.topK);
    const maxTokens = signal(defaultSampler.maxTokens);
    const reasoningMode = signal(defaultReasoning.reasoningMode);
    const reasoningEffort = signal(defaultReasoning.reasoningEffort);
    const reasoningBudget = signal(defaultReasoning.reasoningBudget);
    // Имя для «Save as preset» — своё поле формы, не персистится само по
    // себе. Пресет уходит в ОБЩИЙ список Ядра моделей (`model.presets.*`),
    // тот же, что видит и Модуль «Трекер».
    const newPresetName = signal('');
    const customPresets = signal([]);
    const label = signal('');
    const busy = signal(false);
    // Отметка каждого сообщения отдельно. Один общий сигнал на весь чат
    // означал бы одно время под всеми сообщениями сразу: обновили — переписали
    // историю. А ещё именно отсюда берётся честное «ещё не посчитано» у нового
    // сообщения: записи просто нет, и бейдж пульсирует пустым.
    const badges = signal({});
    // Шкала — ПРОИЗВОДНАЯ от отметок, а не второй список рядом. Пока список
    // был свой, реролл откатывал бейдж, но не шкалу: модель продолжала
    // отсчитывать от времени отброшенного варианта.
    const history = computed(() => buildHistory(badges()));
    // Свайп был, генерация ещё нет — под каким сообщением, узнаём позже,
    // прямо в обработчике `generation.beforeSend` (см. подписки ниже).
    let pendingSwipe = false;

    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    /**
     * Настоящее последнее отрисованное сообщение — ПРЯМО СЕЙЧАС, не то, что
     * когда-то запомнил рендер подвала. Раньше «куда писать» бралось из
     * побочного эффекта: фабрика подвала запоминала `mesid` каждый раз, когда
     * Ядро подвала звало её с `live: true`. При генерации с ToolCalls ST может
     * внутри ОДНОГО ответа пользователя несколько раз пересоздать и удалить
     * черновик последнего сообщения (пустой первый проход с вызовом
     * инструмента удаляется, а настоящий текст дописывается новым проходом —
     * `Generate()` там честно перезапускается целиком, `GENERATION_STARTED`
     * летит второй раз, наш же Ядро жизненного цикла закрывает первый прогон
     * как `superseded`). Запомненное значение рисковало застрять на этом
     * промежуточном, уже не существующем сообщении — и тогда свежее время
     * записывалось на сообщение ДО настоящего ответа, а не на него. Спрашивая
     * заново прямо в момент записи, гонки с этой пересборкой попросту нет: что
     * бы ни происходило посередине, к моменту `generation.completed` в чате
     * уже стоит настоящий финальный ответ.
     *
     * Спрашивает Ядро подвала (`ui.messageFooter.liveMesid`), а не Сервис
     * `stChat.*` напрямую: Модуль не обязан знать о существовании Сервисов
     * ST вообще, а Ядро подвала это значение и так уже считает для себя на
     * каждый `attach()` — второй источник истины о «что сейчас последнее»
     * заводить незачем.
     */
    async function currentMesid() {
        const result = await call('ui.messageFooter.liveMesid');
        return result.ok ? result.value ?? null : null;
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    // --- Шкала: память чата, а не настройки ---------------------------------

    async function loadHistory() {
        const marks = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: BADGES_KEY, fallback: {} });
        badges.set(marks.ok ? marks.value ?? {} : {});
    }

    async function saveBadges(next) {
        badges.set(next);
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: BADGES_KEY, value: next });
    }

    /** Отметка под конкретным сообщением. `null` стирает — так реролл возвращает бейдж в пустое пульсирующее ожидание. */
    async function markMessage(mesid, value) {
        if (mesid === null || mesid === undefined) return;
        const next = { ...badges.peek() };
        if (value) next[mesid] = value; else delete next[mesid];
        await saveBadges(next);
    }


    // --- Настройка трекера в Ядре -------------------------------------------

    /** Пресет заполняет и сэмплер, и ризонинг одним нажатием — дальше можно подкрутить руками, само нажатие ничего не сохраняет (Save остаётся отдельным шагом). Та же механика, что у пресетов полей времени выше. Ищет и среди готовых, и среди СВОИХ — форма об этом различии не знает. */
    function applySampler(id) {
        const found = [...SAMPLER_PRESETS, ...customPresets.peek()].find(item => item.id === id);
        if (!found) return;
        samplerPreset.set(found.id);
        temperature.set(found.temperature);
        topP.set(found.topP);
        topK.set(found.topK);
        maxTokens.set(found.maxTokens);
        reasoningMode.set(found.reasoningMode);
        reasoningEffort.set(found.reasoningEffort);
        reasoningBudget.set(found.reasoningBudget);
    }

    async function refreshCustomPresets() {
        const result = await call('model.presets.get');
        customPresets.set(result.ok ? result.value ?? [] : []);
    }

    /** Список подключений — читается заново по `model.workers.changed`, не только при загрузке: подключение, добавленное или удалённое в панели воркеров, обязано появиться в выборе без перезагрузки страницы. */
    async function refreshWorkers() {
        const result = await call('model.workers.get');
        workers.set((result.ok ? result.value ?? [] : []).map(worker => ({ value: worker.id, label: worker.id })));
    }

    /** Сохраняет текущую подстройку как СВОЙ пресет — в общий список, доступный и Модулю «Трекер». Имя, уже занятое, обновляет тот же пресет (см. `buildCustomPreset`/`slugifyPresetName`). */
    async function savePreset(name) {
        const trimmed = String(name ?? '').trim();
        if (!trimmed) { await notify('error', 'Name the preset first'); return; }
        const preset = buildCustomPreset(trimmed, {
            temperature: temperature.peek(), topP: topP.peek(), topK: topK.peek(), maxTokens: maxTokens.peek(),
            reasoningMode: reasoningMode.peek(), reasoningEffort: reasoningEffort.peek(), reasoningBudget: reasoningBudget.peek(),
        });
        const next = [...customPresets.peek().filter(item => item.id !== preset.id), preset];
        const result = await call('model.presets.set', { presets: next });
        if (result.ok) { customPresets.set(next); samplerPreset.set(preset.id); newPresetName.set(''); }
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Saved preset "${trimmed}"` : result.error.message);
    }

    /** Удаляет пресет, выбранный СЕЙЧАС — только свой (готовый из коробки для удаления не показывается вовсе). Значения не трогает: имя забыто, подстройка остаётся. */
    async function deletePreset() {
        const id = samplerPreset.peek();
        if (!id) return;
        const next = customPresets.peek().filter(item => item.id !== id);
        const result = await call('model.presets.set', { presets: next });
        if (result.ok) { customPresets.set(next); samplerPreset.set(''); }
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Preset deleted' : result.error.message);
    }

    function trackerConfig() {
        return {
            id: TRACKER_ID,
            // `kind: 'user'` — потому что макрос писаться ОБЯЗАН: время всегда
            // доступно как `{{...}}`, ровно как в Alpha.
            kind: 'user',
            // …но распоряжается им этот Модуль, а не человек руками. Модуль
            // трекеров по `ownerId` его и не показывает — ни в списке, ни в
            // своей плавающей панели: там место трекерам, которые пользователь
            // завёл сам.
            ownerId: MODULE_ID,
            enabled: enabled.peek(),
            workerId: workerId.peek(),
            fields: fields.peek().map(field => ({ name: field.name, prompt: field.prompt ?? '' })),
            // Инструкция — в системное сообщение, сама шкала/переписка — в
            // пользовательское (Ядро трекинга шлёт их РАЗНЫМИ сообщениями,
            // см. его doc-comment).
            systemPromptTemplate: TIME_SYSTEM_PROMPT,
            promptTemplate: TIME_PROMPT,
            // Сэмплер/ризонинг — свойство ЭТОГО трекера, не воркера: «RP
            // Time» вправе хотеть точности и без раздумий, даже если тот же
            // воркер параллельно обслуживает творческую генерацию с другими
            // настройками.
            temperature: temperature.peek(), topP: topP.peek(), topK: topK.peek(), maxTokens: maxTokens.peek(),
            reasoningMode: reasoningMode.peek(), reasoningEffort: reasoningEffort.peek(), reasoningBudget: reasoningBudget.peek(),
            // Триггеров у трекера нет: опрос запускает САМ Модуль (см.
            // `advance()`), потому что перед опросом он обязан подставить в
            // промпт свежую шкалу. Триггер Директора этого сделать не может —
            // он умеет позвать контракт, но не подготовить его аргументы.
            triggers: [],
        };
    }

    async function save() {
        const listed = await call('tracking.trackers');
        const others = (listed.ok ? listed.value ?? [] : []).filter(tracker => tracker.id !== TRACKER_ID);
        const result = await call('tracking.configure', { trackers: [...others, trackerConfig()] });
        if (result.ok) {
            await call('storage.settings.set', {
                namespace: SETTINGS_NAMESPACE,
                key: 'settings',
                value: {
                    preset: preset.peek(), startTime: startTime.peek(), displayTemplate: displayTemplate.peek(), fields: fields.peek(), workerId: workerId.peek(), enabled: enabled.peek(),
                    samplerPreset: samplerPreset.peek(), temperature: temperature.peek(), topP: topP.peek(), topK: topK.peek(), maxTokens: maxTokens.peek(),
                    reasoningMode: reasoningMode.peek(), reasoningEffort: reasoningEffort.peek(), reasoningBudget: reasoningBudget.peek(),
                },
            });
        }
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'RP time settings saved' : result.error.message);
        return result.ok;
    }

    /**
     * Один шаг времени. Именно здесь живёт специализация: Модуль сам собирает
     * шкалу и подаёт её в опрос как `{timeline}`, а всё остальное — работа
     * Ядра трекинга.
     */
    async function advance() {
        if (!enabled.peek() || busy.peek()) return null;
        busy.set(true);
        // Показание гасится НА ВРЕМЯ опроса: пока идёт новый шаг, старое время
        // уже неверно, и держать его на экране — врать пользователю. Пустое
        // значение переводит карточку в пульсирующее ожидание (см. StatBlock).
        // Бейджа под сообщением это НЕ касается: у каждого своя отметка, и
        // прошлые остаются такими, какими были.
        label.set('');
        try {
            const result = await call('tracking.poll', {
                trackerId: TRACKER_ID,
                vars: { timeline: buildTimeline(history.peek(), startTime.peek()) },
            });
            if (!result.ok) {
                // Опрос не удался — возвращаем ПРОШЛУЮ отметку: она хотя бы
                // была верна когда-то, а вечно пульсирующая пустота выглядела бы
                // как «модуль сломался навсегда».
                label.set(history.peek().at(-1) ?? '');
                await notify('error', `RP time: ${result.error.message}`);
                return null;
            }
            const next = buildTimeLabel(result.value ?? [], displayTemplate.peek());
            label.set(next);
            // Спрашиваем, куда писать, ТОЛЬКО сейчас — см. doc-comment
            // `currentMesid()`: опрос модели шёл какое-то время, и брать цель
            // до него значило бы рисковать той же гонкой, от которой это и
            // лечит.
            await markMessage(await currentMesid(), next);
            return next;
        } finally {
            busy.set(false);
        }
    }

    async function reset() {
        label.set('');
        // Отметки сообщений — единственное, что нужно стереть: шкала из них и
        // считается.
        await saveBadges({});
        await call('tracking.reset', { trackerId: TRACKER_ID });
        await notify('ok', 'RP time cleared for this chat');
    }

    function applyPreset(id) {
        const found = TIME_PRESETS.find(item => item.id === id) ?? TIME_PRESETS[0];
        preset.set(found.id);
        startTime.set(found.start);
        displayTemplate.set(found.displayTemplate);
        fields.set(found.fields.map(field => ({ ...field })));
    }

    // --- Отрисовка -----------------------------------------------------------

    /** Виджет в полосе под сообщением — ровно то, чем в Alpha был бейдж времени. */
    function footerWidget(message) {
        // Реплика пользователя — не момент игрового времени: время считается
        // ПО ответу. Отказ возвращается Ядру подвала как `null`, и подвала под
        // таким сообщением не заводится вовсе. Раньше бейдж успевал прыгнуть в
        // сообщение пользователя и остаться там вторым.
        if (message.isUser || message.isSystem) return null;
        // Сообщение с вызовом инструмента — ЧЕРНОВИК по пути, не окончательный
        // ответ: та же самая реплика персонажа, но следом за ней ST допишет
        // ЕЩЁ одну, уже настоящую. Пока идёт цепочка вызовов, live-сообщением
        // по очереди становится то одно такое сообщение, то другое — и КАЖДОЕ
        // получало бы пустой пульсирующий бейдж, хотя ни одно из них никогда
        // не получит настоящую отметку: `advance()` пишет её только на
        // сообщение, которое окажется последним ПОСЛЕ того, как вся цепочка
        // закончится. Отказ здесь — не «ещё нет данных», а «здесь их не будет
        // никогда»: под этим сообщением нет вообще ничего, как и под репликой
        // пользователя.
        if (message.isToolCall) return null;
        // Своё значение у каждого сообщения. Записи ещё нет — StatBlock сам
        // покажет пустоту и будет пульсировать рамкой: именно это и означает
        // «время для этого ответа ещё считается».
        return StatBlock('Current RP time', () => badges()[message.mesid] ?? '', { icon: '◷' });
    }

    function tree() {
        return h('div', { class: 'stme-module-body' },
            Row(
                h('small', { class: 'stme-module-hint' }, 'Works out how much in-world time passed with each reply'),
                Button('Save', save),
            ),
            Row(
                Field('Preset', Select(preset, TIME_PRESETS.map(item => ({ value: item.id, label: item.name })))),
                Field('Model connection', Select(workerId, workers)),
                Toggle('Enabled', enabled),
            ),
            Row(Button('Apply preset', () => applyPreset(preset.peek()))),
            // Сэмплер/ризонинг — свойство ЭТОГО трекера, а не выбранного выше
            // подключения: тот же воркер вправе параллельно обслуживать
            // творческую генерацию с другими настройками. Общая карточка
            // (см. libraries/shared/generation-settings-panel.js) — та же,
            // что у каждого трекера в Модуле «Трекер», иначе они расходятся
            // при первой же самостоятельной правке.
            GenerationSettingsPanel(
                { samplerPreset, temperature, topP, topK, maxTokens, reasoningMode, reasoningEffort, reasoningBudget, newPresetName },
                () => [...SAMPLER_PRESETS, ...customPresets()],
                { onApplyPreset: applySampler, onSavePreset: savePreset, onDeletePreset: deletePreset },
            ),
            Field('Starting time', TextInput(startTime, { placeholder: 'Year 1, Month 1, Day 1, 08:00 (Morning)' }), {
                hint: 'Where the clock starts before anything has been worked out yet.',
            }),
            Field('Display template', TextInput(displayTemplate, { placeholder: '{time} ({period})' }), {
                hint: 'Click a token to append it.',
            }),
            h('div', { class: 'stme-tracker-tokens' },
                computed(() => fields().map(field => Chip(`{${field.name}}`, {
                    title: `Append {${field.name}}`,
                    onClick: () => displayTemplate.set(`${displayTemplate.peek()}{${field.name}}`),
                }))),
            ),
            h('div', { class: 'stme-tracker-fields' },
                EditableList({
                    items: fields,
                    renderItem: field => h('div', { key: field.name, class: 'stme-tracker-field' },
                        h('code', { class: 'stme-tracker-field-name' }, field.name),
                        h('small', {}, field.prompt || '—'),
                    ),
                    empty: 'No fields — pick a preset above.',
                }),
            ),
            h('div', { class: 'stme-tracker-current' },
                h('strong', {}, 'Current'),
                computed(() => h('span', { class: 'stme-tracker-current-value' }, label() || '—')),
            ),
            Row(
                Button('Advance now', advance),
                Button('Reset for this chat', reset, { variant: 'danger' }),
            ),
        );
    }

    // --- Жизнь ---------------------------------------------------------------

    const subscriptions = [
        // Время идёт ПОСЛЕ ответа: раньше него шага ещё не случилось. Ровно тот
        // же момент, на котором это делала Alpha.
        host.events.subscribe('generation.completed', () => { advance(); }),
        // Реролл: ответ будет переписан заново, значит и время для него —
        // другое. Но `MESSAGE_SWIPED` у ST шлётся и при ПРОСТОМ пролистывании
        // уже готовых вариантов (проверено по script.js: событие идёт до
        // ветки `if (run_generate)`), а там переписывать нечего. Поэтому здесь
        // только поднимается ФЛАГ, а стирание и цель — на `generation.
        // beforeSend`, когда генерация уже точно началась.
        //
        // Флаг — булев, а не сразу пойманный `mesid`: оба события синхронные,
        // а поймать `mesid` в САМОМ обработчике свайпа значило бы ждать
        // `ui.messageFooter.liveMesid` асинхронно — и `generation.beforeSend`
        // от настоящей ST успевал прилететь РАНЬШЕ, чем этот запрос вернётся
        // (проверено этим же тестом: без него `pendingSwipe` в момент проверки
        // ещё оставался пуст). Спрашивать «под каким сообщением» нужно уже
        // ВНУТРИ обработчика beforeSend — там гонки нет, это последний
        // потребитель в цепочке, и его никто не ждёт синхронно.
        host.events.subscribe('st.messageSwiped', () => { pendingSwipe = true; }),
        host.events.subscribe('generation.beforeSend', async () => {
            if (!pendingSwipe) return;
            pendingSwipe = false;
            // На этот момент сообщение, которое свайпнули, ЕЩЁ остаётся
            // последним отрисованным — новый свайп не создаёт новый DOM-узел,
            // он лишь дописывается к существующему.
            const target = await currentMesid();
            // Откат ЦЕЛИКОМ: снятая отметка убирает и последнюю точку шкалы
            // (та считается из отметок), а карточка возвращается к времени
            // предыдущего сообщения. Иначе модель продолжала бы отсчитывать от
            // варианта, который пользователь только что отбросил.
            await markMessage(target, null);
            label.set(history.peek().at(-1) ?? '');
        }),
        /**
         * ВТОРОЙ путь реролла — не свайп-стрелка, а «Regenerate» (пункт меню
         * / хоткей). У настоящей ST это СОВСЕМ другой код: он не эмитит
         * `MESSAGE_SWIPED` вовсе, а вместо этого укорачивает `chat` на одно
         * сообщение (`chat.length -= 1`) и шлёт `MESSAGE_DELETED` с новой
         * длиной чата — которая и есть индекс/`mesid` только что удалённого
         * сообщения (проверено по script.js). Новое сообщение сгенерируется
         * под тем же самым `mesid` — если не стереть тут старую отметку, она
         * молча всплывёт на месте ещё не досчитанного нового ответа. Стираем
         * БЕЗУСЛОВНО: если сообщение удалили и без намерения перегенерировать
         * его, стирать там всё равно нечего терять — прежняя отметка мертва
         * вместе с сообщением.
         */
        host.events.subscribe('st.messageDeleted', async payload => {
            const deletedMesid = String(payload?.args?.[0] ?? '').trim();
            if (!deletedMesid) return;
            await markMessage(deletedMesid, null);
            label.set(history.peek().at(-1) ?? '');
        }),
        // Другой чат — другое время. Шкалу перечитываем, а не тащим с собой.
        host.events.subscribe('st.chatChanged', () => { loadHistory().then(() => label.set(history.peek().at(-1) ?? '')); }),
        // Пресет сохранил или удалил КТО-ТО ДРУГОЙ — свой же список общий с
        // Модулем «Трекер», и без этого сохранённое там появлялось бы здесь
        // только после ручной перезагрузки страницы.
        host.events.subscribe('model.presets.changed', () => refreshCustomPresets()),
        // Подключение добавили/убрали в панели воркеров — список выбора
        // обязан узнать об этом сам, без перезагрузки страницы.
        host.events.subscribe('model.workers.changed', () => refreshWorkers()),
    ];

    async function load() {
        const saved = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: 'settings', fallback: null });
        if (saved.ok && saved.value) {
            preset.set(saved.value.preset ?? TIME_PRESETS[0].id);
            startTime.set(saved.value.startTime ?? TIME_PRESETS[0].start);
            displayTemplate.set(saved.value.displayTemplate ?? TIME_PRESETS[0].displayTemplate);
            fields.set(saved.value.fields ?? TIME_PRESETS[0].fields);
            workerId.set(saved.value.workerId ?? '');
            enabled.set(saved.value.enabled !== false);
            samplerPreset.set(saved.value.samplerPreset ?? '');
            // Клэмп, а не значения с диска как есть — ручная правка файла
            // настроек или старая запись до появления этих полей не должны
            // уйти к провайдеру мимо собственных границ ползунков.
            const sampler = clampSamplerSettings(saved.value);
            temperature.set(sampler.temperature);
            topP.set(sampler.topP);
            topK.set(sampler.topK);
            maxTokens.set(sampler.maxTokens);
            const reasoning = clampReasoningSettings(saved.value);
            reasoningMode.set(reasoning.reasoningMode);
            reasoningEffort.set(reasoning.reasoningEffort);
            reasoningBudget.set(reasoning.reasoningBudget);
        }
        await refreshWorkers();
        await refreshCustomPresets();

        await loadHistory();
        label.set(history.peek().at(-1) ?? '');
        // Трекер заводится в Ядре сразу: он должен существовать ещё до первого
        // опроса, иначе первый же ответ упёрся бы в «неизвестный трекер».
        const listed = await call('tracking.trackers');
        const others = (listed.ok ? listed.value ?? [] : []).filter(tracker => tracker.id !== TRACKER_ID);
        await call('tracking.configure', { trackers: [...others, trackerConfig()] });
        await call('ui.messageFooter.claim', { slot: 'left', ownerId: MODULE_ID, node: footerWidget });
    }

    return {
        id: MODULE_ID,
        title: 'RP Time',
        description: 'Works out in-world time from the conversation and keeps it as a macro.',
        load,
        tree,
        advance,
        reset,
        save,
        applyPreset,
        applySampler,
        savePreset,
        deletePreset,
        customPresets: () => customPresets.peek(),
        workers: () => workers.peek(),
        newPresetName,
        label,
        history,
        badges,
        fields,
        startTime,
        displayTemplate,
        enabled,
        samplerPreset,
        temperature,
        topP,
        topK,
        maxTokens,
        reasoningMode,
        reasoningEffort,
        reasoningBudget,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            call('ui.messageFooter.release', { ownerId: MODULE_ID });
        },
    };
}
