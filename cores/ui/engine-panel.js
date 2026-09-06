import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import {
    Button, TextInput, TextArea, Select, Toggle, Slider, Chip, Details,
    Field, Row, Card, Section, Badge, EmptyState, TwoColumn, EditableList,
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
export function createEnginePanelCore(host, { mount, listContracts, modules: moduleRegistry } = {}) {
    // Что свёрнуто — помнится между сеансами. По умолчанию свёрнуто всё.
    const collapse = createCollapseState(host.own, { namespace: 'core.ui.panel' });
    const workers = signal([]);
    const macros = signal([]);
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
    const updateText = signal('Not checked yet.');
    const updateTone = signal('muted');
    const updateBusy = signal(false);
    // Та же вспышка обводки, что и у проверки подключения («Test»): синяя
    // пульсация пока идёт запрос, зелёная/красная — на исход. Раньше об
    // исходе проверки версии движка говорил только текст статуса, и его
    // легко было не заметить рядом с остальной панелью.
    const updateFlash = signal('');
    const eventCount = signal(0);

    async function call(contract, params) {
        return request(host.own, contract, { params });
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

    // Список Модулей раскрыт по умолчанию: это единственное место, где
    // пользователь что-то подключает, и прятать его за лишним кликом незачем.
    function modulesCard() {
        return Card('Modules', { ...collapse.bind('card:modules', { open: true }), subtitle: 'What you plug in yourself' },
            computed(() => (modules().length
                ? modules().map(moduleCard)
                : [EmptyState('No modules installed. The engine runs without them — that is exactly what makes something a Module rather than a Core.')])),
        );
    }

    function tree() {
        return h('div', { class: 'stme-panel' },
            TwoColumn({
                left: [statusCard(), modelsCard(), macrosCard(), updatesCard()],
                right: [modulesCard()],
            }),
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
        ];
    }

    async function open() {
        // Сначала память о свёрнутом — иначе первый кадр раскрылся бы по
        // умолчанию, а потом схлопнулся, и это было бы видно.
        await collapse.restore();
        await loadWorkers();
        await loadMacros();
        await loadTrackerFields();
        // Список контрактов приходит от сборщика движка: своя шина доступна
        // через host.own, а шины сервисов и сети — нет (у Ядра туда только
        // Гейт-аксессор, и это правильно). Так что «что вообще подключено»
        // знает тот, кто движок собирал.
        contracts.set(listContracts ? listContracts() : host.own.contracts?.() ?? []);
        const repo = await call('selfUpdate.repository');
        if (repo.ok) repository.set({ owner: '', repo: '', extensionName: '', ...repo.value });
        modules.set(moduleRegistry?.list() ?? []);
        syncEnabled(moduleRegistry?.enabled() ?? []);
        return mount(tree());
    }

    const subscriptions = watch();

    return {
        open,
        refresh: loadWorkers,
        refreshModules: () => { modules.set(moduleRegistry?.list() ?? []); syncEnabled(moduleRegistry?.enabled() ?? []); },
        close: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
