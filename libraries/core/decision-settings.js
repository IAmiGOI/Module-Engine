/**
 * Настройки ядра «директор + прозаик» — чистые защитные чтения, без шин и
 * хранения. Форма одна и та же в памяти, в `storage.settings` и в панели;
 * панель правит те же поля, поэтому клэмп живёт здесь, а не в UI.
 */
import { cleanOverrides } from './prompt-overrides.js';
import { migratePromptSections } from './decision-prompt-model.js';
import { clampGameSettings, DEFAULT_GAME_SETTINGS } from './game-settings.js';
import { clampGameMixes } from './game-mixes.js';

export const DECISION_NAMESPACE = 'core.decision';

// Работа директора после хода — по умолчанию включена. Тесты, считающие вызовы модели, выключают её здесь, а не в каждой сборке.
let afterTurnDefault = true;
export function setAfterTurnDefault(value) { afterTurnDefault = Boolean(value); }
export const afterTurnEnabled = settings => (settings?.afterTurn === undefined ? afterTurnDefault : settings.afterTurn !== false);
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
    frequencyPenalty: 0.3,
});

export const DEFAULT_PROMPTS = Object.freeze({ director: '', writer: '' });

export const DEFAULT_CLASSIFIER = Object.freeze({
    connectionId: '',
    threshold: 0.85,
    checkTokens: 150,
    rewriteLimit: 2,
});

/** Подсказка систем Scales: подключение классификатора, чьи оценки идут в ход. Пусто — шаг пропускается. */
export const DEFAULT_SCALES_HINT = Object.freeze({
    connectionId: '',
});

export const DEFAULT_BOOTSTRAP = Object.freeze({
    maxQuestions: 5,
    maxSteps: 30,
    timeoutMs: 180000,
});

/**
 * Резолвер заранее: пока игрок печатает, ход решается в ветке. По умолчанию
 * выключено — иначе спекуляция съедает скриптовые ответы в e-тестах. У уже
 * сохранённых настроек её включает миграция (см. cores/decision/index.js).
 */
export const DEFAULT_SPECULATE = Object.freeze({
    enabled: false,
    threshold: 0.6,
});

/**
 * Советник (часть 18): своё подключение — по умолчанию подключение резолвера;
 * будится каждые N ходов и в конце RP-дня.
 */
export const DEFAULT_COUNSELLOR = Object.freeze({
    workerId: '',
    everyTurns: 3,
    maxSteps: 12,
});

/**
 * Director (часть 19): своё подключение и свой лимит шагов. Телеграмма
 * блокирует следующий ход не дольше `decreeTimeoutMs`.
 */
export const DEFAULT_DIRECTOR = Object.freeze({
    workerId: '',
    maxSteps: 10,
    decreeTimeoutMs: 120000,
});

/**
 * God (фаза 5): своё подключение, свой лимит шагов и лимит вопросов за одно
 * построение Creation. Пустое подключение — подключение Director (решение
 * владельца: одна мощная модель, два ключа).
 */
export const DEFAULT_GOD = Object.freeze({
    workerId: '',
    maxSteps: 20,
    maxQuestions: 5,
});

/**
 * Психолог (psyche.md): свой воркер, а без него — воркер Директора. Один
 * вызов модели без рассуждения на персонажа.
 */
export const DEFAULT_PSYCHOLOGIST = Object.freeze({
    workerId: '',
});

/**
 * Один алгоритм повтора для всех ролей (часть 19): общий лимит попыток,
 * бюджеты времени у блокирующих и фоновых ролей и запасные подключения.
 */
export const DEFAULT_RETRY = Object.freeze({
    maxAttempts: 3,
    turnBudgetMs: 120000,
    backgroundBudgetMs: 600000,
    backups: Object.freeze({ resolver: '', writer: '', counsellor: '', director: '', god: '', banks: '' }),
});

/**
 * Времена суток для сроков Great Bank: модель пишет «dawn», движок ставит
 * абсолютную метку. Настройка владельца — часы можно переписать.
 */
