/**
 * Настройки ядра «директор + прозаик» — чистые защитные чтения, без шин и
 * хранения. Форма одна и та же в памяти, в `storage.settings` и в панели;
 * панель правит те же поля, поэтому клэмп живёт здесь, а не в UI.
 */

export const DECISION_NAMESPACE = 'core.decision';
export const DECISION_MEMORY_NAMESPACE = 'core.decision';

/** Те же значения, что у Ядра моделей, — но Библиотека не имеет права импортировать Ядро (слои, LIBRARIES.md). */
export const REASONING_MODES = Object.freeze(['inherit', 'enabled', 'disabled']);
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const REGEN_MODES = Object.freeze(['decider', 'writer']);

export const DEFAULT_DECIDER = Object.freeze({
    workerId: '',
    samplerPreset: '',
    temperature: 0.7,
    topP: 1,
    topK: 0,
    maxTokens: 2000,
    reasoningMode: 'inherit',
    reasoningEffort: 'medium',
    reasoningBudget: 0,
});

export const DEFAULT_COMPRESSION = Object.freeze({
    workerId: '',
    thresholdTokens: 50000,
    maxTokens: 2000,
    temperature: 0.2,
});

export const DEFAULT_WRITER = Object.freeze({
    workerId: '',
    samplerPreset: '',
    applySampler: false,
    temperature: 0.9,
    topP: 1,
    topK: 0,
    maxTokens: 1000,
});

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    rules: '',
    regen: 'decider',
    // Предохранители и таймаут формы части 2.
    maxSteps: 50,
    implicitAwait: false,
    formTimeoutMs: 180000,
    // Seed оценки — только для тестов; `null` означает настоящий бросок.
    assessSeed: null,
    decider: DEFAULT_DECIDER,
    writer: DEFAULT_WRITER,
    compression: DEFAULT_COMPRESSION,
});

function number(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function text(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

/** Защитное чтение: ручная правка файла настроек и старая запись без полей не должны уйти в запрос как есть. */
export function clampDecisionSettings(values = {}) {
    const source = values && typeof values === 'object' ? values : {};
    const decider = source.decider && typeof source.decider === 'object' ? source.decider : {};
    const writer = source.writer && typeof source.writer === 'object' ? source.writer : {};
    const compression = source.compression && typeof source.compression === 'object' ? source.compression : {};
    return {
        enabled: source.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(source.enabled),
        rules: text(source.rules, DEFAULT_SETTINGS.rules),
        regen: REGEN_MODES.includes(source.regen) ? source.regen : DEFAULT_SETTINGS.regen,
        maxSteps: Math.round(number(source.maxSteps, 1, 500, DEFAULT_SETTINGS.maxSteps)),
        implicitAwait: source.implicitAwait === undefined ? DEFAULT_SETTINGS.implicitAwait : Boolean(source.implicitAwait),
        formTimeoutMs: Math.round(number(source.formTimeoutMs, 1000, 3600000, DEFAULT_SETTINGS.formTimeoutMs)),
        assessSeed: Number.isFinite(source.assessSeed) ? Number(source.assessSeed) : null,
        decider: {
            workerId: text(decider.workerId, DEFAULT_DECIDER.workerId).trim(),
            samplerPreset: text(decider.samplerPreset, DEFAULT_DECIDER.samplerPreset).trim(),
            temperature: number(decider.temperature, 0, 2, DEFAULT_DECIDER.temperature),
            topP: number(decider.topP, 0, 1, DEFAULT_DECIDER.topP),
            topK: Math.round(number(decider.topK, 0, 200, DEFAULT_DECIDER.topK)),
            maxTokens: Math.round(number(decider.maxTokens, 1, 32768, DEFAULT_DECIDER.maxTokens)),
            reasoningMode: REASONING_MODES.includes(decider.reasoningMode) ? decider.reasoningMode : DEFAULT_DECIDER.reasoningMode,
            reasoningEffort: REASONING_EFFORTS.includes(decider.reasoningEffort) ? decider.reasoningEffort : DEFAULT_DECIDER.reasoningEffort,
            reasoningBudget: Math.round(number(decider.reasoningBudget, 0, 32768, DEFAULT_DECIDER.reasoningBudget)),
        },
        writer: {
            workerId: text(writer.workerId, DEFAULT_WRITER.workerId).trim(),
            samplerPreset: text(writer.samplerPreset, DEFAULT_WRITER.samplerPreset).trim(),
            applySampler: writer.applySampler === undefined ? DEFAULT_WRITER.applySampler : Boolean(writer.applySampler),
            temperature: number(writer.temperature, 0, 2, DEFAULT_WRITER.temperature),
            topP: number(writer.topP, 0, 1, DEFAULT_WRITER.topP),
            topK: Math.round(number(writer.topK, 0, 200, DEFAULT_WRITER.topK)),
            maxTokens: Math.round(number(writer.maxTokens, 1, 32768, DEFAULT_WRITER.maxTokens)),
        },
        compression: {
            workerId: text(compression.workerId, DEFAULT_COMPRESSION.workerId).trim(),
            thresholdTokens: Math.round(number(compression.thresholdTokens, 1, 500000, DEFAULT_COMPRESSION.thresholdTokens)),
            maxTokens: Math.round(number(compression.maxTokens, 200, 32768, DEFAULT_COMPRESSION.maxTokens)),
            temperature: number(compression.temperature, 0, 2, DEFAULT_COMPRESSION.temperature),
        },
    };
}

/** Параметры `model.generate` из настроек директора — только те поля, которые Ядру моделей действительно нужны. */
export function deciderRequestParams(decider = {}) {
    const values = decider && typeof decider === 'object' ? decider : {};
    return {
        ...(values.workerId ? { workerId: values.workerId } : {}),
        temperature: values.temperature,
        topP: values.topP,
        topK: values.topK,
        maxTokens: values.maxTokens,
        reasoningMode: values.reasoningMode,
        reasoningEffort: values.reasoningEffort,
        reasoningBudget: values.reasoningBudget,
    };
}
