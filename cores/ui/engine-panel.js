import { h } from './tree.js';
import { signal, computed, effect } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import {
    Button, TextInput, TextArea, NumberInput, Select, Toggle, Slider, Chip, Details,
    Field, Row, Card, Section, Badge, EmptyState, TwoColumn, EditableList, ProgressBar,
} from '../../libraries/shared/widgets.js';
import { createCollapseState } from '../../libraries/shared/collapse-state.js';
import { TRIGGER_MODES, computeTriggers, resolveTriggerMode } from '../../libraries/core/trigger-modes.js';

const FORMATS = Object.freeze([
    { value: 'openai', label: 'OpenAI-compatible' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google Gemini' },
]);

const MACRO_KINDS = Object.freeze([
    { value: 'text', label: 'Plain text' },
    { value: 'code', label: 'Code' },
]);

// Chat Viewport side margin — owner: "Сделать ВО ВСЮ ширину страницы.
// Отступ чисто небольшой дефолтно, чтобы было читаемо. Далее — можно сузить
// до любой ширины, не меньше ДЕФОЛТНОЙ для ST". `MIN_WIDTH_FRACTION` — та
// самая "ДЕФОЛТНАЯ для ST" ширина: `chat_width: 50` (то есть 50vw/половина
// страницы) — захардоженный ДЕФОЛТ ST из `power-user.js`, НЕ текущая
// настройка владельца (она может быть любой — не наше дело её здесь
// читать/угадывать).
const DEFAULT_SIDE_MARGIN = 24;
const MIN_WIDTH_FRACTION = 0.5;

let uid = 0;

/** JS-identifier-safe macro name — same spirit as Tracker's field-name sanitizing (no whitespace, bounded length). Applied on save, not on every keystroke, so the user can type freely and see it settle. */
export function sanitizeMacroName(value) {
    return String(value ?? '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 60);
}

/** Плоская запись воркера → набор сигналов для правки, со стабильным ключом (id можно менять, ключ — нет, иначе строка пересоздаётся на каждую букву). */
function toRecord(worker = {}) {
    return {
        key: `worker_${++uid}`,
        id: signal(worker.id ?? ''),
        format: signal(worker.format ?? 'openai'),
        endpoint: signal(worker.endpoint ?? ''),
        apiKey: signal(worker.apiKey ?? ''),
        model: signal(worker.model ?? ''),
        // Не строка статуса, а КРАТКОВРЕМЕННОЕ состояние блока: '' | 'testing' |
        // 'ok' | 'error'. Результат словами уходит в уведомления, здесь
        // остаётся только вспышка обводки — она относится к КОНКРЕТНОМУ
        // подключению, и показывать её надо на нём, а не строкой под ним.
        flash: signal(''),
    };
}

function fromRecord(record) {
    return {
        id: record.id.peek().trim(),
        format: record.format.peek(),
        endpoint: record.endpoint.peek().trim(),
        apiKey: record.apiKey.peek(),
        model: record.model.peek().trim(),
    };
}

/**
 * Плоская запись программы-макроса → набор сигналов для правки. `id` — не
 * пользовательское поле вовсе (в отличие от воркера, где `id` и есть имя):
 * генерируется один раз при добавлении и никогда не показывается — то, что
 * пользователь видит и трогает, это `name` (для себя) и `macroName`
 * (настоящее `{{имя}}`).
 */
function toMacroRecord(program = {}) {
    const { mode, count } = resolveTriggerMode(program.triggers);
    return {
        key: `macro_${++uid}`,
        id: signal(program.id ?? `macro_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
        name: signal(program.name ?? ''),
        macroName: signal(program.macroName ?? ''),
        kind: signal(program.kind === 'code' ? 'code' : 'text'),
        source: signal(program.source ?? ''),
        enabled: signal(program.enabled !== false),
        triggerMode: signal(mode),
        triggerCount: signal(count),
        // Живёт только в UI — результат последнего "Test run", не то, что
        // когда-либо уходит на Шину.
        testResult: signal(null),
        flash: signal(''),
    };
}

function fromMacroRecord(record) {
    return {
        id: record.id.peek().trim(),
        name: record.name.peek().trim(),
        macroName: sanitizeMacroName(record.macroName.peek()),
        kind: record.kind.peek() === 'code' ? 'code' : 'text',
        source: record.source.peek(),
        enabled: record.enabled.peek(),
        triggers: computeTriggers(record.triggerMode.peek(), record.triggerCount.peek()),
    };
}

/**
 * Экран движка — то, что пользователь реально видит и трогает.
 *
 * Это **Ядро**, а не Модуль: движок без своего интерфейса не работает, и
 * пользователь его не подключает (см. критерий в ARCHITECTURE.md).
 *
 * Панель поделена пополам: слева — своё, ядро и сервисы; справа — то, что
 * подключает пользователь. Модулей пока нет вообще, и правая половина честно
 * это показывает, а не притворяется занятой.
 *
 * Здесь НЕТ вёрстки как таковой: всё, что можно переиспользовать, живёт в
 * [libraries/shared/widgets.js](../../libraries/shared/widgets.js) — в этом
 * файле остаётся только проводка виджетов к настоящим контрактам своей Шины.
 * И всё, что панель делает с моделями, она делает через контракты
 * (`model.workers.get/set`, `model.generate`), а не через JS-ссылку на Ядро:
 * править эндпоинты и ключи в обход Шины было бы ровно тем случаем, ради
 * которого Гейты и существуют.
 */
export function createEnginePanelCore(host, { mount, mountSettings, listContracts, modules: moduleRegistry, openMemoryGraphPanel, chatViewport } = {}) {
    // Что свёрнуто — помнится между сеансами. По умолчанию свёрнуто всё.
    const collapse = createCollapseState(host.own, { namespace: 'core.ui.panel' });
    const workers = signal([]);
    const macros = signal([]);
    const lorebookEntries = signal([]);
    const lorebookBooks = signal([]);
    const memoryGraphNodeCount = signal(0);
    // Прогресс бутстрапа из Lorebook (решено с пользователем: "нет ивентов
    // начала и конца построения WI... нет индикатора прогресса. Это очень
    // плохо" + следом "добавь прогресс-бар"). `memoryGraphFlash` — та же
    // пульсация обводки, что у "Test" воркера/проверки обновления (см.
    // `flash()` ниже), только выставляется НАПРЯМУЮ (не автогаснущим
    // `flash()`) на всё время бутстрапа — гаснет сама только на `finished`.
    // `memoryGraphProgress` — null, когда бутстрап не идёт; `{done, total,
    // phase}` — грубая, но живая оценка (`cores/memory-graph/index.js`'s
    // `bootstrapFromLorebook()` тикает её по ходу дела), не точный процент.
    const memoryGraphFlash = signal('');
    const memoryGraphProgress = signal(null);
    // Чувствительность отбора "сильных изменений" (`thresholdK` — реальная
    // жалоба пользователя: "не работает это, я могу подкрутить сам это
    // число? Где оно?" — раньше настраивалось ТОЛЬКО кодом/контрактом
    // напрямую, никакого UI не было вовсе).
    const memoryGraphThresholdK = signal(1.5);
    const summaries = signal([]);
    const summaryLevels = signal([]);
    const summaryProtectedWindow = signal(20);
    const summaryWorkerId = signal('');
    const summaryVerifyEnabled = signal(false);
    const summaryVerifyWorkerId = signal('');
    // Список трекеров (с полями) для «Insert a value» под редактором кода —
    // источник, откуда пикер берёт настоящие `get "id:field"` ключи, а не
    // заставляет вводить их руками (реальный `id` трекера — не его название).
    const trackerFields = signal([]); // [{ id, fields: [name, ...] }]
    const modules = signal([]);
    const enabledIds = signal([]);
    // Один СТАБИЛЬНЫЙ сигнал включённости на модуль. Раньше здесь был
    // computed(), создаваемый заново внутри отрисовки карточки — то есть на
    // каждую перерисовку узел получал НОВЫЙ сигнал, а подписан оставался на
    // старый. Та же ошибка, что уже ловили с памятью о свёрнутом: сигнал,
    // рождённый в функции отрисовки, живёт меньше, чем узел, который его читает.
    const enabledSignals = new Map(); // moduleId -> signal(boolean)

    function enabledSignal(moduleId) {
        if (!enabledSignals.has(moduleId)) enabledSignals.set(moduleId, signal(enabledIds.peek().includes(moduleId)));
        return enabledSignals.get(moduleId);
    }

    function syncEnabled(ids) {
        enabledIds.set(ids);
        for (const [moduleId, state] of enabledSignals) state.set(ids.includes(moduleId));
    }
    const contracts = signal([]);
    const generationStage = signal('idle');
    const repository = signal({ owner: '', repo: '', extensionName: '' });
    // Фоны из репозитория (cores/backgrounds): состояние карточки «Backgrounds».
    const backgroundsStatus = signal(null);
    const backgroundsAuto = signal(true);
    const backgroundsRemoveDeleted = signal(true);
    const backgroundsBusy = signal(false);
    const updateText = signal('Not checked yet.');
    const updateTone = signal('muted');
    const updateBusy = signal(false);
    // Та же вспышка обводки, что и у проверки подключения («Test»): синяя
    // пульсация пока идёт запрос, зелёная/красная — на исход. Раньше об
    // исходе проверки версии движка говорил только текст статуса, и его
    // легко было не заметить рядом с остальной панелью.
    const updateFlash = signal('');
    const eventCount = signal(0);
    // Карточка Preset: та же вспышка обводки, что у проверки обновления, и
    // флаг «идёт импорт» — импорт асинхронный (файл → снапшот → reconcile
    // всех Модулей), и без него кнопка выглядела бы мёртвой на время работы.
    const presetFlash = signal('');
    const presetBusy = signal(false);

    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    /**
     * Вызов СЕРВИСНОГО контракта — через Гейт (host.services), а не через
     * host.own: file.* зарегистрированы на Шине сервисов, и домашняя Шина
     * ядер их не видит в принципе. Каждый такой вызов проходит реальную
     * проверку прав на пересечении домена (ARCHITECTURE.md: «даже когда
     * резолвинг тривиален») — здесь это Ядро UI, tier official.
     */
    async function callService(contract, params) {
        return request(host.services, contract, { params });
    }

    /**
     * `callService()` отдаёт СЫРОЙ конверт `{ok, value, error}` — существующие
     * места сами решают, как обработать отказ (см. `exportPreset()`/
     * `importPreset()`: разная реакция на разные контракты). Chat Viewport
     * зовёт `dom.*`/`stChat.*` десятками подряд ради одной операции
     * (`enableChatViewport()`), и для НЕГО отказ в середине цепочки всегда
     * означает одно и то же — прервать и сообщить, поэтому здесь один общий
     * разворачиватель, а не ручная проверка `.ok` на каждой строке.
     */
    async function callServiceOrThrow(contract, params) {
        const result = await callService(contract, params);
        if (!result.ok) throw new Error(`${contract}: ${result.error.message}`);
        return result.value;
    }

    /**
     * Включение/выключение делает НЕ панель — она только просит реестр
     * Модулей. Кто их грузит и монтирует, знает сборщик движка (в будущем —
     * Раннер), а панель обязана оставаться экраном, а не менеджером
     * жизненного цикла чужого кода.
     */
    async function toggleModule(entry, enable) {
        if (!moduleRegistry) return;
        // Панель НЕ отслеживает состояние сама: реестр сообщит о смене через
        // `refreshModules()` — и когда переключили здесь, и когда Модуль
        // включили в обход панели. Держи она свой список, эти два пути
        // разъехались бы.
        await (enable ? moduleRegistry.enable(entry.id) : moduleRegistry.disable(entry.id));
    }

    async function loadWorkers() {
        const result = await call('model.workers.get');
        workers.set((result.ok ? result.value ?? [] : []).map(toRecord));
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    /** Вспышка гаснет сама: это подтверждение, а не состояние, и оставлять его висеть незачем. Берёт сигнал напрямую — годится и записи воркера (`record.flash`), и одиночному сигналу вроде `updateFlash`. */
    function flash(flashSignal, tone) {
        flashSignal.set(tone);
        setTimeout(() => { if (flashSignal.peek() === tone) flashSignal.set(''); }, 1600);
    }

    async function saveWorkers() {
        const list = workers.peek().map(fromRecord).filter(worker => worker.id);
        const result = await call('model.workers.set', { workers: list });
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `Saved ${list.length} connection${list.length === 1 ? '' : 's'}` : result.error.message);
        return result.ok;
    }

    async function testWorker(record) {
        const id = record.id.peek().trim();
        if (!id) { await notify('error', 'Give the connection a name first'); flash(record.flash, 'error'); return; }
        // Тест идёт по СОХРАНЁННОЙ конфигурации: иначе «работает» означало бы
        // «работало бы, если бы ты нажал сохранить» — худший вид зелёной галочки.
        await saveWorkers();
        record.flash.set('testing');
        const startedAt = Date.now();
        const result = await call('model.generate', { prompt: 'Reply with exactly: OK', maxTokens: 16, workerId: id });
        flash(record.flash, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `${id}: OK in ${Date.now() - startedAt}ms` : `${id}: ${result.error.message}`);
    }

    function removeWorker(record) {
        workers.set(workers.peek().filter(item => item !== record));
    }

    function addWorker() {
        workers.set([...workers.peek(), toRecord({ id: `connection_${workers.peek().length + 1}`, format: 'openai' })]);
    }

    function workerRow(record) {
        // Section, а не Card: рамку рисует «Model connections» сверху, а вложенность
        // внутри неё видна по фону.
        return Section(record.id, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`worker:${record.key}`),
            actions: [Button('Test', () => testWorker(record)), Button('Remove', () => removeWorker(record), { variant: 'danger' })],
        },
            Row(
                Field('Name', TextInput(record.id, { placeholder: 'my-connection' })),
                Field('Format', Select(record.format, FORMATS)),
            ),
            Field('Endpoint', TextInput(record.endpoint, { placeholder: 'https://api.example.com/v1' })),
            Row(
                Field('API key', TextInput(record.apiKey, { type: 'password', placeholder: 'optional for local' })),
                Field('Model', TextInput(record.model, { placeholder: 'model name' })),
            ),
        );
    }

    function modelsCard() {
        // Save живёт ВНУТРИ блока, а не в шапке: шапка — отдельная полоса с
        // своим фоном, и кнопка в ней читается как относящаяся к разделу
        // целиком, а не к списку под ней.
        return Card('Model connections', {
            ...collapse.bind('card:models'),
            subtitle: 'Where the engine gets its own generations from',
        },
            EditableList({
                items: workers,
                renderItem: workerRow,
                onAdd: addWorker,
                addLabel: '+ Add connection',
                empty: 'No connections yet. Add one to let the engine run its own model calls.',
                actions: [Button('Save', saveWorkers)],
            }),
        );
    }

    /**
     * Интерфейс макросов — «как в Alpha», но частью ЭКРАНА ДВИЖКА (левая
     * половина, «своё»), а не Модулем: макрос — не отключаемая фича, а
     * способ показать любое значение движка настоящей ST (`{{name}}` в
     * промпте, World Info, карточке персонажа) — примитив уровня движка,
     * тот же довод, что уже развёл Ядро/Модуль в ARCHITECTURE.md.
     *
     * Панель — тонкая проводка к контрактам Ядра macros
     * ([cores/macros/index.js](../macros/index.js)): `macros.programs`
     * (список), `macros.configure` (сохранить целиком — та же форма, что и
     * `model.workers.set`), `macros.test` (предпросмотр ЧЕРНОВИКА без
     * побочных эффектов — не пишет `save()`, не трогает кэш и реальную ST).
     * Сам язык и его исполнение здесь не описаны ни строчкой — это работа
     * Ядра и [macro-language.js](../../libraries/core/macro-language.js).
     */
    async function loadMacros() {
        const result = await call('macros.programs');
        macros.set((result.ok ? result.value ?? [] : []).map(toMacroRecord));
    }

    /** «Insert a value» под редактором кода читает ЭТОТ список — реальные `id` трекеров с их полями, а не название, которое пользователь мог придумать. */
    async function loadTrackerFields() {
        const listed = await call('tracking.trackers');
        const trackers = (listed.ok ? listed.value ?? [] : []);
        const withFields = await Promise.all(trackers.map(async tracker => {
            const fields = await call('tracking.fields', { trackerId: tracker.id });
            return { id: tracker.id, fields: (fields.ok ? fields.value ?? [] : []).map(field => field.name) };
        }));
        trackerFields.set(withFields);
    }

    async function saveMacros() {
        const list = macros.peek().map(fromMacroRecord).filter(program => program.macroName);
        const result = await call('macros.configure', { programs: list });
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `Saved ${list.length} macro${list.length === 1 ? '' : 's'}` : result.error.message);
        return result.ok;
    }

    function addMacro() {
        macros.set([...macros.peek(), toMacroRecord({})]);
    }

    function removeMacro(record) {
        macros.set(macros.peek().filter(item => item !== record));
    }

    /** Черновик — ровно то, что видно РЕДАКТОРЕ прямо сейчас, ещё не обязательно сохранённое; никаких побочных эффектов на реальную ST (см. `testProgram()`'s doc-comment в Ядре). */
    async function testMacro(record) {
        record.testResult.set(null);
        const draft = { id: record.id.peek(), name: record.name.peek(), macroName: sanitizeMacroName(record.macroName.peek()), kind: record.kind.peek(), source: record.source.peek() };
        const result = await call('macros.test', { program: draft });
        if (!result.ok) { record.testResult.set({ ok: false, error: result.error.message }); flash(record.flash, 'error'); return; }
        record.testResult.set(result.value);
        flash(record.flash, result.value.ok ? 'ok' : 'error');
    }

    /**
     * Триггер макроса — та же карточка, что у трекера (см. Модуль «Трекер»),
     * только без переключателя «ждать» — макрос никуда не вкладывается в
     * промпт, блокировать генерацию ради него нечем и незачем.
     */
    function triggerSection(record) {
        const needsCount = computed(() => record.triggerMode() === 'everyNReplies' || record.triggerMode() === 'everyNMinutes');
        return h('div', { class: 'stme-tracker-trigger' },
            Field('Run when', Select(record.triggerMode, TRIGGER_MODES)),
            computed(() => {
                if (!needsCount()) return null;
                return record.triggerMode() === 'everyNMinutes'
                    ? Slider('Every N minutes', record.triggerCount, { min: 1, max: 120, step: 1 })
                    : Slider('Every N replies', record.triggerCount, { min: 1, max: 50, step: 1 });
            }),
            computed(() => {
                const triggers = computeTriggers(record.triggerMode(), record.triggerCount());
                return h('small', { class: 'stme-tracker-when' },
                    triggers.length ? `Director condition: ${JSON.stringify(triggers[0])}` : 'No automatic runs — use “Test run”, or save and it recomputes right after saving.',
                );
            }),
        );
    }

    /**
     * «Insert a value» — построен так, чтобы позже было куда добавить ещё
     * источники (лорбук, когда появится своё Ядро) без переписывания формы:
     * один источник = один `{ id, title, items }`, сейчас единственный
     * реальный источник — трекеры (включая специализированные Модули вроде
     * «RP Time» — те тоже просто трекеры с `ownerId`, см. Ядро трекинга).
     */
    function insertPickerSection(record) {
        const sources = computed(() => trackerFields().map(tracker => ({
            id: tracker.id,
            title: tracker.id,
            items: tracker.fields.map(field => ({ label: field, key: `${tracker.id}:${field}` })),
        })));
        return Details('Insert a value', h('small', {}, ' Real keys from your trackers — click one to append it to the code.'),
            h('div', { class: 'stme-macro-picker-body' },
                computed(() => (sources().length === 0
                    ? h('p', { class: 'stme-macro-empty' }, 'No trackers configured yet — add one in the Tracker module first.')
                    : sources().map(source => h('div', { key: source.id, class: 'stme-macro-picker-source' },
                        h('strong', {}, source.title),
                        h('div', { class: 'stme-macro-picker-fields' },
                            source.items.length
                                ? source.items.map(item => Chip(item.label, {
                                    title: `get "${item.key}"`,
                                    onClick: () => record.source.set(`${record.source.peek()}${record.source.peek() && !record.source.peek().endsWith('\n') ? '\n' : ''}get "${item.key}"`),
                                }))
                                : h('small', { class: 'stme-macro-empty' }, 'No fields on this tracker yet.'),
                        ),
                    )))),
            ),
        );
    }

    function macroGuide() {
        return Details('How to write a macro', h('small', {}, ' Syntax reference and examples'),
            h('div', { class: 'stme-macro-guide-body' },
                h('p', {}, 'A macro is either ', h('strong', {}, 'plain text'), ' (always resolves to the exact text you type) or a small ', h('strong', {}, 'code'), ' program in a tiny, purpose-built language — not real JavaScript, and it cannot reach outside this engine.'),
                h('table', { class: 'stme-macro-guide-table' },
                    h('tbody', {},
                        h('tr', {}, h('td', {}, h('code', {}, 'set x to 5')), h('td', {}, 'stores a value in a variable')),
                        h('tr', {}, h('td', {}, h('code', {}, 'if x > 5 then … else … end')), h('td', {}, 'branches on a condition')),
                        h('tr', {}, h('td', {}, h('code', {}, 'repeat 5 times … end')), h('td', {}, 'runs the block a fixed number of times')),
                        h('tr', {}, h('td', {}, h('code', {}, 'while x < 5 … end')), h('td', {}, 'runs while a condition holds')),
                        h('tr', {}, h('td', {}, h('code', {}, 'x is y')), h('td', {}, 'equality — works for numbers and text alike')),
                        h('tr', {}, h('td', {}, h('code', {}, 'x mod y')), h('td', {}, 'remainder of x divided by y')),
                        h('tr', {}, h('td', {}, h('code', {}, 'get "trackerId:fieldName"')), h('td', {}, "reads a tracked field's current value — use the picker under the code editor to insert a working key instead of typing one by hand")),
                        h('tr', {}, h('td', {}, h('code', {}, 'save x as "count"')), h('td', {}, "remembers a value for this macro's own next run")),
                        h('tr', {}, h('td', {}, h('code', {}, 'return x')), h('td', {}, 'the text this {{macro}} resolves to')),
                    ),
                ),
                h('p', {}, h('strong', {}, 'Example (plain text): '), h('code', {}, '"The old oak door"'), ' — that\'s the whole program.'),
                h('p', {}, h('strong', {}, 'Example (code): ')),
                h('pre', {}, 'set health to get "char:health"\nset shield to get "char:shield"\nreturn health + shield'),
                h('p', {}, 'A macro that fails or times out shows a visible ', h('code', {}, '[macro error: name]'), ' placeholder instead of silently vanishing from the prompt.'),
            ),
        );
    }

    function macroRow(record) {
        return Section(computed(() => record.name() || record.macroName() || 'New macro'), {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`macro:${record.key}`),
            subtitle: computed(() => `{{${sanitizeMacroName(record.macroName()) || '…'}}} · ${record.kind() === 'code' ? 'code' : 'text'}`),
            actions: [
                Toggle('Enabled', record.enabled),
                Button('Test run', () => testMacro(record)),
                Button('Remove', () => removeMacro(record), { variant: 'danger' }),
            ],
        },
            Row(
                Field('Macro name', TextInput(record.macroName, { placeholder: 'my_macro' }), { hint: 'Used as {{this}} — letters, digits, underscore.' }),
                Field('Name', TextInput(record.name, { placeholder: 'What is this for?' })),
                Field('Kind', Select(record.kind, MACRO_KINDS)),
            ),
            computed(() => (record.kind() === 'code'
                ? h('div', { class: 'stme-macro-code' },
                    TextArea(record.source, { rows: 6, placeholder: 'set x to get "char:health"\nreturn x' }),
                    insertPickerSection(record),
                )
                : TextArea(record.source, { rows: 3, placeholder: 'Fixed text this macro always resolves to.' }))),
            triggerSection(record),
            computed(() => {
                const result = record.testResult();
                if (!result) return null;
                return h('div', { class: result.ok ? 'stme-macro-status stme-macro-status-ok' : 'stme-macro-status stme-macro-status-error' },
                    result.ok ? `Result: ${result.value || '(empty)'}` : `Error: ${result.error}`);
            }),
        );
    }

    function macrosCard() {
        return Card('Macros', {
            ...collapse.bind('card:macros'),
            subtitle: 'Define your own {{macro}} — fixed text, or a small computed program',
        },
            macroGuide(),
            EditableList({
                items: macros,
                renderItem: macroRow,
                onAdd: addMacro,
                addLabel: '+ Add macro',
                empty: 'No macros yet. Add one to define your own {{macro}}.',
                actions: [Button('Save', saveMacros)],
            }),
        );
    }

    /**
     * Интерфейс лорбука («LB scanner», как у Alpha) — тоже часть экрана
     * движка, тем же доводом, что и Macros: чтение реального World Info ST —
     * интеграция уровня движка, не отключаемая фича.
     *
     * В отличие от Workers/Macros/Tracker (локальный черновик списка + ОДНА
     * общая кнопка Save), запись здесь идёт СРАЗУ в настоящий World Info ST:
     * каждое действие (Save строки, +Add, Remove, Publish) — отдельный вызов
     * контракта, а не батч. Так и должно быть — записи лорбука не наша
     * конфигурация, а чужое хранилище, за которым Ядро работы с WI следит
     * само (см. его doc-comment): правка через родной редактор ST так же
     * долетит сюда сама, без ручного Rescan.
     */
    function toLorebookRecord(summary) {
        return {
            key: `lorebook_${summary.book}_${summary.uid}`,
            uid: summary.uid,
            book: summary.book,
            length: summary.length,
            name: signal(summary.name),
            keys: signal(summary.keys.join(', ')),
            content: signal(''),
            disabled: signal(summary.disabled),
            constant: signal(summary.constant),
            order: signal(100),
            probability: signal(100),
            published: signal(false),
            // Полная запись (content и настоящие order/probability) грузится
            // ЛЕНИВО, при первом раскрытии строки — не для всех разом: у
            // лорбука записей может быть много, а content — тяжёлый текст,
            // которого нет даже в самом индексе (`lorebook.find()` его
            // сознательно не отдаёт, см. doc-comment summarizeEntry()).
            loaded: signal(false),
            flash: signal(''),
        };
    }

    async function loadLorebook() {
        const found = await call('lorebook.find');
        const list = (found.ok ? found.value ?? [] : []).map(toLorebookRecord);
        lorebookEntries.set(list);
        const booksResult = await call('lorebook.books');
        lorebookBooks.set(booksResult.ok ? booksResult.value ?? [] : []);
        for (const record of list) {
            call('lorebook.isPublished', { uid: record.uid, book: record.book })
                .then(result => { if (result.ok) record.published.set(result.value); });
        }
    }

    async function loadFullLorebookEntry(record) {
        if (record.loaded.peek()) return;
        const result = await call('lorebook.get', { uid: record.uid, book: record.book });
        if (result.ok && result.value) {
            record.content.set(String(result.value.content ?? ''));
            record.keys.set((result.value.key ?? []).join(', '));
            record.order.set(result.value.order ?? 100);
            record.probability.set(result.value.probability ?? 100);
        }
        record.loaded.set(true);
    }

    async function saveLorebookEntry(record) {
        const patch = {
            comment: record.name.peek().trim(),
            key: record.keys.peek().split(',').map(item => item.trim()).filter(Boolean),
            content: record.content.peek(),
            disable: record.disabled.peek(),
            constant: record.constant.peek(),
            order: record.order.peek(),
            probability: record.probability.peek(),
        };
        const result = await call('lorebook.updateEntry', { uid: record.uid, book: record.book, patch });
        flash(record.flash, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Saved "${patch.comment || record.uid}"` : result.error.message);
        // Перечитываем список целиком, а не только эту запись: имя могло
        // поменяться, и заголовок строки/индекс обязаны увидеть это тоже.
        if (result.ok) await loadLorebook();
    }

    async function addLorebookEntry() {
        const result = await call('lorebook.createEntry', { patch: { comment: 'New entry' } });
        if (!result.ok) { await notify('error', result.error.message); return; }
        await loadLorebook();
    }

    async function removeLorebookEntry(record) {
        const result = await call('lorebook.deleteEntry', { uid: record.uid, book: record.book });
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Deleted "${record.name.peek() || record.uid}"` : result.error.message);
        if (result.ok) await loadLorebook();
    }

    async function toggleLorebookPublish(record, checked) {
        record.published.set(checked);
        const result = await call(checked ? 'lorebook.publish' : 'lorebook.unpublish', { uid: record.uid, book: record.book });
        if (!result.ok) { record.published.set(!checked); await notify('error', result.error.message); }
    }

    function lorebookRow(record) {
        const bind = collapse.bind(`lorebook:${record.key}`);
        return Section(computed(() => record.name() || `#${record.uid}`), {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...bind,
            // Раскрытие строки — сигнал первого открытия: грузим полную
            // запись именно СЕЙЧАС, не раньше (см. doc-comment `loaded` в
            // toLorebookRecord()).
            onToggle: next => { bind.onToggle(next); if (next) loadFullLorebookEntry(record); },
            subtitle: `${record.book}${record.length ? ` · ${record.length} chars` : ''}`,
            actions: [
                Toggle('Publish', record.published, {
                    hint: 'Expose as a {{macro}}.',
                    onChange: checked => toggleLorebookPublish(record, checked),
                }),
                Button('Save', () => saveLorebookEntry(record)),
                Button('Remove', () => removeLorebookEntry(record), { variant: 'danger' }),
            ],
        },
            Row(
                Field('Name', TextInput(record.name, { placeholder: 'What is this entry for?' })),
                Field('Keys', TextInput(record.keys, { placeholder: 'comma, separated, keys' })),
            ),
            Row(
                Toggle('Disabled in WI', record.disabled, { hint: 'Matches ST\'s own "Disable" checkbox — a disabled entry never activates, published or not.' }),
                Toggle('Constant', record.constant, { hint: 'Always active, regardless of keys — matches ST\'s own "Constant" toggle.' }),
            ),
            Row(
                Field('Order', NumberInput(record.order, { min: 0 })),
                Field('Probability', NumberInput(record.probability, { min: 0, max: 100 })),
            ),
            Field('Content', TextArea(record.content, { rows: 4, placeholder: 'Entry content…' })),
        );
    }

    function lorebookCard() {
        return Card('Lorebook', {
            ...collapse.bind('card:lorebook'),
            subtitle: computed(() => (lorebookBooks().length ? `Active: ${lorebookBooks().join(', ')}` : 'No lorebook active for this chat/character yet')),
        },
            h('p', { class: 'stme-lorebook-help' }, 'Every entry in your currently active lorebook(s) — global, character, chat, and persona. Create, edit, and delete right here, or in ST\'s own World Info panel — both stay in sync automatically, no manual Rescan needed. Toggle Publish to expose an entry\'s full content as a real {{macro}}, usable in prompts, World Info, or any module — the same way Tracker/RP Time publish their own values.'),
            EditableList({
                items: lorebookEntries,
                renderItem: lorebookRow,
                onAdd: addLorebookEntry,
                addLabel: '+ Add entry',
                empty: 'No entries in the active lorebook(s) yet — add one here, or activate a book in ST\'s own World Info panel.',
                actions: [Button('Rescan', loadLorebook)],
            }),
        );
    }

    /**
     * Свёртка старой истории (BasicSummary, ROADMAP.md) — тоже часть ЭКРАНА
     * ДВИЖКА, не Модуль: как и у Macros/Lorebook, это не отключаемая фича, а
     * общий механизм управления контекстом. Панель — тонкая проводка к
     * контрактам [cores/summary/index.js](../summary/index.js):
     * `summary.list`/`update`/`delete` (записи), `summary.settings`/
     * `configure` (пороги/уровни), `summary.check` (ручной «Fold now» —
     * тот же контракт, что дёргает сам движок автоматически на
     * `generation.prepare`, так что кнопка честно показывает то же самое
     * поведение, а не отдельную имитацию).
     */
    function toSummaryRecord(record) {
        return {
            key: `summary_${record.id}`,
            id: record.id,
            level: record.level,
            startIndex: record.startIndex,
            endIndex: record.endIndex,
            text: signal(record.text),
            edited: record.edited,
            flash: signal(''),
        };
    }

    function toLevelRecord(level = {}) {
        return { key: `level_${++uid}`, batchSize: signal(level.batchSize ?? 5) };
    }

    async function loadSummaries() {
        const result = await call('summary.list');
        summaries.set((result.ok ? result.value ?? [] : []).map(toSummaryRecord));
    }

    /** Только счётчик — сам граф рисует и правит `cores/ui/memory-graph-panel.js`'s отдельное окно, эта карточка лишь открывает его. */
    async function loadMemoryGraphCount() {
        const result = await call('memoryGraph.nodes');
        if (result.ok) memoryGraphNodeCount.set(result.value.length);
    }

    async function loadMemoryGraphSettings() {
        const result = await call('memoryGraph.settings');
        if (result.ok) memoryGraphThresholdK.set(result.value.thresholdK);
    }

    async function saveMemoryGraphThresholdK() {
        const result = await call('memoryGraph.configure', { thresholdK: memoryGraphThresholdK.peek() });
        if (result.ok) memoryGraphThresholdK.set(result.value.thresholdK); // отражает реальный клэмп (0.1-10), не то, что могло быть введено вручную
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Saved sensitivity' : result.error.message);
    }

    async function loadSummarySettings() {
        const result = await call('summary.settings');
        if (!result.ok || !result.value) return;
        summaryLevels.set(result.value.levels.map(toLevelRecord));
        summaryProtectedWindow.set(result.value.protectedWindow);
        summaryWorkerId.set(result.value.workerId ?? '');
        summaryVerifyEnabled.set(Boolean(result.value.verifyEnabled));
        summaryVerifyWorkerId.set(result.value.verifyWorkerId ?? '');
    }

    function addSummaryLevel() {
        summaryLevels.set([...summaryLevels.peek(), toLevelRecord({ batchSize: 5 })]);
    }

    function removeSummaryLevel(record) {
        summaryLevels.set(summaryLevels.peek().filter(item => item !== record));
    }

    async function saveSummarySettings() {
        const levels = summaryLevels.peek().map(record => ({ batchSize: record.batchSize.peek() }));
        const result = await call('summary.configure', {
            levels, protectedWindow: summaryProtectedWindow.peek(), workerId: summaryWorkerId.peek().trim() || null,
            verifyEnabled: summaryVerifyEnabled.peek(), verifyWorkerId: summaryVerifyWorkerId.peek().trim() || null,
        });
        if (result.ok) {
            summaryLevels.set(result.value.levels.map(toLevelRecord));
            summaryProtectedWindow.set(result.value.protectedWindow);
        }
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Saved summary settings' : result.error.message);
    }

    /** Тот же контракт, что и автоматический прогон на `generation.prepare` — кнопка не имитирует поведение движка отдельным путём, а честно его вызывает. */
    async function forceSummaryFold() {
        const result = await call('summary.check');
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Now ${result.value.length} active summary/summaries` : result.error.message);
        if (result.ok) await loadSummaries();
    }

    async function saveSummaryText(record) {
        const result = await call('summary.update', { id: record.id, text: record.text.peek() });
        flash(record.flash, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Saved summary' : result.error.message);
    }

    async function removeSummaryRecord(record) {
        const result = await call('summary.delete', { id: record.id });
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Deleted summary' : result.error.message);
        if (result.ok) await loadSummaries();
    }

    function summaryRow(record) {
        return Section(`Level ${record.level} summary`, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`summary:${record.key}`),
            subtitle: `covers messages ${record.startIndex}–${record.endIndex}${record.edited ? ' · edited by hand' : ''}`,
            actions: [
                Button('Save', () => saveSummaryText(record)),
                Button('Remove', () => removeSummaryRecord(record), { variant: 'danger' }),
            ],
        },
            Field('Text', TextArea(record.text, { rows: 4, placeholder: 'Summary text…' })),
        );
    }

    function summaryLevelRow(record, index) {
        return Row(
            Field(`Level ${index + 1} batch size`, NumberInput(record.batchSize, { min: 2, max: 200 })),
            Button('Remove', () => removeSummaryLevel(record), { variant: 'danger' }),
        );
    }

    function summaryCard() {
        return Card('Chat Summary', {
            ...collapse.bind('card:summary'),
            subtitle: computed(() => `${summaries().length} active summar${summaries().length === 1 ? 'y' : 'ies'}`),
        },
            h('p', { class: 'stme-summary-help' },
                'Old chat history is folded into a pyramid of summaries — each level compresses several of the level below — so the model keeps the gist of the past without paying its full token cost. The newest messages always stay untouched, real text; the protected window below sets how many.'),
            Row(
                Field('Protected window', NumberInput(summaryProtectedWindow, { min: 1, max: 2000 }), { hint: 'How many of the newest messages never get folded.' }),
                // Тот же список, что «Model connection» у Tracker'а
                // (modules/tracker/index.js) — реальные подключения из
                // `workers` (Model connections card в этой же панели), а не
                // строка, куда id воркера пришлось бы переписывать руками и
                // легко было бы опечататься/забыть, что он вообще переименован.
                Field('Worker', Select(summaryWorkerId, computed(() => [
                    { value: '', label: 'Default (any connection)' },
                    ...workers().map(record => ({ value: record.id(), label: record.id() })),
                ]))),
            ),
            h('div', { class: 'stme-summary-levels' },
                computed(() => summaryLevels().map((record, index) => summaryLevelRow(record, index))),
            ),
            Row(
                Toggle('Verify level >1 summaries', summaryVerifyEnabled, {
                    hint: 'After folding a summary of summaries, ask the model to double-check it against the original content one level further down before accepting it — catches drift the higher up the pyramid you go. Roughly doubles model calls for those folds; runs in the background, never delays a reply.',
                }),
                Field('Verify worker', Select(summaryVerifyWorkerId, computed(() => [
                    { value: '', label: 'Same as fold worker' },
                    ...workers().map(record => ({ value: record.id(), label: record.id() })),
                ]))),
            ),
            Row(
                Button('+ Add level', addSummaryLevel),
                Button('Save settings', saveSummarySettings),
                Button('Fold now', forceSummaryFold),
            ),
            EditableList({
                items: summaries,
                renderItem: summaryRow,
                empty: 'No summaries yet — they appear automatically once enough old messages queue up beyond the protected window.',
            }),
        );
    }

    /**
     * Обновление. До этого оно жило ТОЛЬКО в консоли: ход запускался при
     * старте и молчал, что бы ни случилось, — а «молчит, когда сказать нечего»
     * незаметно превратилось в «молчит всегда», и отличить работающее
     * самообновление от сломанного было нечем. Здесь оно наконец видно и
     * запускается руками.
     */
    async function checkUpdates() {
        updateBusy.set(true);
        updateText.set('Checking…');
        updateTone.set('muted');
        // Синяя пульсация, ровно как у «Test» на воркере, пока идёт запрос.
        updateFlash.set('testing');
        // `force`: явное нажатие не должно молча упираться в паузу между
        // попытками — она существует против цикла «обновились → перезагрузка →
        // обновились», а не против пользователя.
        const result = await call('selfUpdate.run', { force: true });
        updateBusy.set(false);
        if (!result.ok) {
            updateTone.set('error'); updateText.set(result.error.message); flash(updateFlash, 'error');
            await notify('error', `Update check failed: ${result.error.message}`); return;
        }

        const { outcome, error, reason, diagnosis } = result.value ?? {};
        const mismatch = diagnosis?.applicable && !diagnosis.matches;
        if (outcome === 'updated') {
            updateTone.set('ok'); updateText.set('Updated — reloading SillyTavern…'); flash(updateFlash, 'ok');
            await notify('ok', 'Engine updated — reloading'); return;
        }
        if (outcome === 'failed') {
            updateTone.set('error'); updateText.set(error ?? 'Update failed.'); flash(updateFlash, 'error');
            await notify('error', `Update failed: ${error ?? 'unknown reason'}`); return;
        }
        if (outcome === 'unavailable') {
            updateTone.set('error');
            flash(updateFlash, 'error');
            // Самая частая причина — копия, положенная руками: git-эндпоинтов
            // у такой установки нет вовсе. Говорим это прямо, а не «ошибка», —
            // и ДОСЛОВНО показываем, чем ответила ST: без этого «не работает
            // обновление» невозможно отличить от «обновляться нечем».
            updateText.set(`SillyTavern cannot check this copy — it is not a git install, or its update endpoints refused. Update the folder by hand.${reason ? ` (${reason})` : ''}`);
            await notify('error', 'Update check unavailable for this install');
            return;
        }
        if (mismatch) {
            // Ровно тот случай, ради которого сверка с GitHub и существует.
            updateTone.set('error');
            flash(updateFlash, 'error');
            updateText.set(`SillyTavern says up to date at ${String(diagnosis.localSha).slice(0, 7)}, but GitHub's "${diagnosis.branch}" is at ${String(diagnosis.remoteSha).slice(0, 7)}. The local checkout is stuck behind origin.`);
            await notify('error', 'Local copy is behind GitHub despite SillyTavern saying otherwise');
            return;
        }
        updateTone.set('ok');
        flash(updateFlash, 'ok');
        updateText.set(diagnosis?.applicable
            ? `Up to date — commit ${String(diagnosis.localSha).slice(0, 7)} on "${diagnosis.branch}" matches GitHub.`
            : 'Up to date, as far as SillyTavern can tell (GitHub was not reachable for a direct check).');
        await notify('ok', 'Engine is up to date');
    }

    /**
     * Только вход в отдельное floating-окно (`cores/ui/memory-graph-panel.js`,
     * решено с пользователем: "полноценный UI... окно, а не узкая секция") —
     * счётчик узлов и кнопка, сам граф эта карточка не рисует вообще.
     */
    /** Ярлык фазы бутстрапа для текста над полосой прогресса — `phase` приходит с бэкенда (`cores/memory-graph/index.js`'s `tick()`), словами, не сырым техническим именем. */
    function memoryGraphProgressPhaseLabel(phase) {
        switch (phase) {
            case 'reading': return 'reading Lorebook';
            case 'skeleton': return 'laying out regions';
            case 'centers': return 'adding region centers';
            case 'placing': return 'placing entries';
            case 'linking': return 'linking regions';
            case 'connecting': return 'connecting isolated entries';
            case 'finalizing': return 'finalizing';
            default: return 'building';
        }
    }

    /** Полоса прогресса бутстрапа — видна только пока `memoryGraphProgress()` не null (решено с пользователем: "нет индикатора прогресса. Это очень плохо" → "добавь прогресс-бар"). Проценты — грубая оценка (see `bootstrapFromLorebook()`'s doc-comment), не точный расчёт, этого достаточно, чтобы полоска реально двигалась, а не стояла мёртвым нулём. */
    function memoryGraphProgressBar() {
        return computed(() => {
            const progress = memoryGraphProgress();
            if (!progress) return null;
            const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
            const phase = progress.detail ? `${memoryGraphProgressPhaseLabel(progress.phase)} — ${progress.detail}` : memoryGraphProgressPhaseLabel(progress.phase);
            return ProgressBar(percent, `Building memory graph — ${phase}… ${percent}%`);
        });
    }

    // --- Chat Viewport (план `chat-viewport`) — единственная реальная точка
    // включения. Раньше `chatViewport.attach()` вызывался ТОЛЬКО из
    // демо-кнопки харнесса — в настоящей панели движка не было НИЧЕГО, что
    // бы его включало, поэтому в реальном UI подавление `#chat` не могло
    // сработать в принципе (владелец поймал это конкретно: "чат не
    // подавляется" → "переключатель забыл внести в UI"). Живёт в экране
    // НАСТРОЕК (см. `settingsTree()` ниже), не в основной вкладке — тот же
    // раздел, что даёт доступ к "Engine"/"Preset"/"Updates".
    const chatViewportEnabled = signal(false);
    const chatViewportBusy = signal(false);
    // owner (уточнено ПОСЛЕ первой версии — та по умолчанию совпадала с
    // шириной #chat, то есть с настоящей ST-настройкой `chat_width`
    // (--sheldWidth, обычно 50vw), а НЕ со страницей): "Сделать ВО ВСЮ
    // ширину страницы [по умолчанию]. Отступ чисто небольшой дефолтно,
    // чтобы было читаемо. Далее — можно сузить до любой ширины, не меньше
    // ДЕФОЛТНОЙ для ST" — значит: по умолчанию оверлей должен занимать всю
    // СТРАНИЦУ (не #chat), с небольшим фиксированным отступом для
    // читаемости, а сужать можно вплоть до ПОЛОВИНЫ страницы (ST-дефолт
    // `chat_width: 50` из `power-user.js`) — не до текущей настройки
    // владельца (которая может отличаться), а именно до захардкоженного
    // ST-дефолта. `DEFAULT_SIDE_MARGIN`/`MIN_WIDTH_FRACTION` — см. ниже, у
    // `enableChatViewport()`, где это уже переводится в пиксели.
    // px, симметрично с обеих сторон (одна ручка сужает сразу оба края,
    // держа контент по центру; независимые отступы слева/справа —
    // усложнение, не запрошенное явно, не делаем, пока owner не попросит
    // именно это).
    const chatViewportSideMargin = signal(DEFAULT_SIDE_MARGIN);
    let chatViewportOverlay = null; // { wrapper, spacer, canvas, mirror, chrome, stopResize }

    /**
     * Позиция/размер оверлея — снимок `#chat` РОВНО ОДИН РАЗ, в момент
     * `enableChatViewport()`, пока `#chat` ещё виден. НЕ пересчитывается на
     * ресайз окна — сознательный откат от более "живой" первой версии,
     * которая перемеряла на каждый ресайз и оказалась вдвойне сломанной,
     * обе находки живьём, не догадки:
     * 1. `getBoundingClientRect()` элемента с `display:none` (чем и подавлен
     *    `#chat`) НАВСЕГДА возвращает нули — сам `#chat` перемерить после
     *    первого включения уже нечем.
     * 2. Родитель `#chat` — не заменяет его как источник геометрии: он даёт
     *    свой собственный размер (в харнессе — почти вся страница) и не
     *    знает, каким было смещение `#chat` ВНУТРИ себя. Взять размер/позицию
     *    родителя вместо `#chat` раздувало канвас на всю страницу и уводило
     *    его в угол, не туда, где на самом деле был чат.
     * Точная синхронизация с ресайзом окна возможна только в реальной
     * SillyTavern, где известна настоящая структура вокруг `#chat` — здесь
     * честно зафиксировано как "не решено на этом шаге", а не подделано.
     *
     * Что ВСЁ ЖЕ обновляется живьём — высота spacer'а (`totalHeight`), по
     * СОБЫТИЮ рендера (`ui.chatViewport.render.completed`), не по ресайзу:
     * chat растёт от новых сообщений, а не от изменения размера окна.
     */
    async function enableChatViewport() {
        if (!chatViewport || chatViewportOverlay) return;
        chatViewportBusy.set(true);
        try {
            const container = await callServiceOrThrow('stChat.container');
            if (!container) throw new Error('SillyTavern chat container (#chat) was not found.');
            const body = await callServiceOrThrow('dom.body');
            const rect = await callServiceOrThrow('dom.measureRect', { el: container });
            // Ширина СТРАНИЦЫ, не #chat — owner: "Сделать ВО ВСЮ ширину
            // страницы [по умолчанию]" (см. doc-comment у
            // `chatViewportSideMargin` выше). `#chat` сам по себе уже уже
            // страницы (у ST есть своя настройка `chat_width`, обычно 50vw,
            // `--sheldWidth` в `power-user.js`) — оверлей должен её
            // игнорировать и мерить именно `body`, а не `container`.
            // Вертикаль (`top`/`height`) остаётся от `#chat` — про высоту
            // владелец ничего не просил менять.
            const pageSize = await callServiceOrThrow('dom.clientSize', { el: body });

            const wrapper = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const spacer = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const stickyLayer = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const marginLayer = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const canvas = await callServiceOrThrow('dom.createElement', { tag: 'canvas' });
            const lastCanvas = await callServiceOrThrow('dom.createElement', { tag: 'canvas' });
            const mirror = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const chrome = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const leftHandle = await callServiceOrThrow('dom.createElement', { tag: 'div' });
            const rightHandle = await callServiceOrThrow('dom.createElement', { tag: 'div' });

            await callServiceOrThrow('dom.setProp', { el: wrapper, key: 'class', value: 'stme-chat-viewport-overlay' });
            await callServiceOrThrow('dom.setProp', { el: spacer, key: 'class', value: 'stme-chat-viewport-spacer' });
            await callServiceOrThrow('dom.setProp', { el: mirror, key: 'class', value: 'stme-chat-viewport-mirror-host' });
            await callServiceOrThrow('dom.setProp', { el: chrome, key: 'class', value: 'stme-chat-viewport-chrome-host' });
            await callServiceOrThrow('dom.setProp', { el: leftHandle, key: 'class', value: 'stme-chat-viewport-resize-handle' });
            await callServiceOrThrow('dom.setProp', { el: rightHandle, key: 'class', value: 'stme-chat-viewport-resize-handle' });
            // ОДИН `position:sticky` слой несёт И канвас, И хром — НАЙДЕНО
            // ЖИВЬЁМ: раньше у каждого был СВОЙ `position:sticky`, и это
            // работало, пока `mirror` был обычным элементом в потоке (его
            // большая высота — сотни/тысячи px — "проталкивала" `chrome`
            // достаточно далеко в потоке, что sticky-порог `chrome` был уже
            // пройден почти при любом скролле, чисто случайно). Как только
            // `mirror` стал `position:absolute` (фикс раздувания scrollHeight),
            // `chrome` лишился этой "проталкивающей" высоты — его собственная
            // позиция в потоке стала равна ВСЕГО ЛИШЬ высоте канваса (не
            // тысячам px), и sticky `chrome` переставал липнуть к верху, пока
            // прокрутка не пройдёт эту небольшую дистанцию — визуально хром и
            // тело двигались с разным порогом прилипания ("едут на разных
            // уровнях"). Два независимых sticky-элемента с разной историей
            // потока — риск разъехаться всегда; один общий sticky-контейнер с
            // канвасом и хромом ВНУТРИ (`position:absolute` у обоих,
            // относительно этого контейнера) устраняет саму возможность —
            // им уже нечему считать раздельно.
            await callServiceOrThrow('dom.setProp', { el: stickyLayer, key: 'style', value: { position: 'sticky', top: '0px', left: '0px', height: '0px', overflow: 'visible' } });
            // `marginLayer` — единственный держатель горизонтального сдвига
            // при заужении (см. doc-comment у `chatViewportSideMargin` и у
            // "Заужение с боков" ниже): `position:absolute` ВНУТРИ
            // `stickyLayer`, задаёт СВОЙ `left` как реальный оффсет (а не
            // порог прилипания, которым он был бы у `position:sticky`).
            // `canvas`/`chrome` — снова `left:0px`, но теперь уже относительно
            // `marginLayer`, а не `stickyLayer` напрямую. Важно и для фона
            // глифов (`ensureGlyphBg()` в `chat-viewport.js`): тот берёт свой
            // родитель через `canvas.parentElement`, то есть теперь тоже
            // `marginLayer` — фон автоматически сдвигается СИНХРОННО с
            // канвасом и хромом, без единой правки в самом `chat-viewport.js`
            // (который ничего не знает про "margin", это забота панели).
            await callServiceOrThrow('dom.setProp', { el: marginLayer, key: 'style', value: { position: 'absolute', top: '0px', left: '0px', height: '0px', overflow: 'visible', willChange: 'transform' } });
            await callServiceOrThrow('dom.setProp', { el: canvas, key: 'style', value: { position: 'absolute', top: '0px', left: '0px', display: 'block' } });
            await callServiceOrThrow('dom.setProp', { el: chrome, key: 'style', value: { position: 'absolute', top: '0px', left: '0px', height: '0px', overflow: 'visible' } });
            // Ручки-хваталки для заужения — owner: "нужно ТЯНУТЬ физически.
            // Не ползунком где-то там" (settings-панель убрана вовсе, см.
            // `chatViewportCard()`). Сиблинги `marginLayer`, НЕ внутри него —
            // их `left` считается в тех же координатах, что и сам
            // `marginLayer`/`canvas` (relative к `stickyLayer`), поэтому
            // левая ручка встаёт РОВНО на левый край канваса (`left: margin`),
            // а правая — на правый (`left: margin + width`); если бы их
            // вложили ВНУТРЬ `marginLayer`, `left` удвоился бы с его
            // собственным сдвигом. `height: 100vh` — упрощение: ручке не
            // обязательно точно совпадать с высотой канваса (она и не
            // скроллится вместе с контентом за счёт sticky-родителя), просто
            // должна перекрывать видимую область для захвата мышью.
            await callServiceOrThrow('dom.setProp', { el: leftHandle, key: 'style', value: { position: 'absolute', top: '0px', height: '100vh' } });
            await callServiceOrThrow('dom.setProp', { el: rightHandle, key: 'style', value: { position: 'absolute', top: '0px', height: '100vh' } });

            // Порядок важен: `position:sticky` держится "прилипшим" к верху
            // скролл-контейнера, только если это первое, что встречает
            // прокрутка — найдено живьём: spacer ПЕРЕД канвасом сдвигал сам
            // канвас на высоту spacer'а вниз (canvas не прилипал сразу, а
            // просто стоял ниже своей естественной позиции в потоке), и всё
            // тело сообщения рисовалось за пределами видимой области.
            await callServiceOrThrow('dom.setProp', { el: lastCanvas, key: 'style', value: { position: 'absolute', top: '0px', left: '0px', display: 'none', pointerEvents: 'none', willChange: 'transform' } });
            await callServiceOrThrow('dom.append', { parent: marginLayer, child: canvas });
            await callServiceOrThrow('dom.append', { parent: marginLayer, child: lastCanvas });
            await callServiceOrThrow('dom.append', { parent: marginLayer, child: chrome });
            await callServiceOrThrow('dom.append', { parent: stickyLayer, child: marginLayer });
            await callServiceOrThrow('dom.append', { parent: stickyLayer, child: leftHandle });
            await callServiceOrThrow('dom.append', { parent: stickyLayer, child: rightHandle });
            await callServiceOrThrow('dom.append', { parent: wrapper, child: stickyLayer });
            await callServiceOrThrow('dom.append', { parent: wrapper, child: mirror });
            await callServiceOrThrow('dom.append', { parent: wrapper, child: spacer });
            await callServiceOrThrow('dom.append', { parent: body, child: wrapper });
            // `zIndex: 31` — НАЙДЕНО ЖИВЬЁМ в реальной ST: `#sheld` (сам центр
            // чата, наш родной сосед по `document.body`) держит `z-index: 30`
            // в `style.css` — при `zIndex: 5` наш оверлей визуально был ПОД
            // ним (виден "из-под", canvas просвечивал), но `#sheld` при этом
            // ПЕРЕХВАТЫВАЛ все события мыши/колеса в этой области — скролл
            // колесом и клики по нашим кнопкам физически не доходили до
            // оверлея (`elementFromPoint` над оверлеем возвращал `#sheld`, не
            // наш `wrapper`). 31 — минимально достаточно, ЧУТЬ выше `#sheld`
            // и его локальных соседей (тоже 30), но далеко НИЖЕ настоящих
            // попапов/тостов ST (2000+/9999+), чтобы диалоги персонажа и
            // прочие модалки по-прежнему рисовались поверх нашего оверлея.
            // `scrollbarGutter: 'stable'` — НАЙДЕНО ЖИВЬЁМ: без него `wrapper`
            // резервирует место под СВОЙ вертикальный скроллбар только когда
            // контент УЖЕ достаточно высокий, чтобы реально прокручиваться —
            // а `spacer` (единственное, что даёт эту высоту) получает
            // настоящее значение только ПОСЛЕ `attach()`+первого `render()`.
            // Значит `wrapper.clientWidth`, измеренный ДО `attach()` (см.
            // ниже — нужен, чтобы передать ПРАВИЛЬНУЮ ширину В `attach()`),
            // на этом шаге ещё врёт — скроллбара физически нет, `clientWidth`
            // равен полной внешней ширине. `scrollbar-gutter: stable`
            // резервирует место под скроллбар ВСЕГДА, вне зависимости от
            // того, нужен ли он прямо сейчас — `clientWidth` становится
            // стабильным и правильным с самого начала, без гонки с
            // `render()`.
            await callServiceOrThrow('dom.setProp', {
                el: wrapper, key: 'style',
                value: { position: 'fixed', top: `${rect.top}px`, left: '0px', width: `${pageSize.width}px`, height: `${rect.height}px`, overflowY: 'auto', scrollbarGutter: 'stable', zIndex: 31, contain: 'layout style' },
            });

            // `css` для тела сообщения — НАЙДЕНО ЖИВЬЁМ в реальной ST: `attach()`
            // никогда не получал его здесь вовсе (только харнесс подставлял
            // свой захардкоженный демо-цвет — `harness/main.js`'s `cvAttach`),
            // поэтому `buildForeignObjectSvg` растеризовал текст БЕЗ единого
            // правила стиля — браузер по умолчанию рисует текст ЧЁРНЫМ, что на
            // тёмной теме ST визуально неотличимо от фона. `foreignObject`
            // — отдельный `data:`-документ, он НЕ наследует переменные темы
            // страницы (см. doc-comment `services/html-rasterizer.js`), поэтому
            // реальные цвета темы читаются здесь (`dom.readCssVariable`, тот же
            // контракт, что уже использует Спикер-Цвета) и вшиваются как
            // конкретные значения, а не как `var(--...)`.
            // Шрифт/межстрочный интервал — ЗАФИКСИРОВАНЫ числом, не прочитаны
            // динамически. НАЙДЕНО ЖИВЬЁМ (дважды): (1) попытка читать
            // `font-size`/`line-height` живьём с `mirror` через
            // `getComputedStyle` ломалась, потому что читалась она здесь —
            // ДО того, как в зеркало вообще положили текст первого сообщения
            // (`mirror` в этот момент пустой). Пустой блочный элемент с
            // `line-height: normal` отдаёт `getComputedStyle` буквально
            // строку `"normal"`, не число в px — computed "normal" зависит от
            // МЕТРИК ШРИФТА, а без реального текста браузеру не из чего их
            // вывести. (2) Даже прочитанное число не помогло бы: растровая
            // текстура рисуется в ИЗОЛИРОВАННОМ `data:`-документе
            // (`foreignObject`), куда веб-шрифты страницы (`@font-face`) не
            // переезжают сами по себе — заведомо другой шрифт, другие
            // метрики, другое число для того же самого `line-height: normal`.
            // Единственный по-настоящему надёжный способ — не измерять и не
            // угадывать, а ЗАДАТЬ одно и то же число явно с ОБЕИХ сторон:
            // здесь (растровая текстура) и на `.stme-chat-viewport-mirror`
            // в `panel.css` (зеркало, которым измеряется высота строки) —
            // значения ниже ДОЛЖНЫ совпадать с той CSS-декларацией.
            // `font-family` — ЧИТАЕТСЯ с `mirror`, В ОТЛИЧИЕ от font-size/
            // line-height выше (не подвержена их багу): computed `font-
            // family` — простая строка, не зависящая от наличия реального
            // текста в элементе (в отличие от `line-height: normal`, которому
            // для вычисления числа нужны настоящие метрики глифов) —
            // безопасно читать даже с ещё пустого зеркала. НАЙДЕНО ЖИВЬЁМ:
            // захардкоженный `system-ui, sans-serif` — обычный системный
            // шрифт ОС, визуально заметно отличается от настоящего шрифта
            // темы ST (`--mainFontFamily`, часто кастомный webfont) —
            // сообщения выглядели "не в стиле" остального интерфейса.
            // `.stme-chat-viewport-mirror` в `panel.css` НЕ переопределяет
            // `font-family` сама — наследует его от страницы естественно,
            // тем же каскадом, что и настоящий `.mes_text`, так что
            // прочитанное здесь значение — ровно то, что уже использовалось
            // при измерении высоты строки.
            const [bodyColor, quoteColor, emColor, fontFamily] = await Promise.all([
                callServiceOrThrow('dom.readCssVariable', { name: '--SmartThemeBodyColor' }),
                callServiceOrThrow('dom.readCssVariable', { name: '--SmartThemeQuoteColor' }),
                callServiceOrThrow('dom.readCssVariable', { name: '--SmartThemeEmColor' }),
                callServiceOrThrow('dom.readCssVariable', { name: 'font-family', el: mirror }),
            ]);
            // `margin: 0` на всём внутри — НАЙДЕНО ЖИВЬЁМ: зеркало измеряет
            // высоту через `getBoundingClientRect()`, который НЕ включает
            // внешние отступы элемента — margin у `<p>` там (`margin-bottom:
            // 16px` от настоящего CSS ST) физически не влияет на измеренную
            // высоту. Но в ИЗОЛИРОВАННОМ SVG-документе (`foreignObject`) у
            // `<p>` без явного сброса действует БРАУЗЕРНЫЙ дефолтный margin
            // (обычно `1em` сверху и снизу — здесь это ~15px) — а эта верхняя
            // граница СЪЕДАЕТ место у зафиксированной высоты бокса (21px у
            // однострочного сообщения — почти всё), прежде чем текст вообще
            // начнёт рисоваться: короткие однострочные сообщения обрезались
            // почти целиком. Реальные отступы ST внутри нашей текстуры не
            // нужны — тело сообщения и так позиционируется извне (через
            // измеренную высоту), поэтому `margin: 0` внутри безопасно и
            // устраняет саму возможность такого расхождения.
            const css = `.stme-chat-viewport-body { color: ${bodyColor || '#dcdcd2'}; `
                + `font-size: 15px; line-height: 1.4; font-family: ${fontFamily || 'system-ui, sans-serif'}; } `
                + `.stme-chat-viewport-body * { margin: 0; padding: 0; } `
                + `.stme-chat-viewport-body q { color: ${quoteColor || '#e18a24'}; } `
                + `.stme-chat-viewport-body em, .stme-chat-viewport-body i { color: ${emColor || '#919191'}; } `
                // Как в родном style.css ST: курсив ВНУТРИ цитаты наследует цвет цитаты, цвет
                // `<font color>` не перебивается, а автокавычки `<q>` убраны (кавычки уже в тексте).
                + `.stme-chat-viewport-body q em, .stme-chat-viewport-body q i, `
                + `.stme-chat-viewport-body font[color] em, .stme-chat-viewport-body font[color] i, .stme-chat-viewport-body font[color] q { color: inherit; } `
                + `.stme-chat-viewport-body q:before, .stme-chat-viewport-body q:after { content: ''; }`;

            // `wrapper.clientWidth/Height`, НЕ `rect.width/height` — НАЙДЕНО
            // ЖИВЬЁМ: `rect` — внешний border-box `#chat` (`getBoundingClientRect()`),
            // тот же размер, что мы тут же ставим `wrapper`'у как CSS
            // `width`/`height`. Но `wrapper` САМ получает `overflow-y: auto`
            // выше — а по спецификации CSS, если задан только один из
            // `overflow-x`/`overflow-y` НЕ-`visible`, второй молча
            // вычисляется как `auto` тоже. Значит у `wrapper` есть СВОЙ
            // скроллбар (вертикальный, реально показывается — контент высокий),
            // который отъедает несколько px от содержимого — а канвас
            // рисовался на всю ВНЕШНЮЮ ширину `rect.width`, чуть ШИРЕ
            // содержимого `wrapper`, и получал горизонтальный скролл
            // ("чат уже канваса, надо мотать вбок"). `clientWidth/Height`
            // измеряется ПОСЛЕ того, как `overflow-y:auto` уже применён —
            // это и есть настоящая, уже уменьшенная под свой скроллбар
            // область содержимого.
            const clientSize = await callServiceOrThrow('dom.clientSize', { el: wrapper });
            // Заужение с боков — owner: "Отступ чисто небольшой дефолтно...
            // Далее можно сузить до любой ширины, не меньше ДЕФОЛТНОЙ для
            // ST" (см. doc-comment у `chatViewportSideMargin` и у
            // `marginLayer` выше). Ширина канваса уменьшается на `margin` с
            // ОБЕИХ сторон, а `marginLayer` сдвигается вправо на `margin`.
            // `maxMargin` — предел, дальше которого утянуть ручкой нельзя:
            // результирующая ширина не должна упасть ниже
            // `MIN_WIDTH_FRACTION` (0.5 — ST-дефолт `chat_width: 50`) от
            // ширины СТРАНИЦЫ (`clientSize.width`, уже посчитанной выше как
            // раз от полной страницы, не от `#chat`).
            // Ширина страницы меняется на лету (окно браузера, всплывающая панель Chrome, боковая панель) — она сигнал, а не константа.
            const pageWidth = signal(clientSize.width);
            const maxMarginNow = () => Math.max(0, pageWidth.peek() * (1 - MIN_WIDTH_FRACTION) / 2);
            const maxMargin = maxMarginNow();
            const initialMargin = Math.min(chatViewportSideMargin(), maxMargin);
            const effectiveWidth = Math.max(1, clientSize.width - initialMargin * 2);
            const ok = await chatViewport.attach({ canvas, lastCanvas, mirrorContainer: mirror, chromeContainer: chrome, width: effectiveWidth, height: clientSize.height, css });
            // Слой держит окно предрендера (канвас выше и ниже экрана): `overflow: clip`
            // + `overflow-clip-margin` — содержимое за краем видно (для подкатки при
            // скролле), но НЕ растягивает scrollHeight обёртки. Отрицательный marginBottom гасит собственную
            // высоту слоя в потоке — иначе под последним сообщением появлялся лишний экран пустоты.
            await callServiceOrThrow('dom.setProp', { el: stickyLayer, key: 'style', value: { height: `${clientSize.height}px`, marginBottom: `${-clientSize.height}px`, overflow: 'clip', overflowClipMargin: `${chatViewport.canvasPad()}px` } });
            if (!ok) {
                await callServiceOrThrow('dom.remove', { node: wrapper });
                await notify('error', 'Chat Viewport: this browser has no WebGL — staying on the native chat.');
                chatViewportEnabled.set(false);
                return;
            }

            // Нативное `scroll`-событие способно стрелять НАМНОГО чаще одного
            // раза за кадр (трекпад/точный скролл — сотни раз в секунду) —
            // НАЙДЕНО ЖИВЬЁМ: каждый вызов уходил прямиком в `render()`, а тот
            // читает `stChat.messages` С НУЛЯ (`readOrderedMessages()` внутри
            // `cores/ui/chat-viewport.js`) — `map()`/`filter()` по ВСЕЙ истории
            // чата (тысячи сообщений на реальном длинном чате), не только по
            // видимому окну. На каждое такое сырое событие — это и была
            // просадка плавности скролла, отдельная от более раннего фикса
            // `display:none`/layout. Схлопываем до максимум одного вызова за
            // кадр браузера (`requestAnimationFrame`) — тот же приём, что для
            // любого scroll-driven рендера, а не что-то специфичное для этого
            // Ядра; `scrollTop` берём АКТУАЛЬНЫЙ на момент кадра, а не тот, что
            // был на момент последнего сырого события — не теряет позицию,
            // просто не перерисовывает чаще, чем браузер способен показать.
            let scrollRafId = null;
            // Между нативным скроллом и следующим закоммиченным кадром слой
            // сдвигается на разницу scrollTop синхронно — движение выглядит как
            // обычный скролл, а не рывки по кадрам.
            const syncScrollOffset = () => {
                const delta = wrapper.scrollTop - chatViewport.renderedScrollTop();
                callService('dom.setProp', { el: marginLayer, key: 'style', value: { transform: delta ? `translateY(${-delta}px)` : '' } });
            };
            const onScroll = () => {
                syncScrollOffset();
                if (scrollRafId !== null) return;
                scrollRafId = requestAnimationFrame(() => {
                    scrollRafId = null;
                    chatViewport.setViewport({ scrollTop: wrapper.scrollTop });
                });
            };
            await callServiceOrThrow('dom.setProp', { el: wrapper, key: 'on:scroll', value: onScroll });

            // Spacer растёт вместе с чатом (новое сообщение, правка, свайп) —
            // по СОБЫТИЮ рендера, не по ресайзу окна (см. doc-comment выше).
            //
            // Автопрокрутка вниз — owner: "Текст не мотается вниз при
            // стриминге (ризонинга тоже, появления новых глифов тоже)".
            // `lastTotalHeight` — высота spacer'а ДО ЭТОГО обновления (значит
            // и старая `scrollHeight` обёртки, раз spacer — единственное, что
            // её растягивает); нужна, чтобы решить "был ли пользователь
            // прижат к низу" ДО того, как контент вырос — `wasAtBottom`
            // проверяется по СТАРОЙ высоте, `scrollTop` берётся ТЕКУЩИЙ.
            // Порог (`BOTTOM_THRESHOLD`) — то же "почти у низа" тоже считается
            // прижатым, иначе суб-пиксельные несовпадения округления никогда
            // не давали бы `true`. Если пользователь САМ прокрутил вверх
            // читать историю — не трогаем его позицию, дочитывает спокойно
            // (тот же принцип, что у любого чата с автопрокруткой).
            //
            // `nextTotalHeight > lastTotalHeight` — НАЙДЕНО ЖИВЬЁМ: owner
            // "если скроллить наверх медленно — панель просто дёргается
            // вместо того, чтобы уезжать". Причина — `render.completed`
            // стреляет НЕ ТОЛЬКО когда чат реально вырос, а на КАЖДЫЙ
            // `render()`, включая тот, что вызывает САМ `onScroll` выше
            // (`setViewport({scrollTop})` → `render()`). Без этого условия
            // любой шаг скролла ВВЕРХ короче `BOTTOM_THRESHOLD` (частый
            // случай при медленном скролле мелкими шагами) сам себя
            // проверял по СТАРОЙ `lastTotalHeight`, видел «всё ещё близко к
            // низу» и тут же принудительно возвращал `scrollTop` обратно —
            // рывок вместо ухода. Автопрокрутка нужна ТОЛЬКО когда контент
            // реально вырос (новый токен/сообщение), не на любой рендер.
            const BOTTOM_THRESHOLD = 48;
            let lastTotalHeight = chatViewport.totalHeight();
            const stopSpacerSync = host.events.subscribe('ui.chatViewport.render.completed', async payload => {
                syncScrollOffset();
                const nextTotalHeight = payload?.totalHeight ?? chatViewport.totalHeight();
                const grew = nextTotalHeight > lastTotalHeight;
                const scrollPos = await callService('dom.scrollPosition', { el: wrapper });
                const clientSize = await callService('dom.clientSize', { el: wrapper });
                const wasAtBottom = grew && !payload?.userToggle && scrollPos.ok && clientSize.ok
                    && (scrollPos.value.top + clientSize.value.height >= lastTotalHeight - BOTTOM_THRESHOLD);
                lastTotalHeight = nextTotalHeight;
                await callService('dom.setProp', { el: spacer, key: 'style', value: { height: `${nextTotalHeight}px` } });
                if (wasAtBottom && clientSize.ok) {
                    await callService('dom.setScrollPosition', { el: wrapper, top: Math.max(0, nextTotalHeight - clientSize.value.height) });
                }
            });

            // Живое обновление ширины/сдвига при перетаскивании слайдера —
            // БЕЗ полного disable/re-enable цикла. `effect()` сам вызывается
            // немедленно при создании (см. doc-comment `reactive.js`), поэтому
            // первый прогон здесь просто дублирует уже применённые выше
            // `effectiveWidth`/`left` — безвредно, идемпотентно.
            const stopSideMarginSync = effect(() => {
                const page = pageWidth();
                const margin = Math.max(0, Math.min(chatViewportSideMargin(), Math.max(0, page * (1 - MIN_WIDTH_FRACTION) / 2)));
                const width = Math.max(1, page - margin * 2);
                chatViewport.setViewport({ viewportWidth: width });
                callService('dom.setProp', { el: marginLayer, key: 'style', value: { left: `${margin}px` } });
                callService('dom.setProp', { el: leftHandle, key: 'style', value: { left: `${margin}px` } });
                callService('dom.setProp', { el: rightHandle, key: 'style', value: { left: `${margin + width}px` } });
            });

            // Перетаскивание ручек мышью/тачем — owner: "нужно ТЯНУТЬ
            // физически. Не ползунком где-то там". `pointermove`/`pointerup`
            // вешаются на `window` НАПРЯМУЮ (не через `dom.setProp`/Сервис —
            // тот же приём, что уже есть у `onScroll` выше через `rAF`
            // напрямую): у Сервисов нет контракта "подписаться на window", а
            // городить его ради одного эфемерного drag-жеста — накладные
            // расходы без пользы; сам drag живёт и умирает целиком внутри
            // одного вызова `enableChatViewport()`. Ручка ДВИГАЕТ margin в
            // СВОЮ сторону: левая тянется вправо (внутрь) — margin растёт;
            // правая тянется влево (тоже внутрь) — margin тоже растёт, оттого
            // разный знак `dx` у обеих.
            let stopDrag = null;
            const startDrag = (handleSign) => startEvent => {
                startEvent.preventDefault();
                const startClientX = startEvent.clientX;
                const startMargin = Math.max(0, Math.min(chatViewportSideMargin(), maxMarginNow()));
                const onMove = moveEvent => {
                    const dx = (moveEvent.clientX - startClientX) * handleSign;
                    chatViewportSideMargin.set(Math.max(0, Math.min(startMargin + dx, maxMarginNow())));
                };
                const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    stopDrag = null;
                    saveChatViewportState();
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
                stopDrag = onUp;
            };
            await callServiceOrThrow('dom.setProp', { el: leftHandle, key: 'on:pointerdown', value: startDrag(1) });
            await callServiceOrThrow('dom.setProp', { el: rightHandle, key: 'on:pointerdown', value: startDrag(-1) });

            // Правила ST `:has(... [style*="..."])` пересчитывают стили сотен элементов на любое изменение style —
            // пока Chat Viewport включён, они убраны (возвращаются при выключении).
            await callService('dom.suppressStyleRules', { key: 'chat-viewport', selectorPattern: String.raw`:has\([^)]*\[style\*=` });
            // ST держит весь документ одним слоем хаком на `<html>` — из-за него любое изменение перерисовывает страницу целиком.
            await callService('dom.overrideRootStyles', { key: 'chat-viewport', styles: { transform: 'none', 'backface-visibility': 'visible', perspective: 'none' } });
            // Геометрия оверлея следует за страницей: нижняя граница — верх панели ввода ST (`#form_sheld`), ширина — ширина `body`.
            // Раньше высота/ширина фиксировались один раз при включении: когда текст в поле ввода растёт на несколько строк, панель
            // поднимается (родной `#chat` скрыт и оттеснить её не может), а когда Chrome показывает и убирает свою панель или
            // окно меняет размер, канвас и чат оставались прежнего размера.
            let stopHeightSync = () => {};
            const formSheld = await callService('dom.querySelector', { el: body, selector: '#form_sheld' });
            let currentHeight = clientSize.height;
            let lastBodyWidth = pageSize.width;
            let syncing = false;
            let syncAgain = false;
            const syncGeometry = async () => {
                if (syncing) { syncAgain = true; return; }
                syncing = true;
                try {
                    do {
                        syncAgain = false;
                        const bodySize = await callService('dom.clientSize', { el: body });
                        if (bodySize.ok && bodySize.value.width > 0 && bodySize.value.width !== lastBodyWidth) {
                            lastBodyWidth = bodySize.value.width;
                            await callService('dom.setProp', { el: wrapper, key: 'style', value: { width: `${bodySize.value.width}px` } });
                            const wrapperSize = await callService('dom.clientSize', { el: wrapper });
                            if (wrapperSize.ok && wrapperSize.value.width > 0) pageWidth.set(wrapperSize.value.width);
                        }
                        if (formSheld.ok && formSheld.value) {
                            const formRect = await callService('dom.measureRect', { el: formSheld.value });
                            const nextHeight = formRect.ok ? Math.max(120, Math.round(formRect.value.top - rect.top)) : currentHeight;
                            if (nextHeight !== currentHeight) {
                                const scrollPos = await callService('dom.scrollPosition', { el: wrapper });
                                const previousHeight = currentHeight;
                                const wasAtBottom = scrollPos.ok && (scrollPos.value.top + previousHeight >= lastTotalHeight - BOTTOM_THRESHOLD);
                                currentHeight = nextHeight;
                                await callService('dom.setProp', { el: wrapper, key: 'style', value: { height: `${nextHeight}px` } });
                                await callService('dom.setProp', { el: stickyLayer, key: 'style', value: { height: `${nextHeight}px`, marginBottom: `${-nextHeight}px` } });
                                if (wasAtBottom && scrollPos.ok) {
                                    // Чат прижат к низу — сохраняем это: содержимое едет вверх вместе с поднявшейся панелью.
                                    await callService('dom.setScrollPosition', { el: wrapper, top: Math.max(0, scrollPos.value.top + (previousHeight - nextHeight)) });
                                }
                                chatViewport.setViewport({ viewportHeight: nextHeight, scrollTop: wrapper.scrollTop });
                            }
                        }
                    } while (syncAgain);
                } finally {
                    syncing = false;
                }
            };
            let resizeFrame = null;
            const onWindowResize = () => {
                if (resizeFrame !== null) return;
                resizeFrame = requestAnimationFrame(() => { resizeFrame = null; syncGeometry(); });
            };
            window.addEventListener('resize', onWindowResize);
            await callService('dom.observeResize', { el: body, handler: syncGeometry });
            if (formSheld.ok && formSheld.value) await callService('dom.observeResize', { el: formSheld.value, handler: syncGeometry });
            stopHeightSync = () => {
                window.removeEventListener('resize', onWindowResize);
                callService('dom.unobserveResize', { el: body, handler: syncGeometry });
                if (formSheld.ok && formSheld.value) callService('dom.unobserveResize', { el: formSheld.value, handler: syncGeometry });
            };
            syncGeometry();
            chatViewportOverlay = {
                wrapper, spacer, canvas, mirror, chrome, stopSpacerSync, stopSideMarginSync, stopHeightSync,
                stopDrag: () => stopDrag?.(),
            };
            await callServiceOrThrow('dom.setProp', { el: spacer, key: 'style', value: { height: `${chatViewport.totalHeight()}px` } });
        } catch (error) {
            chatViewportEnabled.set(false);
            await notify('error', `Chat Viewport failed to start: ${error.message}`);
        } finally {
            chatViewportBusy.set(false);
        }
    }

    async function disableChatViewport() {
        if (!chatViewport || !chatViewportOverlay) return;
        chatViewportBusy.set(true);
        try {
            chatViewportOverlay.stopSpacerSync();
            chatViewportOverlay.stopSideMarginSync();
            chatViewportOverlay.stopHeightSync?.();
            chatViewportOverlay.stopDrag();
            await chatViewport.detach();
            await callService('dom.remove', { node: chatViewportOverlay.wrapper });
            await callService('dom.restoreStyleRules', { key: 'chat-viewport' });
            await callService('dom.restoreRootStyles', { key: 'chat-viewport' });
        } finally {
            chatViewportOverlay = null;
            chatViewportBusy.set(false);
        }
    }

    function chatViewportCard() {
        return Card('Chat Viewport (experimental)', { ...collapse.bind('card:chatViewport') },
            h('p', { class: 'stme-summary-help' }, 'Renders the chat history through our own WebGL-backed viewport instead of SillyTavern\'s native chat. Off by default — this is early and only approximates real SillyTavern layout (see ROADMAP).'),
            Toggle('Enabled', chatViewportEnabled, {
                onChange: async value => { await (value ? enableChatViewport() : disableChatViewport()); await saveChatViewportState(); },
                hint: computed(() => (chatViewportBusy() ? 'Starting…' : '')),
            }),
            // Ползунок ширины нарочно НЕ здесь — owner: "нужно ТЯНУТЬ
            // физически. Не ползунком где-то там". Заужение — ручки по краям
            // самого канваса в чате (см. `leftHandle`/`rightHandle` в
            // `enableChatViewport()`), а не отдельный контрол в настройках.
        );
    }

    function memoryGraphCard() {
        return Card('Memory Graph', {
            ...collapse.bind('card:memoryGraph'),
            subtitle: computed(() => `${memoryGraphNodeCount()} node${memoryGraphNodeCount() === 1 ? '' : 's'}`),
            className: computed(() => (memoryGraphFlash() ? `stme-flash stme-flash-${memoryGraphFlash()}` : '')),
        },
            h('p', { class: 'stme-summary-help' }, 'Long-term memory as a mind-map — facts as nodes, typed edges between them, retrieved by relevance instead of recency.'),
            memoryGraphProgressBar(),
            Row(
                Field('Sensitivity (thresholdK)', NumberInput(memoryGraphThresholdK, { min: 0.1, max: 10, step: 0.1 }), {
                    hint: 'How many standard deviations a message must stand out by before it is even considered for a new memory. LOWER catches more (more SideCar calls, more nodes); HIGHER catches less.',
                }),
                Button('Save', saveMemoryGraphThresholdK),
            ),
            Row(Button('Open Graph Editor', () => openMemoryGraphPanel?.())),
        );
    }

    async function refreshBackgrounds() {
        const result = await request(host.own, 'backgrounds.status', { params: {} });
        if (!result.ok) return;
        backgroundsStatus.set(result.value);
        backgroundsAuto.set(result.value.enabled);
        backgroundsRemoveDeleted.set(result.value.removeDeleted);
    }

    async function syncBackgroundsNow() {
        if (backgroundsBusy.peek()) return;
        backgroundsBusy.set(true);
        try {
            await request(host.own, 'backgrounds.sync', { params: { force: true } });
        } finally {
            backgroundsBusy.set(false);
            await refreshBackgrounds();
        }
    }

    const backgroundsSummary = computed(() => {
        const status = backgroundsStatus();
        if (!status) return 'Backgrounds status is not available yet.';
        const last = status.lastOutcome;
        if (backgroundsBusy() || status.running) return 'Syncing…';
        if (!last) return `${status.installedCount} installed. Not synced yet in this session.`;
        if (last.outcome === 'synced') return `${status.installedCount} installed — last sync: +${last.installed} / -${last.removed}${last.failed ? `, ${last.failed} failed` : ''}${last.skipped ? `, ${last.skipped} skipped` : ''}.`;
        if (last.outcome === 'unchanged') return `${status.installedCount} installed — the repository has not changed.`;
        if (last.outcome === 'empty') return 'The backgrounds repository is empty — add an image or video to it and it will appear here.';
        if (last.outcome === 'disabled') return 'Auto-install is off.';
        return `${status.installedCount} installed — last sync did not run (${last.error ?? last.outcome}).`;
    });

    function backgroundsCard() {
        return Card('Backgrounds', {
            ...collapse.bind('card:backgrounds'),
            subtitle: computed(() => (backgroundsStatus() ? `${backgroundsStatus().repository.owner}/${backgroundsStatus().repository.repo}` : 'from a GitHub repository')),
        },
            h('p', { class: 'stme-summary-help' }, 'Any image or video added to the backgrounds repository appears in the SillyTavern background list on the next start, named "stme-<folder>-<file>". Files you delete by hand are not brought back unless they change in the repository.'),
            h('p', { class: 'stme-update-status' }, backgroundsSummary),
            Toggle('Install automatically at startup', backgroundsAuto, { onChange: value => { request(host.own, 'backgrounds.setSettings', { params: { enabled: value } }); } }),
            Toggle('Remove backgrounds deleted from the repository', backgroundsRemoveDeleted, { onChange: value => { request(host.own, 'backgrounds.setSettings', { params: { removeDeleted: value } }); } }),
            Row(computed(() => Button(backgroundsBusy() ? 'Syncing…' : 'Sync now', syncBackgroundsNow))),
        );
    }

    function updatesCard() {
        return Card('Updates', {
            ...collapse.bind('card:updates'),
            subtitle: 'Where this engine comes from, and whether it is current',
            className: computed(() => (updateFlash() ? `stme-flash stme-flash-${updateFlash()}` : '')),
        },
            Row(
                computed(() => Badge(repository().owner && repository().repo ? `${repository().owner}/${repository().repo}` : 'repository unknown', { tone: 'muted' })),
                computed(() => Badge(repository().extensionName ? `folder: ${repository().extensionName}` : 'folder unknown', { tone: repository().extensionName ? 'muted' : 'error' })),
            ),
            h('p', { class: computed(() => `stme-update-status stme-update-${updateTone()}`) }, updateText),
            Row(computed(() => Button(updateBusy() ? 'Checking…' : 'Check for updates', checkUpdates))),
        );
    }

    function statusCard() {
        return Card('Engine', { ...collapse.bind('card:engine'), subtitle: 'What is actually wired right now' },
            Row(
                computed(() => Badge(`${contracts().length} contracts`, { tone: 'muted' })),
                computed(() => Badge(`generation: ${generationStage()}`, { tone: generationStage() === 'idle' ? 'muted' : 'ok' })),
                computed(() => Badge(`${eventCount()} events seen`, { tone: 'muted' })),
            ),
            h('div', { class: 'stme-contract-list' },
                computed(() => contracts().map(entry => h('code', { key: entry.contract, class: 'stme-contract' }, entry.contract))),
            ),
        );
    }

    /**
     * Пресет — один файл со ВСЕЙ настройкой движка. Экспортируется ТОЛЬКО
     * источник `settings` (extensionSettings — настройки всех Ядер и
     * Модулей, включая `core.runner.enabledModules`, то есть состав
     * Модулей): chat-scoped данные (граф памяти, саммари, аннотации —
     * источник `chatMemory`) в пресете не нужны и могут весить десятки
     * мегабайт. Никакой своей сборки здесь нет: набор источников решает
     * сборщик движка (engine-wiring.js), панель лишь называет нужные.
     *
     * Импорт: файл пользователь выбирает САМ (виджет `h('input type=file')`
     * со своим `on:change` — vnode нельзя «нажать» за него, см. тот же
     * приём в Модуле Music) → `file.readText` (Сервис, а не FileReader
     * напрямую) → JSON.parse → `backup.import` → перезагрузка страницы.
     *
     * Почему перезагрузка, а не «перечитать в живые Ядра»: конфигурацию
     * Ядра подняли из storage один раз при старте движка
     * (`restoreWorkers()`/`load()`/...), повторный прогон этих путей
     * небезопасен — `summaryCore.load()`, например, повторно регистрирует
     * этапы пайплайна и подписки. Перезагрузка — тот же паттерн, что у
     * самообновления: движок при старте восстанавливает всё из записанного
     * пресетом состояния сам, каждый Ядро — своим собственным путём.
     */
    async function exportPreset() {
        const result = await call('backup.export', { sourceIds: ['settings'] });
        if (!result.ok) { flash(presetFlash, 'error'); await notify('error', result.error.message); return; }
        const stamp = new Date().toISOString().slice(0, 10);
        const saved = await callService('file.download', { filename: `stme-preset-${stamp}.json`, content: JSON.stringify(result.value, null, 2) });
        flash(presetFlash, saved.ok ? 'ok' : 'error');
        await notify(saved.ok ? 'ok' : 'error',
            saved.ok ? 'Preset downloaded — all settings and the module set in one file.' : saved.error.message);
    }

    async function importPreset(file) {
        if (!file) return;
        presetBusy.set(true);
        try {
            const read = await callService('file.readText', { file });
            if (!read.ok) { flash(presetFlash, 'error'); await notify('error', read.error.message); return; }
            let snapshot;
            try { snapshot = JSON.parse(read.value); }
            catch (error) { flash(presetFlash, 'error'); await notify('error', `Not a valid preset file: ${error.message}`); return; }
            const imported = await call('backup.import', { snapshot });
            if (!imported.ok) { flash(presetFlash, 'error'); await notify('error', imported.error.message); return; }
            flash(presetFlash, 'ok');
            const sources = imported.value.join(', ') || 'none';
            await notify('ok', `Preset imported (sources: ${sources}) — reloading the page to apply it.`);
            // Дать тосту дожить: страница уйдёт раньше, чем его увидят,
            // если перезагрузить в тот же тик.
            setTimeout(() => { window.location.reload(); }, 600);
        } finally {
            presetBusy.set(false);
        }
    }

    function presetCard() {
        /**
         * file-input НЕ рисуется как системная плитка «Choose file»: на части
         * поверхностей встроенная кнопка выбора файла не отрисовывается вовсе
         * (пользователь видел «просто текст»). Виджет у нас — `Button()`, а
         * инпут нужен только как носитель диалога выбора: держим его
         * СКРЫТЫМ рядом с кнопкой и кликаем программно из её обработчика —
         * легально, потому что вызов идёт из пользовательского клика.
         * Пара «кнопка + инпут» — СОСЕДИ под общим `<div>`: обработчик
         * кнопки находит инпут запросом по этому div'у. Дерево — vnode'ы,
         * слушатели ставит Сервис DOM на настоящие узлы, поэтому
         * `querySelector` в обработчике честно находит живой инпут.
         */
        const fileInput = h('input', {
            type: 'file', accept: 'application/json,.json', class: 'stme-preset-file-hidden',
            'on:change': event => {
                const input = event.target;
                importPreset(input.files?.[0]);
                input.value = '';
            },
        });
        const pickFile = h('div', {
            class: 'stme-preset-pick',
            // Слушатель на ОБЁРТКЕ, а не на кнопке: клик по кнопке всплывает
            // сюда, и инпут — ПРЯМОЙ ребёнок этой обёртки, его поиск не
            // зависит ни от `closest`/`parent` (у настоящих DOM-узлов нет
            // `.parent` — ровно на этом первый вариант и сломался в реальном
            // ST, хотя в фейковом документе тестов работал), ни от глубины.
            'on:click': event => {
                const wrapper = event.currentTarget;
                for (const child of wrapper.children ?? []) {
                    if (child.tagName === 'INPUT' && child.type === 'file') { child.click(); return; }
                }
            },
        },
            Button('Import preset file…'),
            fileInput,
        );
        return Card('Preset', {
            ...collapse.bind('card:preset'),
            subtitle: 'All settings + the module set, in one file',
            className: computed(() => (presetFlash() ? `stme-flash stme-flash-${presetFlash()}` : '')),
        },
            h('p', { class: 'stme-summary-help' }, 'Export downloads everything the engine remembers globally — all settings and which modules are enabled. Import restores it and reloads the page. Chat-scoped data (memory graph, summaries, per-chat notes) is not part of a preset.'),
            Row(
                Button('Export preset file', exportPreset),
                pickFile,
            ),
        );
    }

    /**
     * Правая половина — то, что подключает пользователь. Панель НЕ рисует
     * содержимое Модуля сама: у каждого включённого Модуля своё независимое
     * дерево и свой Final UI (см. Ядро UI модулей), а здесь только его
     * карточка-переключатель и пустое место под него. Иначе панель знала бы
     * про внутренности каждого Модуля — ровно то, чего вся эта конструкция и
     * избегает.
     */
    function moduleCard(entry) {
        const enabled = enabledSignal(entry.id);
        return Section(entry.title, {
            key: entry.id,
            ...collapse.bind(`module:${entry.id}`),
            subtitle: entry.description,
            // Тумблер, а не пара кнопок «Enable»/«Disable»: включённость это
            // СОСТОЯНИЕ, и переключатель показывает его сам, не заставляя
            // читать надпись на кнопке и догадываться, что она означает —
            // текущее положение или то, что случится по нажатию. Так же в Alpha.
            actions: [Toggle('Enabled', enabled, { onChange: value => toggleModule(entry, value) })],
        },
            // Место под собственное дерево Модуля. Его Final UI монтируется
            // сюда тем, кто собирал движок — панель только выделяет слот.
            computed(() => (enabled()
                ? h('div', { class: 'stme-module-slot', 'data-module': entry.id })
                : h('small', { class: 'stme-module-off' }, 'Disabled — the engine keeps running without it.'))),
        );
    }

    /**
     * Модули с `folder` группируются в карточку-папку: сама папка НЕ
     * Модуль — у неё нет тумблера и живого экземпляра, она только
     * собирает карточки своих Модулей визуально (каждый включается
     * СВОИМ тумблером, как раньше). Без папки — обычная карточка.
     * Порядок: папки в порядке первого появления их Модулей в реестре,
     * внутри папки — порядок реестра.
     */
    function groupedModuleEntries() {
        const entries = modules();
        const folders = [];
        const byFolder = new Map();
        const loose = [];
        for (const entry of entries) {
            if (entry.folder) {
                if (!byFolder.has(entry.folder)) {
                    byFolder.set(entry.folder, []);
                    folders.push(entry.folder);
                }
                byFolder.get(entry.folder).push(entry);
            } else {
                loose.push(entry);
            }
        }
        return [...loose.map(entry => ({ kind: 'module', entry })), ...folders.map(name => ({ kind: 'folder', name, entries: byFolder.get(name) }))];
    }

    // Список Модулей раскрыт по умолчанию: это единственное место, где
    // пользователь что-то подключает, и прятать его за лишним кликом незачем.
    function modulesCard() {
        return Card('Modules', { ...collapse.bind('card:modules', { open: true }), subtitle: 'What you plug in yourself' },
            computed(() => {
                if (!modules().length) return [EmptyState('No modules installed. The engine runs without them — that is exactly what makes something a Module rather than a Core.')];
                return groupedModuleEntries().map(group => (group.kind === 'folder'
                    ? Section(group.name, { key: `folder:${group.name}`, subtitle: 'Tools the AI operates itself — each one enabled separately.' }, group.entries.map(moduleCard))
                    : moduleCard(group.entry)));
            }),
        );
    }

    function tree() {
        return h('div', { class: 'stme-panel' },
            TwoColumn({
                // memoryGraphCard(), presetCard() и updatesCard() здесь БОЛЬШЕ
                // НЕТ (решено с пользователем: граф — «уже есть в боковой
                // панели, убери из основной»; пресеты и апдейты — «перенеси
                // в экран настроек»). Граф живёт своим плавающим окном, вход —
                // кнопка в доке-пилюле; пресеты и апдейты — на ОТДЕЛЬНОМ экране
                // настроек (settingsTree() ниже, вход — шестерёнка в доке).
                // Сигналы и подписки watch() остались здесь же НАРОЧНО: оба
                // дерева — дети одного Ядра, и переезд не разорвал ни одну
                // цепочку событий.
                left: [modelsCard(), macrosCard(), lorebookCard(), summaryCard()],
                right: [modulesCard()],
            }),
        );
    }

    /**
     * Второе дерево Ядра — ЭКРАН НАСТРОЕК (решено с пользователем: «перенеси
     * в экран настроек раздел пресетов и апдейтов из основного меню»).
     * Живёт в том же Ядре, что и основная панель, намеренно: presetCard() и
     * updatesCard() держатся за общие сигналы (repository, presetFlash,
     * updateFlash…) и общие `collapse`-памятки — выносить их в отдельное Ядро
     * значило бы дублировать состояние. Монтируется СВОИМ ключом
     * (`settingsScreen`), поэтому деревья не сталкиваются в реестре
     * монтирований — тот же приём, что у `hud()` модулей.
     */
    function settingsTree() {
        return h('div', { class: 'stme-panel' },
            // statusCard() («Engine») тоже переехал сюда (решено с
            // пользователем: «перенеси вкладку с названием Engine туда же»):
            // список контрактов и показание генерации — служебные сведения о
            // машине, им место рядом с пресетами и апдейтами, а не в основном
            // экране работы.
            statusCard(),
            chatViewportCard(),
            presetCard(),
            updatesCard(),
            backgroundsCard(),
        );
    }

    /** Живые показатели: панель не опрашивает движок по таймеру — она реагирует на те же события, что и всё остальное. */
    function watch() {
        return [
            host.events.subscribe('events.any', () => {
                eventCount.set(eventCount.peek() + 1);
            }),
            host.events.subscribe('generation.beforeSend', () => generationStage.set('running')),
            host.events.subscribe('generation.completed', () => generationStage.set('idle')),
            // Трекер добавили/убрали/переименовали ГДЕ-ТО ЕЩЁ (Модуль
            // «Трекер», «RP Time») — пикер под редактором кода обязан узнать
            // об этом сам, без перезагрузки страницы (тот же баг класса, что
            // уже ловили с list подключений — см. ROADMAP.md 5.23).
            host.events.subscribe('tracking.trackersChanged', () => loadTrackerFields()),
            // Ядро работы с WI пересканировало САМО (правка в родном
            // редакторе ST, смена глобального выбора книг, смена чата — см.
            // его doc-comment) — список здесь обязан узнать об этом без
            // ручного нажатия Rescan в этой карточке.
            host.events.subscribe('lorebook.scanned', () => loadLorebook()),
            // Свёртка происходит САМА на каждой генерации (`generation.prepare`
            // держит порог) — панель узнаёт о новых/пропавших саммари тем же
            // событием, без ручного Rescan. Тост здесь — для АВТОМАТИЧЕСКОЙ
            // свёртки: пользователь должен видеть, что часть истории только что
            // свернулась (ручная «Fold now» тостится сама в forceSummaryFold()).
            host.events.subscribe('summary.folded', payload => {
                loadSummaries();
                notify('ok', `Summary folded — ${payload?.count ?? '?'} active now`);
            }),
            // Зашли в другой чат — Ядро саммари перечитало свой список
            // (`summary.reloaded`), панель обязана показать саммари УЖЕ ТЕКУЩЕГО
            // чата сразу, без ручного нажатия Fold (тот же класс бага, что
            // уже ловили у лорбука выше).
            host.events.subscribe('summary.reloaded', () => loadSummaries()),
            ...[
                'memoryGraph.nodeCreated', 'memoryGraph.nodeDeleted', 'memoryGraph.nodeEvicted',
                'memoryGraph.nodesMerged', 'memoryGraph.nodesReconsolidated', 'memoryGraph.bootstrapped',
            ].map(event => host.events.subscribe(event, () => loadMemoryGraphCount())),
            // Бутстрап-прогресс — отдельная тройка событий (`started`
            // подтверждает, что реальная работа НАЧАЛАСЬ — `bootstrapMax
            // Tokens`-размера Lorebook может идти десятки секунд; `progress`
            // тикает по ходу; `finished` гасит пульсацию БЕЗУСЛОВНО — и на
            // успехе, и на любом раннем отказе, иначе индикатор завис бы
            // навсегда при пустом Проходе 1/2).
            host.events.subscribe('memoryGraph.bootstrapStarted', payload => {
                memoryGraphFlash.set('testing');
                memoryGraphProgress.set({ done: 0, total: Math.max(1, payload?.totalSteps ?? 1), phase: 'reading' });
            }),
            host.events.subscribe('memoryGraph.bootstrapProgress', payload => {
                memoryGraphProgress.set({ done: payload?.done ?? 0, total: Math.max(1, payload?.total ?? 1), phase: payload?.phase ?? '', detail: payload?.detail ?? null });
            }),
            host.events.subscribe('memoryGraph.bootstrapFinished', payload => {
                memoryGraphProgress.set(null);
                flash(memoryGraphFlash, payload?.success ? 'ok' : 'error');
            }),
            // Тот же автоматический фолд может и упасть (провайдер ответил,
            // но `chatHistory.hide` или следующий батж каскада — нет) — в
            // отличие от ручного «Fold now» (`forceSummaryFold()` ниже,
            // который сам получает `result.error.message`), у автоматического
            // пути нет своего вызывающего, который увидел бы отказ: сообщение
            // просто не сворачивалось молча. Без этого тоста пользователь не
            // видел вообще НИЧЕГО — ни успеха, ни ошибки.
            host.events.subscribe('summary.foldFailed', payload => notify('error', `Summary fold failed: ${payload?.message ?? 'unknown error'}`)),
        ];
    }

    /** Включён ли Chat Viewport и ширина заужения — переживают перезагрузку страницы. */
    function saveChatViewportState() {
        return request(host.own, 'storage.settings.set', {
            params: { namespace: 'core.ui.panel', key: 'chatViewport', value: { enabled: chatViewportEnabled.peek(), sideMargin: chatViewportSideMargin.peek() } },
        });
    }

    async function restoreChatViewportState() {
        const result = await request(host.own, 'storage.settings.get', { params: { namespace: 'core.ui.panel', key: 'chatViewport', fallback: {} } });
        const saved = (result.ok ? result.value : null) ?? {};
        if (Number.isFinite(saved.sideMargin)) chatViewportSideMargin.set(saved.sideMargin);
        if (saved.enabled) {
            chatViewportEnabled.set(true);
            // ST к этому моменту может ещё не дорисовать чат — включаем с небольшой задержкой.
            setTimeout(() => { enableChatViewport(); }, 1500);
        }
    }

    async function open() {
        // Сначала память о свёрнутом — иначе первый кадр раскрылся бы по
        // умолчанию, а потом схлопнулся, и это было бы видно.
        await collapse.restore();
        await restoreChatViewportState();
        await loadWorkers();
        await loadMacros();
        await loadTrackerFields();
        await loadLorebook();
        await loadSummarySettings();
        await loadSummaries();
        await loadMemoryGraphCount();
        await loadMemoryGraphSettings();
        await refreshBackgrounds();
        // Список контрактов приходит от сборщика движка: своя шина доступна
        // через host.own, а шины сервисов и сети — нет (у Ядра туда только
        // Гейт-аксессор, и это правильно). Так что «что вообще подключено»
        // знает тот, кто движок собирал.
        contracts.set(listContracts ? listContracts() : host.own.contracts?.() ?? []);
        const repo = await call('selfUpdate.repository');
        if (repo.ok) repository.set({ owner: '', repo: '', extensionName: '', ...repo.value });
        modules.set(moduleRegistry?.list() ?? []);
        syncEnabled(moduleRegistry?.enabled() ?? []);
        const ui = await mount(tree());
        // Второе дерево — экран настроек — монтируется СВОИМ ключом рядом
        // (см. settingsTree()): корень забирает index.js в body своего
        // full-screen оверлея. Один `open()` поднимает ОБА дерева — данные у
        // них общие, раздельный монтаж порождал бы два чтения конфигурации.
        // `mountSettings` опционален: тесты/упрощённые хосты поднимают только
        // основную панель, экран настроек тогда просто не существует.
        settingsUi = mountSettings ? await mountSettings(settingsTree()) : null;
        return ui;
    }

    const subscriptions = watch();
    // Корень второго дерева (экран настроек) — забирает index.js. null, пока
    // open() не отработал или хост не дал mountSettings.
    let settingsUi = null;

    return {
        open,
        refresh: loadWorkers,
        refreshModules: () => { modules.set(moduleRegistry?.list() ?? []); syncEnabled(moduleRegistry?.enabled() ?? []); },
        /** Корень дерева экрана настроек — null, если экран не поднимался. */
        settingsRoot: () => settingsUi?.getRoot() ?? null,
        settingsSettled: () => settingsUi?.settled() ?? Promise.resolve(),
        close: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