export const DEFAULT_BANK_TIME_OF_DAY = Object.freeze({
    dawn: '06:00', morning: '08:00', noon: '12:00', afternoon: '13:00', evening: '18:00', night: '22:00', midnight: '00:00',
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
    scalesHint: DEFAULT_SCALES_HINT,
    bootstrap: DEFAULT_BOOTSTRAP,
    speculate: DEFAULT_SPECULATE,
    counsellor: DEFAULT_COUNSELLOR,
    director: DEFAULT_DIRECTOR,
    god: DEFAULT_GOD,
    psychologist: DEFAULT_PSYCHOLOGIST,
    retry: DEFAULT_RETRY,
    bankTimeOfDay: DEFAULT_BANK_TIME_OF_DAY,
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

/** Время суток — `HH:MM`; мусор заменяется умолчанием, лишние слова отбрасываются. */
export function clampTimeOfDay(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = { ...DEFAULT_BANK_TIME_OF_DAY };
    for (const [word, at] of Object.entries(source)) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim());
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) continue;
        out[String(word).toLowerCase()] = `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
    }
    return out;
}

/** Защитное чтение: ручная правка файла настроек и старая запись без полей не должны уйти в запрос как есть. */
export function clampDecisionSettings(values = {}) {
    const source = values && typeof values === 'object' ? values : {};
    const decider = source.decider && typeof source.decider === 'object' ? source.decider : {};
    const writer = source.writer && typeof source.writer === 'object' ? source.writer : {};
    const compression = source.compression && typeof source.compression === 'object' ? source.compression : {};
    const classifier = source.classifier && typeof source.classifier === 'object' ? source.classifier : {};
    const scalesHint = source.scalesHint && typeof source.scalesHint === 'object' ? source.scalesHint : {};
    const bootstrap = source.bootstrap && typeof source.bootstrap === 'object' ? source.bootstrap : {};
    const speculate = source.speculate && typeof source.speculate === 'object' ? source.speculate : {};
    const counsellor = source.counsellor && typeof source.counsellor === 'object' ? source.counsellor : {};
    const director = source.director && typeof source.director === 'object' ? source.director : {};
    const god = source.god && typeof source.god === 'object' ? source.god : {};
    const psychologist = source.psychologist && typeof source.psychologist === 'object' ? source.psychologist : {};
    const retry = source.retry && typeof source.retry === 'object' ? source.retry : {};
    const backups = retry.backups && typeof retry.backups === 'object' ? retry.backups : {};
    const prompts = source.prompts && typeof source.prompts === 'object' ? source.prompts : {};
    const researcher = source.researcher && typeof source.researcher === 'object' ? source.researcher : {};
    return {
        prompts: {
            director: text(prompts.director, text(source.rules, DEFAULT_PROMPTS.director)),
            writer: text(prompts.writer, DEFAULT_PROMPTS.writer),
        },
        promptSections: migratePromptSections(source.promptSections, { director: prompts.director, writer: prompts.writer }),
        promptOverrides: cleanOverrides(source.promptOverrides),
        gameDefaults: clampGameSettings(source.gameDefaults),
        gameMixes: clampGameMixes(source.gameMixes),
        regen: REGEN_MODES.includes(source.regen) ? source.regen : DEFAULT_SETTINGS.regen,
        maxSteps: Math.round(number(source.maxSteps, 1, 500, DEFAULT_SETTINGS.maxSteps)),
        implicitAwait: source.implicitAwait === undefined ? DEFAULT_SETTINGS.implicitAwait : Boolean(source.implicitAwait),
        ...(source.afterTurn === undefined ? {} : { afterTurn: Boolean(source.afterTurn) }),
        formTimeoutMs: Math.round(number(source.formTimeoutMs, 10, 3600000, DEFAULT_SETTINGS.formTimeoutMs)),
        bankColdStartTimeoutMs: Math.round(number(source.bankColdStartTimeoutMs, 1000, 3600000, DEFAULT_SETTINGS.bankColdStartTimeoutMs)),
        // Холодный старт банков: «sort» — пять ролей (по умолчанию), «build» — старый сборщик на каждого.
        bankColdStart: source.bankColdStart === 'build' ? 'build' : 'sort',
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
            // Штраф за повторы: писатель переписывал целые абзацы из своих прошлых ответов.
            frequencyPenalty: number(writer.frequencyPenalty, 0, 2, DEFAULT_WRITER.frequencyPenalty),
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
        scalesHint: {
            connectionId: text(scalesHint.connectionId, DEFAULT_SCALES_HINT.connectionId).trim(),
        },
        bootstrap: {
            maxQuestions: Math.round(number(bootstrap.maxQuestions, 1, 20, DEFAULT_BOOTSTRAP.maxQuestions)),
            maxSteps: Math.round(number(bootstrap.maxSteps, 1, 200, DEFAULT_BOOTSTRAP.maxSteps)),
            timeoutMs: Math.round(number(bootstrap.timeoutMs, 1000, 3600000, DEFAULT_BOOTSTRAP.timeoutMs)),
            // Старый бутстрап резолвера (до пяти ролей): таймлайн и место пользователя теперь спрашивает God. Только явно.
            legacy: bootstrap.legacy === true,
        },
        speculate: {
            enabled: speculate.enabled === true,
            threshold: number(speculate.threshold, 0, 1, DEFAULT_SPECULATE.threshold),
        },
        counsellor: {
            workerId: text(counsellor.workerId, DEFAULT_COUNSELLOR.workerId).trim(),
            everyTurns: Math.round(number(counsellor.everyTurns, 1, 50, DEFAULT_COUNSELLOR.everyTurns)),
            maxSteps: Math.round(number(counsellor.maxSteps, 1, 100, DEFAULT_COUNSELLOR.maxSteps)),
        },
        director: {
            workerId: text(director.workerId, DEFAULT_DIRECTOR.workerId).trim(),
            maxSteps: Math.round(number(director.maxSteps, 1, 100, DEFAULT_DIRECTOR.maxSteps)),
            decreeTimeoutMs: Math.round(number(director.decreeTimeoutMs, 1000, 3600000, DEFAULT_DIRECTOR.decreeTimeoutMs)),
        },
        // Режимы хода: выключены у новых настроек; у сохранённых их включает миграция (см. cores/decision/index.js).
        modes: {
            enabled: source.modes?.enabled === true,
            workerId: text(source.modes?.workerId, '').trim(),
        },
        god: {
            workerId: text(god.workerId, DEFAULT_GOD.workerId).trim(),
            maxSteps: Math.round(number(god.maxSteps, 1, 200, DEFAULT_GOD.maxSteps)),
            maxQuestions: Math.round(number(god.maxQuestions, 1, 20, DEFAULT_GOD.maxQuestions)),
        },
        psychologist: {
            workerId: text(psychologist.workerId, DEFAULT_PSYCHOLOGIST.workerId).trim(),
        },
        retry: {
            maxAttempts: Math.round(number(retry.maxAttempts, 1, 5, DEFAULT_RETRY.maxAttempts)),
            turnBudgetMs: Math.round(number(retry.turnBudgetMs, 1000, 3600000, DEFAULT_RETRY.turnBudgetMs)),
            backgroundBudgetMs: Math.round(number(retry.backgroundBudgetMs, 1000, 3600000, DEFAULT_RETRY.backgroundBudgetMs)),
            backups: {
                resolver: text(backups.resolver, '').trim(),
                writer: text(backups.writer, '').trim(),
                counsellor: text(backups.counsellor, '').trim(),
                director: text(backups.director, '').trim(),
                god: text(backups.god, '').trim(),
                banks: text(backups.banks, '').trim(),
            },
        },
        bankTimeOfDay: clampTimeOfDay(source.bankTimeOfDay),
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

/** Лимит ответа ролей без своих настроек генерации: Бог переписывает файлы мира, директор — банки и Указы. */
export const ROLE_MAX_TOKENS = Object.freeze({ god: 32000, director: 16000, counsellor: 8000 });

/** Параметры генерации роли: от резолвера, но лимит ответа свой — иначе размышление съедает весь ответ. */
export function roleRequestParams(settings = {}, role = 'god') {
    const params = deciderRequestParams(settings?.decider, { floor: true });
    const own = Number(settings?.[role]?.maxTokens);
    return { ...params, maxTokens: Math.max(Number(params.maxTokens) || 0, Number.isFinite(own) && own > 0 ? own : (ROLE_MAX_TOKENS[role] ?? 8000)) };
}

/** Советник работает на своём подключении, а без него — на подключении резолвера. */
export function counsellorWorkerId(settings = {}) {
    const own = String(settings?.counsellor?.workerId ?? '').trim();
    return own || String(settings?.decider?.workerId ?? '').trim();
}

/** Director работает на своём подключении, а без него — на подключении резолвера. */
export function directorWorkerId(settings = {}) {
    const own = String(settings?.director?.workerId ?? '').trim();
    return own || String(settings?.decider?.workerId ?? '').trim();
}

/** God — своё подключение; без него — подключение Director (одна мощная модель, два ключа). */
export function godWorkerId(settings = {}) {
    const own = String(settings?.god?.workerId ?? '').trim();
    return own || directorWorkerId(settings);
}

/** Психолог — своё подключение; без него — подключение Director. */
export function psychologistWorkerId(settings = {}) {
    const own = String(settings?.psychologist?.workerId ?? '').trim();
    return own || directorWorkerId(settings);
}

/** Запасное подключение роли — для двух пустых ответов подряд (часть 19). */
export function retryBackupId(settings = {}, role = 'resolver') {
    return String(settings?.retry?.backups?.[role] ?? '').trim();
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
        scalesHint: { ...DEFAULT_SCALES_HINT, ...(settings.scalesHint ?? {}) },
        counsellor: { ...DEFAULT_COUNSELLOR, ...(settings.counsellor ?? {}) },
        director: { ...DEFAULT_DIRECTOR, ...(settings.director ?? {}) },
        god: { ...DEFAULT_GOD, ...(settings.god ?? {}) },
        psychologist: { ...DEFAULT_PSYCHOLOGIST, ...(settings.psychologist ?? {}) },
        retry: {
            ...DEFAULT_RETRY,
            ...(settings.retry ?? {}),
            backups: { ...DEFAULT_RETRY.backups, ...(settings.retry?.backups ?? {}) },
        },
    };
}
