/**
 * Настройки ядра «директор + прозаик» — чистые защитные чтения, без шин и
 * хранения. Форма одна и та же в памяти, в `storage.settings` и в панели;
 * панель правит те же поля, поэтому клэмп живёт здесь, а не в UI.
 */
import { migratePromptSections } from './decision-prompt-model.js';
import { clampGameSettings, DEFAULT_GAME_SETTINGS } from './game-settings.js';
import { clampGameMixes } from './game-mixes.js';

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
    maxTokens: 8000,
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

export const DEFAULT_PROMPTS = Object.freeze({ director: '', writer: '' });

export const DEFAULT_CLASSIFIER = Object.freeze({
    connectionId: '',
    threshold: 0.85,
    checkTokens: 150,
    rewriteLimit: 2,
});

export const DEFAULT_BOOTSTRAP = Object.freeze({
    maxQuestions: 5,
    maxSteps: 30,
    timeoutMs: 180000,
});

export const DEFAULT_SETTINGS = Object.freeze({
    prompts: DEFAULT_PROMPTS,
    // Настройки игры для новых чатов (часть 13). Настройки текущего чата — в памяти чата.
    gameDefaults: DEFAULT_GAME_SETTINGS,
    // Сохранённые игроком наборы (часть 14) — глобально, не на чат.
    gameMixes: Object.freeze([]),
    regen: 'decider',
    // Предохранители и таймаут формы части 2.
    maxSteps: 50,
    implicitAwait: false,
    formTimeoutMs: 180000,
    bankColdStartTimeoutMs: 120000,
    compressedLimitTokens: 100000,
    archiveLimitTokens: 500000,
    windowLimit: 50,
    windowDropShare: 0.6,
    windowSummaryMaxTokens: 1200,
    researcher: { workerId: '', maxTasks: 2, maxSteps: 50 },
    // e11: предложения Claude, каждое — отдельной настройкой.
    snapshots: true,
    adaptiveReasoning: true,
    thinkingLimitTokens: 2000,
    turnDraft: false,
    costCounter: true,
    startOnTyping: false,
    // Seed оценки — только для тестов; `null` означает настоящий бросок.
    assessSeed: null,
    classifier: DEFAULT_CLASSIFIER,
    bootstrap: DEFAULT_BOOTSTRAP,
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
    const classifier = source.classifier && typeof source.classifier === 'object' ? source.classifier : {};
    const bootstrap = source.bootstrap && typeof source.bootstrap === 'object' ? source.bootstrap : {};
    const prompts = source.prompts && typeof source.prompts === 'object' ? source.prompts : {};
    const researcher = source.researcher && typeof source.researcher === 'object' ? source.researcher : {};
    return {
        prompts: {
            director: text(prompts.director, text(source.rules, DEFAULT_PROMPTS.director)),
            writer: text(prompts.writer, DEFAULT_PROMPTS.writer),
        },
        promptSections: migratePromptSections(source.promptSections, { director: prompts.director, writer: prompts.writer }),
        gameDefaults: clampGameSettings(source.gameDefaults),
        gameMixes: clampGameMixes(source.gameMixes),
        regen: REGEN_MODES.includes(source.regen) ? source.regen : DEFAULT_SETTINGS.regen,
        maxSteps: Math.round(number(source.maxSteps, 1, 500, DEFAULT_SETTINGS.maxSteps)),
        implicitAwait: source.implicitAwait === undefined ? DEFAULT_SETTINGS.implicitAwait : Boolean(source.implicitAwait),
        formTimeoutMs: Math.round(number(source.formTimeoutMs, 10, 3600000, DEFAULT_SETTINGS.formTimeoutMs)),
        bankColdStartTimeoutMs: Math.round(number(source.bankColdStartTimeoutMs, 1000, 3600000, DEFAULT_SETTINGS.bankColdStartTimeoutMs)),
        compressedLimitTokens: Math.round(number(source.compressedLimitTokens, 1, 5000000, DEFAULT_SETTINGS.compressedLimitTokens)),
        archiveLimitTokens: Math.round(number(source.archiveLimitTokens, 1, 5000000, DEFAULT_SETTINGS.archiveLimitTokens)),
        windowLimit: Math.round(number(source.windowLimit, 2, 500, DEFAULT_SETTINGS.windowLimit)),
        windowDropShare: number(source.windowDropShare, 0.1, 0.9, DEFAULT_SETTINGS.windowDropShare),
        windowSummaryMaxTokens: Math.round(number(source.windowSummaryMaxTokens, 200, 32768, DEFAULT_SETTINGS.windowSummaryMaxTokens)),
        assessSeed: Number.isFinite(source.assessSeed) ? Number(source.assessSeed) : null,
        snapshots: source.snapshots === undefined ? DEFAULT_SETTINGS.snapshots : Boolean(source.snapshots),
        adaptiveReasoning: source.adaptiveReasoning === undefined ? DEFAULT_SETTINGS.adaptiveReasoning : Boolean(source.adaptiveReasoning),
        thinkingLimitTokens: Number.isFinite(Number(source.thinkingLimitTokens)) ? Math.max(0, Number(source.thinkingLimitTokens)) : DEFAULT_SETTINGS.thinkingLimitTokens,
        turnDraft: source.turnDraft === undefined ? DEFAULT_SETTINGS.turnDraft : Boolean(source.turnDraft),
        costCounter: source.costCounter === undefined ? DEFAULT_SETTINGS.costCounter : Boolean(source.costCounter),
        startOnTyping: source.startOnTyping === undefined ? DEFAULT_SETTINGS.startOnTyping : Boolean(source.startOnTyping),
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
        classifier: {
            connectionId: text(classifier.connectionId, DEFAULT_CLASSIFIER.connectionId).trim(),
            threshold: number(classifier.threshold, 0, 1, DEFAULT_CLASSIFIER.threshold),
            checkTokens: Math.round(number(classifier.checkTokens, 20, 4000, DEFAULT_CLASSIFIER.checkTokens)),
            rewriteLimit: Math.round(number(classifier.rewriteLimit, 0, 10, DEFAULT_CLASSIFIER.rewriteLimit)),
        },
        bootstrap: {
            maxQuestions: Math.round(number(bootstrap.maxQuestions, 1, 20, DEFAULT_BOOTSTRAP.maxQuestions)),
            maxSteps: Math.round(number(bootstrap.maxSteps, 1, 200, DEFAULT_BOOTSTRAP.maxSteps)),
            timeoutMs: Math.round(number(bootstrap.timeoutMs, 1000, 3600000, DEFAULT_BOOTSTRAP.timeoutMs)),
        },
        researcher: {
            workerId: text(researcher.workerId, '').trim(),
            maxTasks: Math.round(number(researcher.maxTasks, 1, 8, 2)),
            maxSteps: Math.round(number(researcher.maxSteps, 1, 200, 50)),
        },
    };
}

/** Параметры `model.generate` из настроек директора — только те поля, которые Ядру моделей действительно нужны. */
/** С включённым ризонингом размышления тратят тот же лимит, что и ответ: меньше — и ответ обрезается пустым. */
export const DECIDER_MIN_TOKENS_WITH_REASONING = 6000;

// `floor: false` — ход: лимит из настройки как есть, чтобы директор не думал минутами (пустой ответ всё равно повторяется с удвоенным лимитом).
// Фоновым циклам (bootstrap, сообщения) — нижняя граница при ризонинге: там ответ важнее скорости.
export function deciderRequestParams(decider = {}, { floor = true } = {}) {
    const values = decider && typeof decider === 'object' ? decider : {};
    const reasoning = values.reasoningMode && values.reasoningMode !== 'disabled';
    const maxTokens = floor && reasoning && Number.isFinite(values.maxTokens) ? Math.max(values.maxTokens, DECIDER_MIN_TOKENS_WITH_REASONING) : values.maxTokens;
    return {
        ...(values.workerId ? { workerId: values.workerId } : {}),
        temperature: values.temperature,
        topP: values.topP,
        topK: values.topK,
        maxTokens,
        reasoningMode: values.reasoningMode,
        reasoningEffort: values.reasoningEffort,
        reasoningBudget: values.reasoningBudget,
    };
}

/** Копия настроек наружу: без общих вложенных объектов. */
export function publicDecisionSettings(settings = {}) {
    return {
        ...settings,
        decider: { ...settings.decider },
        writer: { ...settings.writer },
        prompts: { ...settings.prompts },
        promptSections: structuredClone(settings.promptSections ?? {}),
        gameDefaults: { ...settings.gameDefaults },
        gameMixes: (settings.gameMixes ?? []).map(mix => ({ ...mix, values: { ...mix.values } })),
    };
}
