/**
 * Форма запроса к модели и пресеты сэмплера/ризонинга — вынесено из Ядра внутренних моделей (internal-engine.js), чтобы Ядро держало
 * только очередь, воркеры и их состояние. Всё здесь — чистые функции; Ядро реэкспортирует их, прежние импорты не меняются.
 */

export const REQUEST_DEFAULTS = Object.freeze({ systemPrompt: '', temperature: 0.7, maxTokens: 1000, topP: 1, topK: 0, seed: 0 });

/** `inherit` — не трогать: провайдер решает сам, и в запрос не уходит вообще ничего про ризонинг (см. provider-request.js). Названия и смысл — те же, что в SideCar Alpha (`REASONING_MODE_OPTIONS`). */
export const REASONING_MODES = Object.freeze(['inherit', 'enabled', 'disabled']);
/** Смысла нет ни у Anthropic, ни у Google — эффорт понимает только OpenRouter'овский unified `reasoning`; для остальных полей это просто отправная точка на случай, если включат вручную. */
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);

/**
 * Пресеты сэмплера — и, теперь, ризонинга. Ни разу не про то, КАКОЙ воркер
 * («сайдкар») возьмётся отвечать: воркера выбирает `dispatchQueue` сама (или
 * пиннинг через `workerId` — см. doc-comment Ядра ниже), это отдельный, уже
 * решённый вопрос. Ровно тот же приём, что `TIME_PRESETS` у Модуля «RP Time»:
 * готовая отправная точка одним нажатием, а не восемь полей вслепую, — но
 * подкрутить дальше вручную по-прежнему можно, пресет лишь заполняет их.
 *
 * Сэмплерные значения — не выдумка: те же самые границы (0–2 / 0–1 / 0–200),
 * что были проверены на практике в SideCar Alpha (core/sidecar-service.js).
 * Ризонинг у "Deterministic"/"Precise" выключен НАМЕРЕННО, не забыт: это
 * пресеты под трекеры и строгий JSON, а рассуждающая модель отвечает
 * заметно дольше и на этом не выигрывает ничего. У "Balanced"/"Creative" —
 * `inherit` (решает сам провайдер): включать ризонинг никому не в убыток
 * (запрос его просит только если явно включён), но и настаивать на нём тоже
 * незачем, раз задача не требует.
 */
export const SAMPLER_PRESETS = Object.freeze([
    {
        id: 'deterministic',
        name: 'Deterministic (greedy)',
        description: 'Same input, same output every time — for anything that must parse the same way twice.',
        temperature: 0, topP: 1, topK: 1, maxTokens: 1000,
        reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
    },
    {
        id: 'precise',
        name: 'Precise',
        description: 'Low temperature, mostly consistent — a safe default for trackers and strict JSON.',
        temperature: 0.2, topP: 0.9, topK: 0, maxTokens: 1000,
        reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
    },
    {
        id: 'balanced',
        name: 'Balanced',
        description: 'A reasonable middle ground for most tasks.',
        temperature: 0.7, topP: 1, topK: 0, maxTokens: 1000,
        reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0,
    },
    {
        id: 'creative',
        name: 'Creative',
        description: 'Higher temperature — more varied wording, less predictable.',
        temperature: 1.1, topP: 0.95, topK: 0, maxTokens: 1000,
        reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0,
    },
]);

/**
 * Свой пресет — тот же контракт «одна кнопка заполняет ползунки», что и у
 * `SAMPLER_PRESETS`, но заведённый пользователем: «строгий JSON под мой
 * промпт», «разговорный без ризонинга», что угодно, для чего четырёх готовых
 * мало. Живёт РЯДОМ со встроенными, не вместо них — `model.presets.get`
 * отдаёт только свои, готовые уже держит `SAMPLER_PRESETS`, а собрать их
 * вместе для формы — дело вызывающего (Модуль «Трекер», Модуль «RP Time»).
 *
 * `id` — слаг от имени, не случайный: «Save as preset» под уже занятым
 * именем тем самым ОБНОВЛЯЕТ его, а не плодит дубликат рядом. Префикс
 * `custom:` не даёт столкнуться со встроенными id (`deterministic` и т.п.),
 * у которых двоеточия никогда не бывает.
 */
export function slugifyPresetName(name) {
    const slug = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
    return slug ? `custom:${slug}` : '';
}

/** Пресет из текущих значений формы — та же форма, что у `SAMPLER_PRESETS`, плюс `custom: true`: только это отличает сохранённый пользователем от готового из коробки (см. `GenerationSettingsPanel` в widgets.js — там же ЭТИМ решается, можно ли пресет удалить). */
export function buildCustomPreset(name, values = {}) {
    const sampler = clampSamplerSettings(values);
    const reasoning = clampReasoningSettings(values);
    return { id: slugifyPresetName(name), name: String(name ?? '').trim(), custom: true, ...sampler, ...reasoning };
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    const chosen = Number.isFinite(number) ? number : fallback;
    return Math.max(min, Math.min(max, chosen));
}

