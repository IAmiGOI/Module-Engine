import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { fillTemplate } from '../../libraries/core/fill-template.js';
import { createCollapseState } from '../../libraries/shared/collapse-state.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import {
    Button, TextInput, TextArea, Slider, Select, Toggle, Chip, Details,
    Field, Row, Section, EditableList, FloatingPanel,
} from '../../libraries/shared/widgets.js';
import { GenerationSettingsPanel } from '../../libraries/shared/generation-settings-panel.js';
import {
    SAMPLER_PRESETS, clampSamplerSettings, clampReasoningSettings, buildCustomPreset,
} from '../../cores/models/internal-engine.js';

/**
 * Модуль «Трекер» — ПЕРВЫЙ настоящий Модуль в Beta, и он же проверка
 * критерия из ARCHITECTURE.md на живом примере: движок работает без него, а
 * подключает его пользователь. Значит Модуль, а не Ядро.
 *
 * Это ПЕРЕПИСАННЫЙ интерфейс Alpha'вского Tracker'а (modules/tracker/index.js,
 * 1151 строка), и главное отличие — в том, чего здесь НЕТ:
 *
 *  - **Нет своего состояния трекинга.** Значения, опрос модели, разбор ответа
 *    и публикация живут в [Ядре трекинга](../../cores/tracking/index.js).
 *    Модуль их только показывает и правит — через контракты, а не по
 *    JS-ссылке: править, к какой модели и по какому событию обращается
 *    трекер, в обход Гейта было бы ровно тем случаем, ради которого Гейты и
 *    существуют.
 *  - **Нет ни одного таймера и ни одного счётчика ходов.** У Alpha на это
 *    были `pollMode`/`pollTurns`/`pollIntervalMinutes`, свой `setInterval` и
 *    ручной подсчёт сообщений. Здесь выбор пользователя превращается в
 *    условие `when` Директора — и всё, что дальше, делает он (приоритет №3:
 *    «раз в N ходов» не пишется нигде, кроме одного места). Условие показано
 *    рядом с выбором как есть: механика движка не должна быть тайной.
 *  - **Нет своей вёрстки.** Всё из [общей библиотеки виджетов](../../libraries/shared/widgets.js) —
 *    в этом файле только проводка виджетов к контрактам.
 *
 * Разделение настроек тоже осознанное и отличается от Alpha, где всё лежало
 * одной кучей в настройках модуля: **что трекать — конфигурация Ядра**
 * (`tracking.configure`, переживает отключение Модуля), **как показывать —
 * настройка Модуля** (свой неймспейс в `storage.settings`). Отключишь
 * Модуль — трекеры продолжат работать, потеряется только их отображение.
 */

export const MODULE_ID = 'module.tracker';
const SETTINGS_NAMESPACE = MODULE_ID;
const DISPLAY_KEY = 'display';
const SAMPLER_KEY = 'samplerPreset';
const HUD_KEY = 'hud';

/**
 * Когда опрашивать. Не выдуманный набор, а настоящие моменты прогона из
 * PIPELINE.md — до отправки, во время, после — плюс периодика.
 *
 * `beforeSend` устроен ИНАЧЕ остальных, и это принципиально. Триггер — это
 * доставка «выстрелил и забыл»: генерация не станет ждать, пока трекер опросит
 * модель, и обновлённое значение не успеет к этому ответу. Поэтому «обновиться
 * до ответа» регистрируется ЭТАПОМ пайплайна `generation.prepare` — того, что
 * перехватчик держит и дожидается ДО сборки промпта. Остальным моментам этого
 * не нужно: после ответа и во время вызова инструмента ждать некому.
 *
 * Важно, чего трекер при этом НЕ делает: он не кладёт ничего в промпт. Его
 * продукт — значение НА ШИНЕ; кто его туда потянет (плавающая панель, макрос,
 * позже Prompt Manager) — не его забота.
 */
export const TRIGGER_MODES = Object.freeze([
    { value: 'manual', label: 'Manual only' },
    { value: 'beforeSend', label: 'Refresh before the reply' },
    { value: 'onUserMessage', label: 'When the user sends a message' },
    { value: 'onToolCall', label: 'During the reply, on every tool call' },
    { value: 'everyReply', label: 'After every reply' },
    { value: 'everyNReplies', label: 'Every N replies' },
    { value: 'everyNMinutes', label: 'Every N minutes' },
]);

