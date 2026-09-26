import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, TextInput, TextArea, Select, Toggle, Slider, Chip, Details, Field, Row, Card, Section, EditableList } from '../../../libraries/shared/widgets.js';
import { TRIGGER_MODES, computeTriggers, resolveTriggerMode } from '../../../libraries/core/trigger-modes.js';
import { nextUid } from './uid.js';

const MACRO_KINDS = Object.freeze([
    { value: 'text', label: 'Plain text' },
    { value: 'code', label: 'Code' },
]);

let uid = 0;

/** JS-identifier-safe macro name — same spirit as Tracker's field-name sanitizing (no whitespace, bounded length). Applied on save, not on every keystroke, so the user can type freely and see it settle. */
export function sanitizeMacroName(value) {
    return String(value ?? '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 60);
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
        key: `macro_${nextUid()}`,
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

/** Карточка «Macros»: свои `{{макросы}}` (текст или небольшая программа) через контракты Ядра macros. */
export function createMacrosCard(deps) {
    const { call, macros, trackerFields, notify, flash, collapse } = deps;

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

    return { loadMacros, loadTrackerFields, macrosCard };
}
