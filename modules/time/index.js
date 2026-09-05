import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { fillTemplate } from '../../libraries/core/fill-template.js';
import { Button, TextInput, Select, Toggle, Chip, Field, Row, EditableList, StatBlock } from '../../libraries/shared/widgets.js';

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
const TIMELINE_KEY = 'timeline';
/** Сколько прошлых отметок показывать модели. Одной мало (нет темпа), десяток — уже шум и лишние токены. */
const MAX_TIMELINE = 5;

/**
 * Промпт специализирован под ШАГ времени. Главное в нём — запрет выдумывать
 * абсолютную дату: модели показывают, куда время двигалось, и просят продлить
 * ту же линию, а не начать новую.
 */
export const TIME_PROMPT =
    'You are an in-world time tracker for a roleplay chat. Track only the fields below, ' +
    'using each note to decide how to format it:\n{fields}\n\n' +
    'Recent known in-world time, oldest to most recent: {timeline}. This shows the actual pace time ' +
    'has been moving at — extrapolate from it, don\'t invent a different pace.\n\n' +
    'ROLEPLAY CONTEXT:\n{context}\n\n' +
    'The roleplay text above is scene context only, not a log of elapsed time still to be counted — ' +
    'everything up through the second-to-last message is already reflected in the timeline. Estimate ' +
    'the time step using ONLY the newest exchange (the character\'s latest reply, at the end of the ' +
    'context): how long would plausibly pass for that one exchange to happen?\n\n' +
    'Default to a SMALL step (seconds to a few minutes) unless the newest exchange explicitly signals ' +
    'a skip (e.g. "the next morning", "hours later", "after the long walk") or a scene transition.\n\n' +
    'The character just responded (see the end of the context above). Return ONLY a JSON object with ' +
    'exactly these keys: {fieldsJson}. No markdown, no explanation.';

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
    const label = signal('');
    const history = signal([]);
    const busy = signal(false);

    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    // --- Шкала: память чата, а не настройки ---------------------------------

    async function loadHistory() {
        const result = await call('storage.chatMemory.get', { namespace: MEMORY_NAMESPACE, key: TIMELINE_KEY, fallback: [] });
        history.set(result.ok ? result.value ?? [] : []);
    }

    async function rememberLabel(next) {
        if (!next || history.peek().at(-1) === next) return;
        const kept = [...history.peek(), next].slice(-MAX_TIMELINE);
        history.set(kept);
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: TIMELINE_KEY, value: kept });
    }

    // --- Настройка трекера в Ядре -------------------------------------------

    function trackerConfig() {
        return {
            id: TRACKER_ID,
            kind: 'user',
            enabled: enabled.peek(),
            workerId: workerId.peek(),
            fields: fields.peek().map(field => ({ name: field.name, prompt: field.prompt ?? '' })),
            promptTemplate: TIME_PROMPT,
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
                value: { preset: preset.peek(), startTime: startTime.peek(), displayTemplate: displayTemplate.peek(), fields: fields.peek(), workerId: workerId.peek(), enabled: enabled.peek() },
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
            await rememberLabel(next);
            return next;
        } finally {
            busy.set(false);
        }
    }

    async function reset() {
        history.set([]);
        label.set('');
        await call('storage.chatMemory.set', { namespace: MEMORY_NAMESPACE, key: TIMELINE_KEY, value: [] });
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
    function footerWidget() {
        // Здесь — ПОСЛЕДНЯЯ ИЗВЕСТНАЯ отметка, а не `label`. Разница
        // принципиальная: `label` намеренно гаснет на время опроса (карточка в
        // панели должна пульсировать, а не врать старым временем), а бейдж под
        // сообщением — запись в летописи. Ядро подвала замораживает его, как
        // только приходит следующее сообщение, и заморозить пустоту значило бы
        // навсегда оставить под сообщением пульсирующий прочерк.
        return StatBlock('Current RP time', () => history().at(-1) ?? '', { icon: '◷' });
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
        // Другой чат — другое время. Шкалу перечитываем, а не тащим с собой.
        host.events.subscribe('st.chatChanged', () => { loadHistory().then(() => label.set(history.peek().at(-1) ?? '')); }),
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
        }
        const workerList = await call('model.workers.get');
        workers.set((workerList.ok ? workerList.value ?? [] : []).map(worker => ({ value: worker.id, label: worker.id })));

        await loadHistory();
        label.set(history.peek().at(-1) ?? '');
        // Трекер заводится в Ядре сразу: он должен существовать ещё до первого
        // опроса, иначе первый же ответ упёрся бы в «неизвестный трекер».
        const listed = await call('tracking.trackers');
        const others = (listed.ok ? listed.value ?? [] : []).filter(tracker => tracker.id !== TRACKER_ID);
        await call('tracking.configure', { trackers: [...others, trackerConfig()] });
        await call('ui.messageFooter.claim', { slot: 'left', ownerId: MODULE_ID, node: footerWidget() });
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
        label,
        history,
        fields,
        startTime,
        displayTemplate,
        enabled,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            call('ui.messageFooter.release', { ownerId: MODULE_ID });
        },
    };
}