const REPLY_EVENT = 'generation.completed';
const USER_MESSAGE_EVENT = 'st.messageSent';
const TOOL_CALL_EVENT = 'generation.toolCall';
// Трекер обновляет СВОЁ состояние, а не вкладывается в промпт: его продукт —
// публикация на шину (`tracking.blocks.changed` + макрос), а читают её те, кому
// значение нужно (плавающая панель, макросы ST, позже Prompt Manager). Поэтому
// этап регистрируется в `generation.prepare`, чьи выходы никуда не идут, а не в
// `generation.beforeSend`, который собирает именно вклады в промпт.
const PREPARE_PIPELINE = 'generation.prepare';

/** Имя этапа трекера в пайплайне сборки — стабильное, чтобы повторное сохранение обновляло тот же этап, а не плодило новые. */
export function computeStageId(trackerId) {
    return `tracker:${trackerId}`;
}

let uid = 0;

/** Выбор пользователя → условие `when` Директора. Единственное место в Модуле, где вообще есть слово «триггер». */
export function computeTriggers(mode, count, { blocking = true } = {}) {
    const n = Math.max(1, Number(count) || 1);
    // «До отправки, но не ждать» — это обычный триггер на том же моменте:
    // опрос стартует, генерация не задерживается, свежие значения попадут уже
    // в СЛЕДУЮЩИЙ промпт. Ровно та разница, ради которой и нужен выбор.
    if (mode === 'beforeSend' && !blocking) return [{ event: 'generation.beforeSend' }];
    if (mode === 'everyReply') return [{ event: REPLY_EVENT }];
    if (mode === 'everyNReplies') return [{ event: REPLY_EVENT, every: n }];
    if (mode === 'everyNMinutes') return [{ every: { ms: n * 60000 } }];
    if (mode === 'onUserMessage') return [{ event: USER_MESSAGE_EVENT }];
    if (mode === 'onToolCall') return [{ event: TOOL_CALL_EVENT }];
    // У `manual` и `beforeSend` триггеров нет: первый не срабатывает сам,
    // второй живёт этапом пайплайна, а не подпиской.
    return [];
}

/** Обратное чтение: по сохранённому условию восстановить, что было выбрано. Неизвестную форму не ломаем и не теряем — см. `custom` ниже. */
export function resolveTriggerMode(triggers, { hasStage = false } = {}) {
    // Этап пайплайна сильнее любого триггера: он и есть «до отправки, ждать».
    if (hasStage) return { mode: 'beforeSend', count: 3, blocking: true };
    const trigger = (triggers ?? [])[0];
    if (!trigger) return { mode: 'manual', count: 3, blocking: true };
    const shape = typeof trigger === 'string' ? { event: trigger } : trigger;
    if (shape.every?.ms) return { mode: 'everyNMinutes', count: Math.max(1, Math.round(shape.every.ms / 60000)), blocking: true };
    if (shape.event === REPLY_EVENT && shape.every) return { mode: 'everyNReplies', count: Number(shape.every) || 1, blocking: true };
    if (shape.event === REPLY_EVENT) return { mode: 'everyReply', count: 3, blocking: true };
    if (shape.event === USER_MESSAGE_EVENT) return { mode: 'onUserMessage', count: 3, blocking: true };
    if (shape.event === TOOL_CALL_EVENT) return { mode: 'onToolCall', count: 3, blocking: true };
    if (shape.event === 'generation.beforeSend') return { mode: 'beforeSend', count: 3, blocking: false };
    return { mode: 'custom', count: 3, blocking: true, custom: shape };
}

/** Строка состояния по шаблону: `❤ {health} · 📍 {location}`. Пустой шаблон — автоматический список «имя: значение». */
export function buildLabel(fields, displayTemplate) {
    if (!fields.length) return '(no fields configured)';
    const known = Object.fromEntries(fields.map(field => [field.name, field.value ?? '—']));
    if (!String(displayTemplate ?? '').trim()) return fields.map(field => `${field.name}: ${known[field.name]}`).join(' · ');
    return fillTemplate(displayTemplate, known);
}