/**
 * Защитное чтение настроек сэмплера у ОДНОГО воркера — те же границы, что и
 * у ползунков в панели, применённые и к тому, что реально лежит на диске:
 * ручная правка сохранённого файла или старая запись без этих полей вообще
 * не должны уйти к провайдеру как есть.
 */
export function clampSamplerSettings(values = {}) {
    return {
        temperature: clampNumber(values.temperature, 0, 2, REQUEST_DEFAULTS.temperature),
        topP: clampNumber(values.topP, 0, 1, REQUEST_DEFAULTS.topP),
        topK: Math.round(clampNumber(values.topK, 0, 200, REQUEST_DEFAULTS.topK)),
        maxTokens: Math.round(clampNumber(values.maxTokens, 1, 32768, REQUEST_DEFAULTS.maxTokens)),
    };
}

/** Тот же приём, отдельной функцией: ризонинг — самостоятельный набор настроек рядом с сэмплером, а не его часть, и клэмп у него свой (перечисление, а не диапазон, для двух из трёх полей). */
export function clampReasoningSettings(values = {}) {
    return {
        reasoningMode: REASONING_MODES.includes(values.reasoningMode) ? values.reasoningMode : 'inherit',
        reasoningEffort: REASONING_EFFORTS.includes(values.reasoningEffort) ? values.reasoningEffort : 'medium',
        reasoningBudget: Math.round(clampNumber(values.reasoningBudget, 0, 32768, 0)),
    };
}

/**
 * Defensive reader — any missing/malformed field falls back to a sane
 * default rather than reaching a provider with `undefined` in it.
 *
 * Пресет сэмплера/ризонинга — свойство ЗАПРОСА (трекера, «Времени» и т.д.),
 * а не воркера: один и тот же сайдкар должен уметь тем же вызовом что строго
 * трекать JSON, что вести творческую генерацию, с разными настройками
 * одновременно — привязать это к воркеру такую возможность бы отняло.
 * Поэтому явный параметр САМОГО запроса (`params.temperature` и т.п.)
 * побеждает всегда; `worker` читается вторым слоем НА СЛУЧАЙ, если у него
 * когда-либо будут свои поля (сейчас панель воркеров их не заводит — см.
 * cores/ui/engine-panel.js), а `REQUEST_DEFAULTS` — запасное дно под обоими.
 */
export function resolveGenerateRequest(params, worker) {
    const source = params ?? {};
    const samplerDefaults = clampSamplerSettings(worker);
    const reasoningDefaults = clampReasoningSettings(worker);
    return {
        prompt: String(source.prompt ?? ''),
        systemPrompt: String(source.systemPrompt ?? REQUEST_DEFAULTS.systemPrompt),
        // Multi-turn escape hatch, `openai` format only (see buildOpenAiRequest()
        // in provider-request.js) — `null` (not `[]`) when absent so the openai
        // builder can tell "no messages given" apart from "given but empty" and
        // fall back to the prompt/systemPrompt sugar above unambiguously. First
        // real caller: Summary Core's verify-expand/redo cycle (ROADMAP.md),
        // which needs a real assistant turn (the previous draft) plus a second
        // system turn (the reviewer's instruction) — something prompt/systemPrompt
        // alone cannot express at all.
        messages: Array.isArray(source.messages) && source.messages.length ? source.messages : null,
        temperature: Number.isFinite(source.temperature) ? source.temperature : samplerDefaults.temperature,
        maxTokens: Number.isFinite(source.maxTokens) ? source.maxTokens : samplerDefaults.maxTokens,
        topP: Number.isFinite(source.topP) ? source.topP : samplerDefaults.topP,
        topK: Number.isFinite(source.topK) ? source.topK : samplerDefaults.topK,
        seed: Number.isFinite(source.seed) ? source.seed : REQUEST_DEFAULTS.seed,
        frequencyPenalty: Number.isFinite(source.frequencyPenalty) ? source.frequencyPenalty : 0,
        presencePenalty: Number.isFinite(source.presencePenalty) ? source.presencePenalty : 0,
        reasoningMode: REASONING_MODES.includes(source.reasoningMode) ? source.reasoningMode : reasoningDefaults.reasoningMode,
        reasoningEffort: REASONING_EFFORTS.includes(source.reasoningEffort) ? source.reasoningEffort : reasoningDefaults.reasoningEffort,
        reasoningBudget: Number.isFinite(source.reasoningBudget) ? source.reasoningBudget : reasoningDefaults.reasoningBudget,
    };
}