function toRecord(tracker = {}, displayTemplate = '', hasStage = false, samplerPreset = '') {
    const { mode, count, blocking, custom } = resolveTriggerMode(tracker.triggers, { hasStage });
    const sampler = clampSamplerSettings(tracker);
    const reasoning = clampReasoningSettings(tracker);
    return {
        key: `tracker_${++uid}`,
        id: signal(tracker.id ?? ''),
        workerId: signal(tracker.workerId ?? ''),
        enabled: signal(tracker.enabled !== false),
        // Пресет сэмплера/ризонинга — свойство ЭТОГО трекера, а не воркера: см.
        // доку у `resolveGenerateRequest` в cores/models/internal-engine.js.
        // Сам ID пресета нужен только форме (какую подпись показать) — Ядру
        // трекинга он не сдаётся, поэтому хранится в неймспейсе Модуля рядом
        // с `displayTemplate`, а не в конфигурации трекера.
        samplerPreset: signal(samplerPreset),
        temperature: signal(sampler.temperature),
        topP: signal(sampler.topP),
        topK: signal(sampler.topK),
        maxTokens: signal(sampler.maxTokens),
        reasoningMode: signal(reasoning.reasoningMode),
        reasoningEffort: signal(reasoning.reasoningEffort),
        reasoningBudget: signal(reasoning.reasoningBudget),
        // Имя для «Save as preset» — своё поле формы, не часть конфигурации
        // трекера: пресет уходит в ОБЩИЙ список (см. `savePreset()` ниже), а
        // не привязывается к этому трекеру.
        newPresetName: signal(''),
        // В списке живут только ИМЕНА полей — структура. Текст подсказки у
        // каждого поля свой сигнал (`prompts`), потому что иначе набор буквы в
        // подсказке менял бы сигнал списка и перерисовывал весь редактор полей
        // на каждое нажатие. Тот же приём, что кэш `getBlockUi` в Alpha.
        fields: signal((tracker.fields ?? []).map(field => ({ name: field.name, default: field.default }))),
        prompts: new Map((tracker.fields ?? []).map(field => [field.name, signal(field.prompt ?? '')])),
        triggerMode: signal(mode),
        triggerCount: signal(count),
        // Ждать ли пайплайну этот трекер. Значимо только для `beforeSend`:
        // ждать = этап пайплайна, не ждать = обычный триггер на том же моменте.
        blocking: signal(blocking),
        // Условие, которое мы не умеем показать формой, сохраняется как есть:
        // молча превратить чужую тонкую настройку в «Manual only» хуже, чем
        // честно показать её и не трогать.
        customTrigger: custom ?? null,
        promptTemplate: signal(tracker.promptTemplate ?? ''),
        displayTemplate: signal(displayTemplate),
        values: signal([]),
        flash: signal(''), // '' | 'polling' | 'ok' | 'error' — кратковременная вспышка обводки
        newFieldName: signal(''),
        newFieldPrompt: signal(''),
    };
}

function fromRecord(record) {
    return {
        id: record.id.peek().trim(),
        kind: 'user',
        // Трекеры этого Модуля — ничьи: их завёл человек руками. `ownerId`
        // ставит только Модуль, который держит СВОЙ специализированный трекер.
        enabled: record.enabled.peek(),
        workerId: record.workerId.peek(),
        fields: record.fields.peek().map(field => ({ name: field.name, prompt: record.prompts.get(field.name)?.peek() ?? '', default: field.default })),
        triggers: record.triggerMode.peek() === 'custom'
            ? [record.customTrigger]
            : computeTriggers(record.triggerMode.peek(), record.triggerCount.peek(), { blocking: record.blocking.peek() }),
        promptTemplate: record.promptTemplate.peek().trim() || undefined,
        temperature: record.temperature.peek(),
        topP: record.topP.peek(),
        topK: record.topK.peek(),
        maxTokens: record.maxTokens.peek(),
        reasoningMode: record.reasoningMode.peek(),
        reasoningEffort: record.reasoningEffort.peek(),
        reasoningBudget: record.reasoningBudget.peek(),
    };
}

export function createTrackerModule(host) {
    // Своя память о свёрнутом, в СВОЁМ неймспейсе: как и шаблоны отображения,
    // это настройка Модуля, а не конфигурация Ядра.
    const collapse = createCollapseState(host.cores, { namespace: SETTINGS_NAMESPACE });
    const trackers = signal([]);
    const workers = signal([]);
    // Состояние плавающего окна — тоже настройка Модуля, в его же неймспейсе:
    // куда пользователь его перетащил и каким оставил, обязано пережить
    // перезагрузку, иначе окно каждый раз возвращается в угол.
    const hudCollapsed = signal(false);
    const hudVisible = signal(true);
    const hudPosition = signal({});
    const hudSize = signal({});
    // Свои пресеты сэмплера/ризонинга — ОБЩИЙ список у Ядра моделей
    // (`model.presets.get`/`set`), один и тот же для каждой карточки трекера
    // здесь И для Модуля «RP Time»: сохранённый в одном месте пресет обязан
    // быть виден в другом без перезагрузки страницы (см. подписку ниже).
    const customPresets = signal([]);
    let lastSave = null; // последний ответ на сохранение — для тестов и для хоста

    /** Всё наружу — только через Гейт Модуль→Ядро. Прямой ссылки на Ядро трекинга у Модуля нет и не должно быть. */
    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    async function saveHudState() {
        return call('storage.settings.set', {
            namespace: SETTINGS_NAMESPACE,
            key: HUD_KEY,
            value: { collapsed: hudCollapsed.peek(), visible: hudVisible.peek(), position: hudPosition.peek(), size: hudSize.peek() },
        });
    }

    async function loadHudState() {
        const result = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: HUD_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        hudCollapsed.set(Boolean(saved.collapsed));
        hudVisible.set(saved.visible !== false);
        hudSize.set(saved.size ?? {});
        // Позиция подрезается по экрану: окно, оставленное у края, после смены
        // размера окна браузера оказалось бы за его пределами и стало бы
        // недостижимым — ни перетащить, ни закрыть.
        hudPosition.set(saved.position?.left === undefined ? {} : clampToViewport(saved.position, {
            width: saved.size?.width ?? 220,
            height: saved.size?.height ?? 120,
            viewportWidth: globalThis.innerWidth ?? 1920,
            viewportHeight: globalThis.innerHeight ?? 1080,
        }));
    }

    async function loadDisplayTemplates() {
        const result = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: DISPLAY_KEY, fallback: {} });
        return result.ok ? (result.value ?? {}) : {};
    }

    async function saveDisplayTemplates() {
        const map = Object.fromEntries(trackers.peek().map(record => [record.id.peek().trim(), record.displayTemplate.peek()]).filter(([id]) => id));
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: DISPLAY_KEY, value: map });
    }

    async function loadSamplerPresets() {
        const result = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: SAMPLER_KEY, fallback: {} });
        return result.ok ? (result.value ?? {}) : {};
    }

    async function saveSamplerPresets() {
        const map = Object.fromEntries(trackers.peek().map(record => [record.id.peek().trim(), record.samplerPreset.peek()]).filter(([id, preset]) => id && preset));
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: SAMPLER_KEY, value: map });
    }

    async function refreshCustomPresets() {
        const result = await call('model.presets.get');
        customPresets.set(result.ok ? result.value ?? [] : []);
    }

    async function refreshValues(record) {
        const id = record.id.peek().trim();
        if (!id) return;
        const result = await call('tracking.fields', { trackerId: id });
        if (result.ok) record.values.set(result.value ?? []);
    }

    /** Какие трекеры сейчас стоят ЭТАПАМИ сборки промпта — источник правды тот же пайплайн, а не наша память. */
    async function loadStagedIds() {
        const result = await call('pipeline.stages', { pipelineId: PREPARE_PIPELINE });
        return new Set((result.ok ? result.value ?? [] : []).map(stage => stage.id));
    }

    async function load() {
        await Promise.all([collapse.restore(), loadHudState(), refreshCustomPresets()]);
        const [listed, display, samplerPresets, staged] = await Promise.all([
            call('tracking.trackers'), loadDisplayTemplates(), loadSamplerPresets(), loadStagedIds(),
        ]);
        const records = (listed.ok ? listed.value ?? [] : [])
            // Системные заводит движок, а трекер с `ownerId` — чужой Модуль
            // (например, «RP Time»). Ни те, ни другие не правятся руками, и в
            // списке пользователя им делать нечего — как и в плавающей панели
            // ниже, которая рисуется из этого же набора.
            .filter(tracker => tracker.kind !== 'system' && !tracker.ownerId)
            .map(tracker => toRecord(tracker, display[tracker.id] ?? '', staged.has(computeStageId(tracker.id)), samplerPresets[tracker.id] ?? ''));
        trackers.set(records);
        await Promise.all(records.map(refreshValues));

        const workerList = await call('model.workers.get');
        workers.set((workerList.ok ? workerList.value ?? [] : []).map(worker => ({ value: worker.id, label: worker.id })));
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    function flash(record, tone) {
        record.flash.set(tone);
        setTimeout(() => { if (record.flash.peek() === tone) record.flash.set(''); }, 1600);
    }

    /**
     * Приводит этапы сборки промпта в соответствие с формой. Трекер, которого
     * пайплайн должен ждать, становится его этапом; переставший — снимается.
     *
     * `onExhausted: 'flag'` намеренно: у пайплайна по умолчанию отказ этапа
     * отменяет всю генерацию, и для обязательного вклада это верно — но
     * упавший трекер не повод оставить пользователя без ответа. Помечаем и
     * идём дальше.
     */
    async function syncStages() {
        for (const record of trackers.peek()) {
            const id = record.id.peek().trim();
            if (!id) continue;
            const wanted = record.triggerMode.peek() === 'beforeSend' && record.blocking.peek();
            if (wanted) {
                await call('pipeline.stages.add', {
                    pipelineId: PREPARE_PIPELINE,
                    stage: { id: computeStageId(id), contract: 'tracking.poll', params: { trackerId: id }, onExhausted: 'flag' },
                });
            } else {
                await call('pipeline.stages.remove', { pipelineId: PREPARE_PIPELINE, stageId: computeStageId(id) });
            }
        }
    }

    async function save() {
        const list = trackers.peek().map(fromRecord).filter(tracker => tracker.id);
        // `tracking.configure` задаёт НАБОР ЦЕЛИКОМ. Отдать только свои записи
        // значило бы стереть из Ядра всё, чего этот Модуль не показывает, —
        // системные трекеры движка и трекеры чужих Модулей. Поэтому чужое
        // перечитывается прямо перед записью и уходит обратно нетронутым.
        const listed = await call('tracking.trackers');
        const mine = new Set(list.map(tracker => tracker.id));
        const foreign = (listed.ok ? listed.value ?? [] : [])
            .filter(tracker => (tracker.kind === 'system' || tracker.ownerId) && !mine.has(tracker.id));
        const result = await call('tracking.configure', { trackers: [...foreign, ...list] });
        if (result.ok) { await saveDisplayTemplates(); await saveSamplerPresets(); await syncStages(); }
        lastSave = result;
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `Saved ${list.length} tracker${list.length === 1 ? '' : 's'}` : result.error.message);
        return result.ok;
    }

    async function pollNow(record) {
        const id = record.id.peek().trim();
        if (!id) { await notify('error', 'Give the tracker a name first'); flash(record, 'error'); return; }
        // Опрос идёт по СОХРАНЁННОЙ конфигурации — иначе «сработало» значило бы
        // «сработало бы, если бы ты нажал сохранить».
        await save();
        record.flash.set('polling');
        const startedAt = Date.now();
        const result = await call('tracking.poll', { trackerId: id });
        if (result.ok) record.values.set(result.value ?? []);
        flash(record, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error',
            result.ok ? `${id}: polled in ${Date.now() - startedAt}ms` : `${id}: ${result.error.message}`);
    }

    async function resetTracker(record) {
        const id = record.id.peek().trim();
        const result = await call('tracking.reset', { trackerId: id });
        if (result.ok) record.values.set(result.value ?? []);
        flash(record, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error', result.ok ? `${id}: tracked values cleared` : result.error.message);
    }

    function addField(record) {
        const name = record.newFieldName.peek().trim().replace(/\s+/g, '_').toLowerCase();
        if (!name) { notify('error', 'Enter a field name first'); flash(record, 'error'); return; }
        if (record.fields.peek().some(field => field.name === name)) { notify('error', `Field "${name}" already exists`); flash(record, 'error'); return; }
        record.prompts.set(name, signal(record.newFieldPrompt.peek().trim()));
        record.fields.set([...record.fields.peek(), { name }]);
        record.newFieldName.set('');
        record.newFieldPrompt.set('');
    }

    function removeField(record, name) {
        record.prompts.delete(name);
        record.fields.set(record.fields.peek().filter(field => field.name !== name));
    }

    /** Пресет — только отправная точка: применяет значения один раз, дальше их можно крутить по отдельности, как в Модуле «Время». Ищет и среди готовых, и среди СВОИХ — выбор в форме об этом различии не знает. */
    function applySamplerPreset(record, id) {
        const found = [...SAMPLER_PRESETS, ...customPresets.peek()].find(item => item.id === id);
        if (!found) return;
        record.samplerPreset.set(found.id);
        record.temperature.set(found.temperature);
        record.topP.set(found.topP);
        record.topK.set(found.topK);
        record.maxTokens.set(found.maxTokens);
        record.reasoningMode.set(found.reasoningMode);
        record.reasoningEffort.set(found.reasoningEffort);
        record.reasoningBudget.set(found.reasoningBudget);
    }

    /** Сохраняет текущую подстройку ЭТОГО трекера как СВОЙ пресет — в общий список, доступный любому другому трекеру и Модулю «RP Time». Имя, уже занятое, обновляет тот же пресет, а не плодит дубликат (см. `buildCustomPreset`/`slugifyPresetName`). */
    async function savePreset(record, name) {
        const trimmed = String(name ?? '').trim();
        if (!trimmed) { await notify('error', 'Name the preset first'); return; }
        const preset = buildCustomPreset(trimmed, {
            temperature: record.temperature.peek(), topP: record.topP.peek(), topK: record.topK.peek(), maxTokens: record.maxTokens.peek(),
            reasoningMode: record.reasoningMode.peek(), reasoningEffort: record.reasoningEffort.peek(), reasoningBudget: record.reasoningBudget.peek(),
        });
        const next = [...customPresets.peek().filter(item => item.id !== preset.id), preset];
        const result = await call('model.presets.set', { presets: next });
        if (result.ok) { customPresets.set(next); record.samplerPreset.set(preset.id); record.newPresetName.set(''); }
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Saved preset "${trimmed}"` : result.error.message);
    }

    /** Удаляет пресет, выбранный СЕЙЧАС у этого трекера — только свой (готовый из коробки в списке для удаления не показывается вовсе, см. GenerationSettingsPanel). Значения на самом трекере не трогает: имя забыто, подстройка остаётся. */
    async function deletePreset(record) {
        const id = record.samplerPreset.peek();
        if (!id) return;
        const next = customPresets.peek().filter(item => item.id !== id);
        const result = await call('model.presets.set', { presets: next });
        if (result.ok) { customPresets.set(next); record.samplerPreset.set(''); }
        await notify(result.ok ? 'ok' : 'error', result.ok ? 'Preset deleted' : result.error.message);
    }

    function addTracker() {
        trackers.set([...trackers.peek(), toRecord({ id: `tracker_${trackers.peek().length + 1}`, workerId: workers.peek()[0]?.value ?? '' })]);
    }

    function removeTracker(record) {
        trackers.set(trackers.peek().filter(item => item !== record));
    }

    // --- Рисование -----------------------------------------------------------

    function fieldRow(record, field) {
        return h('div', { key: field.name, class: 'stme-tracker-field' },
            h('code', { class: 'stme-tracker-field-name' }, field.name),
            TextInput(record.prompts.get(field.name), { placeholder: 'How should the model decide it? (optional)' }),
            Button('×', () => removeField(record, field.name), { variant: 'danger' }),
        );
    }

    function fieldsSection(record) {
        return h('div', { class: 'stme-tracker-fields' },
            EditableList({
                items: record.fields,
                renderItem: field => fieldRow(record, field),
                empty: 'No fields yet — each one becomes a JSON key the model must fill in.',
            }),
            Row(
                TextInput(record.newFieldName, { placeholder: 'Field name (e.g. health)' }),
                TextInput(record.newFieldPrompt, { placeholder: 'How to decide it (optional)' }),
                Button('+ Add field', () => addField(record)),
            ),
        );
    }

    function triggerSection(record) {
        const needsCount = computed(() => record.triggerMode() === 'everyNReplies' || record.triggerMode() === 'everyNMinutes');
        return h('div', { class: 'stme-tracker-trigger' },
            Field('Poll when', Select(record.triggerMode, TRIGGER_MODES)),
            // Выбор «ждать или нет» показывается только там, где он что-то
            // значит: у остальных моментов ждать всё равно некому.
            computed(() => (record.triggerMode() === 'beforeSend'
                ? Toggle('Hold the generation until this tracker answers', record.blocking, {
                    hint: record.blocking()
                        ? 'The reply waits for the poll, so {{macros}} carry fresh values into THIS reply.'
                        : 'The poll starts and is not waited for — fresh values land in the NEXT reply.',
                })
                : null)),
            // Ползунок, а не поле ввода: у «каждый N-й» есть внятные границы,
            // и промахнуться мимо них нельзя — как это и было в Alpha.
            computed(() => {
                if (!needsCount()) return null;
                return record.triggerMode() === 'everyNMinutes'
                    ? Slider('Every N minutes', record.triggerCount, { min: 1, max: 120, step: 1 })
                    : Slider('Every N replies', record.triggerCount, { min: 1, max: 50, step: 1 });
            }),
            // Показываем настоящее условие Директора. Ничего не «переводим» —
            // это ровно то, что уедет на Шину, и пользователь вправе это видеть.
            computed(() => {
                const triggers = record.triggerMode() === 'custom' ? [record.customTrigger] : computeTriggers(record.triggerMode(), record.triggerCount());
                return h('small', { class: 'stme-tracker-when' },
                    triggers.length ? `Director condition: ${JSON.stringify(triggers[0])}` : 'No automatic polling — use “Poll now”.',
                );
            }),
        );
    }

    function displaySection(record) {
        return h('div', { class: 'stme-tracker-display' },
            Field('Display template', TextInput(record.displayTemplate, { placeholder: '❤ {health} · 📍 {location}' }), {
                hint: 'Optional. Empty means an automatic “name: value” list. Click a token to append it.',
            }),
            h('div', { class: 'stme-tracker-tokens' },
                computed(() => (record.fields().length
                    ? record.fields().map(field => Chip(`{${field.name}}`, {
                        title: `Append {${field.name}} to the template`,
                        onClick: () => record.displayTemplate.set(`${record.displayTemplate.peek()}{${field.name}}`),
                    }))
                    : [h('small', {}, 'Add fields above to get insertable tokens.')])),
            ),
        );
    }

    function trackerCard(record) {
        return Section(record.id, {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...collapse.bind(`tracker:${record.key}`),
            actions: [
                Button('Poll now', () => pollNow(record)),
                Button('Reset', () => resetTracker(record)),
                Button('Remove', () => removeTracker(record), { variant: 'danger' }),
            ],
        },
            Row(
                Field('Name', TextInput(record.id, { placeholder: 'my-tracker' })),
                Field('Model connection', Select(record.workerId, workers)),
                Toggle('Enabled', record.enabled),
            ),
            fieldsSection(record),
            triggerSection(record),
            displaySection(record),
            h('div', { class: 'stme-tracker-current' },
                h('strong', {}, 'Current state'),
                computed(() => h('span', { class: 'stme-tracker-current-value' }, buildLabel(record.values(), record.displayTemplate()))),
            ),
            GenerationSettingsPanel(record, () => [...SAMPLER_PRESETS, ...customPresets()], {
                onApplyPreset: id => applySamplerPreset(record, id),
                onSavePreset: name => savePreset(record, name),
                onDeletePreset: () => deletePreset(record),
            }),
            Details('Prompt template (advanced)',
                Field('Poll prompt', TextArea(record.promptTemplate, { rows: 4, placeholder: 'Leave empty for the engine default. Placeholder: {fields}' })),
            ),
        );
    }

    /**
     * Собственной рамки и собственного заголовка у Модуля НЕТ: карточку с его
     * именем рисует панель, и вторая такая же внутри неё читалась бы как
     * «трекер в трекере». Модуль отдаёт только содержимое.
     */
    function tree() {
        return h('div', { class: 'stme-module-body' },
            h('small', { class: 'stme-module-hint' }, 'Fields the engine keeps up to date by asking a model'),
            Row(Toggle('Show the floating state window', hudVisible, { onChange: saveHudState })),
            EditableList({
                items: trackers,
                renderItem: trackerCard,
                onAdd: addTracker,
                addLabel: '+ Add tracker',
                empty: 'No trackers yet. Add one to have the engine keep a few values up to date for you.',
                actions: [Button('Save', save)],
            }),
        );
    }

    /** Живые значения: Модуль не опрашивает Ядро по таймеру — он слушает то же событие, что и все остальные. */
    const subscriptions = [
        host.events.subscribe('tracking.blocks.changed', ({ trackerId }) => {
            const record = trackers.peek().find(item => item.id.peek().trim() === trackerId);
            if (record) refreshValues(record);
        }),
        // Набор трекеров поменял КТО-ТО ДРУГОЙ — перечитываем. Без этого список
        // зависел от порядка загрузки Модулей: свой набор мы читаем при
        // загрузке, а Модуль времени заводит свой трекер позже, и его «RP Time»
        // либо не отфильтровывался, либо не появлялся вовсе — смотря кто успел
        // первым. Собственное сохранение при этом пропускаем: перечитывать себя
        // же посреди правки значило бы затирать несохранённые поля формы.
        host.events.subscribe('tracking.trackersChanged', payload => { if (payload?.by !== MODULE_ID) load(); }),
        // Пресет сохранил или удалил КТО-ТО ДРУГОЙ — свой же список общий с
        // Модулем «RP Time», и без этого сохранённое там появлялось бы здесь
        // только после ручной перезагрузки страницы.
        host.events.subscribe('model.presets.changed', () => refreshCustomPresets()),
    ];

    /**
     * Плавающее окно с текущим состоянием — то же, что HUD у Alpha'вского
     * Tracker'а. Это ВТОРОЙ потребитель шины наравне с макросом: значение
     * приходит из `tracking.blocks.changed`, а не из какого-то своего
     * состояния Модуля, и уж точно не из промпта.
     *
     * Живёт отдельным деревом, потому что висит поверх страницы, а не внутри
     * панели движка; хост монтирует его своим Final UI.
     */
    function hud() {
        // Обёртка обязательна: КОРЕНЬ смонтированного дерева должен быть узлом,
        // а не сигналом — `render()` подаёт корень в свой собственный сигнал и
        // ждёт от него готовую ноду. Условным может быть только ребёнок.
        return h('div', { class: 'stme-hud-root' }, computed(() => (hudVisible() ? hudPanel() : null)));
    }

    /**
     * Одно ПОКАЗАНИЕ на строку — как статы в игре, а не как строка лога.
     *
     * Без шаблона отображения каждое поле получает свою строку: подпись —
     * имя поля, значение — само значение. Раньше все поля склеивались в одну
     * строку через `·`, и «health: 87 / 100 · location: Tavern doorway»
     * приходилось читать глазами по слогам, хотя окно открывают ровно затем,
     * чтобы взглянуть мельком.
     *
     * С шаблоном — одна строка на трекер: пользователь сам сказал, как это
     * должно выглядеть, и разбирать его формат обратно на поля было бы
     * самоуправством.
     */
    function hudRows(record) {
        const template = String(record.displayTemplate() ?? '').trim();
        if (template) {
            return [h('div', { key: record.key, class: 'stme-hud-row' },
                h('span', { class: 'stme-hud-name' }, record.id()),
                h('span', { class: 'stme-hud-value' }, buildLabel(record.values(), template)),
            )];
        }
        const fields = record.values();
        if (!fields.length) {
            return [h('div', { key: record.key, class: 'stme-hud-row' },
                h('span', { class: 'stme-hud-name' }, record.id()),
                h('span', { class: 'stme-hud-value stme-hud-value-muted' }, 'no fields'),
            )];
        }
        // Заголовок группы нужен только когда трекеров несколько: у одного он
        // повторял бы заголовок самого окна.
        const heading = trackers().filter(item => item.enabled() && item.id().trim()).length > 1
            ? [h('div', { key: `${record.key}:head`, class: 'stme-hud-group' }, record.id())]
            : [];
        return [...heading, ...fields.map(field => h('div', { key: `${record.key}:${field.name}`, class: 'stme-hud-row' },
            h('span', { class: 'stme-hud-name' }, field.name),
            h('span', { class: 'stme-hud-value' }, String(field.value ?? '—')),
        ))];
    }

    function hudPanel() {
        return FloatingPanel('Tracked state', {
            position: hudPosition,
            size: hudSize,
            collapsed: hudCollapsed,
            onToggle: value => { hudCollapsed.set(value); saveHudState(); },
            // Закрытие прячет окно, а не выключает трекеры: они продолжают
            // работать и писать в макрос. Вернуть окно — тумблером в карточке
            // Модуля, иначе закрытие было бы необратимым.
            onClose: () => { hudVisible.set(false); saveHudState(); },
            drag: createDragHandlers(hudPosition, {
                // Подрезаем и при отпускании, а не только при загрузке: иначе
                // окно можно утащить за край экрана вместе с его же шапкой —
                // и вернуть его будет уже нечем.
                onDrop: dropped => {
                    hudPosition.set(clampToViewport(dropped, {
                        width: hudSize.peek().width ?? 220,
                        height: hudSize.peek().height ?? 120,
                        viewportWidth: globalThis.innerWidth ?? 1920,
                        viewportHeight: globalThis.innerHeight ?? 1080,
                    }));
                    saveHudState();
                },
            }),
            onResize: next => {
                if (next.width === hudSize.peek().width && next.height === hudSize.peek().height) return;
                hudSize.set(next);
                saveHudState();
            },
        },
            computed(() => {
                const shown = trackers().filter(record => record.enabled() && record.id().trim());
                if (!shown.length) return h('small', { class: 'stme-hud-empty' }, 'Nothing tracked yet.');
                return shown.flatMap(record => hudRows(record));
            }),
        );
    }

    return {
        id: MODULE_ID,
        title: 'Tracker',
        description: 'Keeps named values up to date by polling a model, and exposes them as macros.',
        load,
        tree,
        hud,
        // Настоящие операции Модуля, а не тестовые лазейки: кнопки в карточке
        // вызывают ровно их, и хост (Раннер) вправе дёрнуть то же самое.
        save,
        pollNow,
        resetTracker,
        addTracker,
        removeTracker,
        addField,
        removeField,
        applySamplerPreset,
        savePreset,
        deletePreset,
        customPresets: () => customPresets.peek(),
        hudVisible,
        hudPosition,
        hudCollapsed,
        trackers: () => trackers.peek(),
        saveState: () => lastSave,
        stop: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
