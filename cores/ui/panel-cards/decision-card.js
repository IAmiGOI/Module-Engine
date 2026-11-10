import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Card, Toggle, Select, Field, Row, Button, Slider, Details } from '../../../libraries/shared/widgets.js';
import { SAMPLER_PRESETS } from '../../models/generate-request.js';
import { rosterView, planView, libraryView, bankView, arcsNotesView, forcedView } from './decision-views.js';
import { createClassifierOptions, writerCheckSection } from './decision-card-check.js';
import { createBootstrapSettings } from './decision-card-bootstrap.js';
import { createGodSettings } from './decision-card-god.js';
/**
 * Карточка «Director / Writer» на экране настроек движка. Читает и пишет
 * только через контракты `decision.*`, `model.workers.get`,
 * `model.presets.get` — как и остальные карточки панели.
 *
 * Прозаик ризонингом не пользуется никогда (это не настройка, а правило
 * ядра), поэтому у него в карточке нет полей ризонинга вовсе — только
 * сэмплер.
 */
const readField = value => (typeof value === 'function' ? value() : value);
export function createDecisionCard({ call, collapse, notify, workers, openSettings, openDirector }) {
    const regen = signal('decider');
    const deciderWorkerId = signal('');
    const writerWorkerId = signal('');
    const decider = {
        samplerPreset: signal(''), temperature: signal(0.7), topP: signal(1), topK: signal(0), maxTokens: signal(2000),
        reasoningMode: signal('inherit'), reasoningEffort: signal('medium'), reasoningBudget: signal(0),
    };
    const writer = {
        samplerPreset: signal(''), applySampler: signal(false),
        temperature: signal(0.9), topP: signal(1), topK: signal(0), maxTokens: signal(1000), frequencyPenalty: signal(0.3),
    };
    const lastRun = signal(null);
    const presets = signal([]);
    const maxSteps = signal(50);
    const formTimeoutMs = signal(180000);
    const compressedLimitTokens = signal(100000);
    const compression = { workerId: signal(''), thresholdTokens: signal(50000) };
    const researcherSettings = { workerId: signal(''), maxTasks: signal(2), maxSteps: signal(50), bankMaxSteps: signal(20), bankConcurrency: signal(4) };
    const snapshots = signal(true);
    const adaptiveReasoning = signal(true);
    const thinkingLimitTokens = signal(2000);
    const turnDraft = signal(false);
    const costCounter = signal(true);
    const startOnTyping = signal(false);
    const implicitAwait = signal(false);
    const classifierConnectionId = signal('');
    const classifierThreshold = signal(0.85);
    const classifierCheckTokens = signal(150);
    const classifierRewriteLimit = signal(2);
    const classifierConnections = signal([]);
    const counsellorWorkerId = signal('');
    const counsellorEveryTurns = signal(3);
    const counsellorMaxSteps = signal(12);
    const directorWorkerId = signal('');
    const directorMaxSteps = signal(10);
    const decreeTimeoutMs = signal(120000);
    const psychologistWorkerId = signal('');
    const retryMaxAttempts = signal(3);
    const retryTurnBudgetMs = signal(120000);
    const retryBackgroundBudgetMs = signal(600000);
    const retryBackups = {
        resolver: signal(''), writer: signal(''), counsellor: signal(''), director: signal(''), god: signal(''), banks: signal(''),
    };
    const bootstrapSettings = createBootstrapSettings();
    const roster = signal({ active: [] });
    const plan = signal(null);
    const arcs = signal([]);
    const notes = signal({});
    const library = signal({});
    const plans = signal([]);
    const bank = signal({});
    const clock = signal({ minutes: 0 });
    const forced = signal([]);
    const workerOptions = computed(() => [
        { value: '', label: 'Any connection (load-balanced)' },
        // Записи подключений из карточки моделей держат поля сигналами (`record.id()`), а не строками: без вызова все
        // пункты получали одно значение — текст функции — и выбрать можно было только последний.
        ...workers().map(worker => {
            const id = String(readField(worker.id) ?? '');
            const model = String(readField(worker.model) ?? '');
            return { value: id, label: model ? `${id} — ${model}` : id };
        }),
    ]);
    const writerOptions = computed(() => [
        { value: '', label: 'SillyTavern connection (no override)' },
        ...workerOptions().slice(1),
    ]);
    const godSettings = createGodSettings(workerOptions);
    const counsellorOptions = computed(() => [
        { value: '', label: 'Resolver connection (default)' },
        ...workerOptions().slice(1),
    ]);
    const directorOptions = computed(() => [
        { value: '', label: 'Resolver connection (default)' },
        ...workerOptions().slice(1),
    ]);
    const psychologistOptions = computed(() => [
        { value: '', label: 'Director connection (default)' },
        ...workerOptions().slice(1),
    ]);
    const backupOptions = computed(() => [
        { value: '', label: 'None' },
        ...workerOptions().slice(1),
    ]);
    const classifierOptions = createClassifierOptions(classifierConnections);
    const presetOptions = computed(() => [
        { value: '', label: 'Custom (do not change on pick)' },
        ...presets().map(preset => ({ value: preset.id, label: preset.name })),
        ...SAMPLER_PRESETS.map(preset => ({ value: preset.id, label: preset.name })),
    ]);
    const regenOptions = [
        { value: 'decider', label: 'Director again (default)' },
        { value: 'writer', label: 'Writer only — reuse the last decision' },
    ];
    const reasoningModeOptions = [
        { value: 'inherit', label: 'Provider default' },
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' },
    ];
    const reasoningEffortOptions = [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
    ];

    function applySettings(value = {}) {
        regen.set(value.regen === 'writer' ? 'writer' : 'decider');
        const readDecider = value.decider ?? {};
        deciderWorkerId.set(String(readDecider.workerId ?? ''));
        decider.samplerPreset.set(String(readDecider.samplerPreset ?? ''));
        decider.temperature.set(Number(readDecider.temperature ?? 0.7));
        decider.topP.set(Number(readDecider.topP ?? 1));
        decider.topK.set(Number(readDecider.topK ?? 0));
        decider.maxTokens.set(Number(readDecider.maxTokens ?? 2000));
        decider.reasoningMode.set(readDecider.reasoningMode ?? 'inherit');
        decider.reasoningEffort.set(readDecider.reasoningEffort ?? 'medium');
        decider.reasoningBudget.set(Number(readDecider.reasoningBudget ?? 0));
        const readWriter = value.writer ?? {};
        writerWorkerId.set(String(readWriter.workerId ?? ''));
        writer.samplerPreset.set(String(readWriter.samplerPreset ?? ''));
        writer.applySampler.set(Boolean(readWriter.applySampler));
        writer.temperature.set(Number(readWriter.temperature ?? 0.9));
        writer.topP.set(Number(readWriter.topP ?? 1));
        writer.topK.set(Number(readWriter.topK ?? 0));
        writer.maxTokens.set(Number(readWriter.maxTokens ?? 1000));
        writer.frequencyPenalty.set(Number(readWriter.frequencyPenalty ?? 0.3));
        maxSteps.set(Number(value.maxSteps ?? 50));
        formTimeoutMs.set(Number(value.formTimeoutMs ?? 180000));
        compressedLimitTokens.set(Number(value.compressedLimitTokens ?? 100000));
        compression.workerId.set(String(value.compression?.workerId ?? ''));
        compression.thresholdTokens.set(Number(value.compression?.thresholdTokens ?? 50000));
        researcherSettings.workerId.set(String(value.researcher?.workerId ?? ''));
        researcherSettings.maxTasks.set(Number(value.researcher?.maxTasks ?? 2));
        researcherSettings.maxSteps.set(Number(value.researcher?.maxSteps ?? 50));
        researcherSettings.bankMaxSteps.set(Number(value.researcher?.bankMaxSteps ?? 20));
        researcherSettings.bankConcurrency.set(Number(value.researcher?.bankConcurrency ?? 4));
        snapshots.set(value.snapshots !== false);
        adaptiveReasoning.set(value.adaptiveReasoning !== false);
        thinkingLimitTokens.set(Number(value.thinkingLimitTokens ?? 2000));
        turnDraft.set(Boolean(value.turnDraft));
        costCounter.set(value.costCounter !== false);
        startOnTyping.set(Boolean(value.startOnTyping));
        implicitAwait.set(Boolean(value.implicitAwait));
        const classifier = value.classifier ?? {};
        classifierConnectionId.set(String(classifier.connectionId ?? ''));
        classifierThreshold.set(Number(classifier.threshold ?? 0.85));
        classifierCheckTokens.set(Number(classifier.checkTokens ?? 150));
        classifierRewriteLimit.set(Number(classifier.rewriteLimit ?? 2));
        const counsellor = value.counsellor ?? {};
        counsellorWorkerId.set(String(counsellor.workerId ?? ''));
        counsellorEveryTurns.set(Number(counsellor.everyTurns ?? 3));
        counsellorMaxSteps.set(Number(counsellor.maxSteps ?? 12));
        const director = value.director ?? {};
        directorWorkerId.set(String(director.workerId ?? ''));
        directorMaxSteps.set(Number(director.maxSteps ?? 10));
        decreeTimeoutMs.set(Number(director.decreeTimeoutMs ?? 120000));
        psychologistWorkerId.set(String(value.psychologist?.workerId ?? ''));
        godSettings.apply(value.god ?? {});
        const retry = value.retry ?? {};
        retryMaxAttempts.set(Number(retry.maxAttempts ?? 3));
        retryTurnBudgetMs.set(Number(retry.turnBudgetMs ?? 120000));
        retryBackgroundBudgetMs.set(Number(retry.backgroundBudgetMs ?? 600000));
        for (const [role, target] of Object.entries(retryBackups)) target.set(String(retry.backups?.[role] ?? ''));
        bootstrapSettings.apply(value.bootstrap);
    }
    function collect() {
        return {
            regen: regen.peek(),
            decider: {
                workerId: deciderWorkerId.peek(), samplerPreset: decider.samplerPreset.peek(),
                temperature: decider.temperature.peek(), topP: decider.topP.peek(), topK: decider.topK.peek(), maxTokens: decider.maxTokens.peek(),
                reasoningMode: decider.reasoningMode.peek(), reasoningEffort: decider.reasoningEffort.peek(), reasoningBudget: decider.reasoningBudget.peek(),
            },
            writer: {
                workerId: writerWorkerId.peek(), samplerPreset: writer.samplerPreset.peek(), applySampler: writer.applySampler.peek(),
                temperature: writer.temperature.peek(), topP: writer.topP.peek(), topK: writer.topK.peek(), maxTokens: writer.maxTokens.peek(), frequencyPenalty: writer.frequencyPenalty.peek(),
            },
            maxSteps: maxSteps.peek(), formTimeoutMs: formTimeoutMs.peek(), compressedLimitTokens: compressedLimitTokens.peek(),
            compression: { workerId: compression.workerId.peek(), thresholdTokens: compression.thresholdTokens.peek() },
            researcher: {
                workerId: researcherSettings.workerId.peek(),
                maxTasks: researcherSettings.maxTasks.peek(), maxSteps: researcherSettings.maxSteps.peek(),
                bankMaxSteps: researcherSettings.bankMaxSteps.peek(), bankConcurrency: researcherSettings.bankConcurrency.peek(),
            },
            snapshots: snapshots.peek(), adaptiveReasoning: adaptiveReasoning.peek(), thinkingLimitTokens: thinkingLimitTokens.peek(),
            turnDraft: turnDraft.peek(), costCounter: costCounter.peek(),
            startOnTyping: startOnTyping.peek(), implicitAwait: implicitAwait.peek(),
            classifier: {
                connectionId: classifierConnectionId.peek(), threshold: classifierThreshold.peek(),
                checkTokens: classifierCheckTokens.peek(), rewriteLimit: classifierRewriteLimit.peek(),
            },
            counsellor: {
                workerId: counsellorWorkerId.peek(), everyTurns: counsellorEveryTurns.peek(), maxSteps: counsellorMaxSteps.peek(),
            },
            director: {
                workerId: directorWorkerId.peek(), maxSteps: directorMaxSteps.peek(), decreeTimeoutMs: decreeTimeoutMs.peek(),
            },
            psychologist: { workerId: psychologistWorkerId.peek() },
            god: godSettings.collect(),
            retry: {
                maxAttempts: retryMaxAttempts.peek(), turnBudgetMs: retryTurnBudgetMs.peek(), backgroundBudgetMs: retryBackgroundBudgetMs.peek(),
                backups: Object.fromEntries(Object.entries(retryBackups).map(([role, target]) => [role, target.peek()])),
            },
            bootstrap: bootstrapSettings.collect(),
        };
    }
    async function save() {
        const answer = await call('decision.configure', { patch: collect() });
        if (!answer.ok) { await notify('error', answer.error?.message ?? 'Could not save decision settings'); return false; }
        applySettings(answer.value);
        await notify('ok', 'Director / Writer settings saved');
        return true;
    }

    function applyPreset(kind, id) {
        const found = [...SAMPLER_PRESETS, ...presets()].find(preset => preset.id === id);
        if (!found) return;
        if (kind === 'decider') {
            decider.samplerPreset.set(found.id);
            decider.temperature.set(found.temperature);
            decider.topP.set(found.topP);
            decider.topK.set(found.topK);
            decider.maxTokens.set(found.maxTokens);
            decider.reasoningMode.set(found.reasoningMode);
            decider.reasoningEffort.set(found.reasoningEffort);
            decider.reasoningBudget.set(found.reasoningBudget);
        } else {
            writer.samplerPreset.set(found.id);
            writer.temperature.set(found.temperature);
            writer.topP.set(found.topP);
            writer.topK.set(found.topK);
            writer.maxTokens.set(found.maxTokens);
        }
    }
    async function loadDecision() {
        const [settings, run, savedPresets, rosterAnswer, planAnswer, arcsAnswer, notesAnswer, libraryAnswer, plansAnswer, bankAnswer, clockAnswer, forcedAnswer, classifierAnswer] = await Promise.all([
            call('decision.settings'), call('decision.lastRun'), call('model.presets.get'),
            call('decision.roster'), call('decision.plan'), call('decision.arcs'), call('decision.notes'),
            call('decision.library'), call('decision.plans'), call('decision.bank'),
            call('decision.clock'), call('summary.forced'), call('classifier.connections.get'),
        ]);
        if (settings.ok) applySettings(settings.value);
        lastRun.set(run.ok ? run.value ?? null : null);
        presets.set(savedPresets.ok ? savedPresets.value ?? [] : []);
        roster.set(rosterAnswer.ok ? rosterAnswer.value ?? { active: [] } : { active: [] });
        plan.set(planAnswer.ok ? planAnswer.value ?? null : null);
        arcs.set(arcsAnswer.ok ? arcsAnswer.value ?? [] : []);
        notes.set(notesAnswer.ok ? notesAnswer.value ?? {} : {});
        library.set(libraryAnswer.ok ? libraryAnswer.value ?? {} : {});
        plans.set(plansAnswer.ok ? plansAnswer.value ?? [] : []);
        bank.set(bankAnswer.ok ? bankAnswer.value ?? {} : {});
        clock.set(clockAnswer.ok ? clockAnswer.value ?? { minutes: 0 } : { minutes: 0 });
        forced.set(forcedAnswer.ok ? forcedAnswer.value ?? [] : []);
        classifierConnections.set(classifierAnswer.ok && Array.isArray(classifierAnswer.value) ? classifierAnswer.value : []);
    }
    function decisionCard() {
        return Card('Director / Writer', { ...collapse.bind('card:decision'), subtitle: 'Every generation: one model decides, another writes' },
            h('small', { class: 'stme-module-hint' }, 'Always on. Without an openai director connection, generation is not sent; this card is opened for you.'),
            Row(Button('Open game settings', openSettings ?? (() => {})), Button('Open director', openDirector ?? (() => {}))),
            h('small', { class: 'stme-module-hint' }, 'The story game is set in one window: Story, Classic or Hardcore, or your own mix. The full prompt editor is one link away under Advanced.'),
            Field('On swipe / regenerate', Select(regen, regenOptions), {
                hint: 'The default asks the director again. "Writer only" reuses the last decision for this chat and only rewrites the prose.',
            }),
            Row(
                Field('Director model connection', Select(deciderWorkerId, workerOptions)),
                Field('Writer model connection', Select(writerWorkerId, writerOptions), {
                    hint: 'The writer request goes to this connection: its endpoint, key and model. Leave it on SillyTavern to keep the ST source.',
                }),
            ),
            Row(
                Field('Counsellor connection', Select(counsellorWorkerId, counsellorOptions), {
                    hint: 'Reads the Ledger between turns and is the only one the user talks to. Empty: the resolver connection, with its own key.',
                }),
                Slider('Counsellor reviews every N turns', counsellorEveryTurns, { min: 1, max: 20, step: 1 }),
            ),
            Row(
                Field('Director connection', Select(directorWorkerId, directorOptions), {
                    hint: 'Issues Decrees from reports. Empty: the resolver connection.',
                }),
                Slider('A Telegram holds the turn for (ms)', decreeTimeoutMs, { min: 1000, max: 600000, step: 1000 }),
            ),
            Row(
                Field('Psychologist connection', Select(psychologistWorkerId, psychologistOptions), {
                    hint: 'Writes psyche.md — what holds a character\'s state and how slowly it moves. Empty: the Director connection.',
                }),
            ),
            godSettings.fields(),
            Details('Director generation settings',
                Row(
                    Field('Preset', Select(decider.samplerPreset, presetOptions, { onChange: id => applyPreset('decider', id) })),
                ),
                Row(
                    Slider('Temperature', decider.temperature, { min: 0, max: 2, step: 0.05 }),
                    Slider('Top P', decider.topP, { min: 0, max: 1, step: 0.01 }),
                    Slider('Top K', decider.topK, { min: 0, max: 200, step: 1 }),
                    Slider('Max tokens', decider.maxTokens, { min: 1, max: 32768, step: 1 }),
                ),
                Row(
                    Field('Reasoning', Select(decider.reasoningMode, reasoningModeOptions)),
                    Field('Effort', Select(decider.reasoningEffort, reasoningEffortOptions)),
                    Slider('Reasoning budget (tokens)', decider.reasoningBudget, { min: 0, max: 32768, step: 64 }),
                ),
            ),
            Details('Writer generation settings',
                Row(
                    Field('Preset', Select(writer.samplerPreset, presetOptions, { onChange: id => applyPreset('writer', id) })),
                    Toggle('Apply writer sampler', writer.applySampler, { hint: 'Off: the request keeps the sampler SillyTavern already set.' }),
                ),
                Row(
                    Slider('Temperature', writer.temperature, { min: 0, max: 2, step: 0.05 }),
                    Slider('Top P', writer.topP, { min: 0, max: 1, step: 0.01 }),
                    Slider('Top K', writer.topK, { min: 0, max: 200, step: 1 }),
                    Slider('Max tokens', writer.maxTokens, { min: 1, max: 32768, step: 1 }),
                    Slider('Repetition penalty', writer.frequencyPenalty, { min: 0, max: 2, step: 0.05 }),
                ),
                h('small', { class: 'stme-module-hint' }, 'The writer never reasons: reasoning is always disabled in its request.'),
            ),
            Details('Limits and background workers',
                Row(
                    Slider('Max steps without await', maxSteps, { min: 1, max: 500, step: 1 }),
                    Slider('Form timeout (ms)', formTimeoutMs, { min: 1000, max: 3600000, step: 1000 }),
                    Slider('Compressed prefix limit (tokens)', compressedLimitTokens, { min: 1000, max: 5000000, step: 10000 }),
                ),
                Row(
                    Field('Compression connection', Select(compression.workerId, workerOptions), { hint: 'Separate model that compresses ordinary memory records. Important records are never compressed.' }),
                    Slider('Compression threshold (tokens per character)', compression.thresholdTokens, { min: 1000, max: 500000, step: 1000 }),
                ),
                Row(
                    Field('Researcher connection', Select(researcherSettings.workerId, workerOptions)),
                    Slider('Research tasks at once', researcherSettings.maxTasks, { min: 1, max: 8, step: 1 }),
                    Slider('Research steps before the report', researcherSettings.maxSteps, { min: 1, max: 200, step: 1 }),
                ),
                Row(
                    Slider('Counsellor steps per wake', counsellorMaxSteps, { min: 1, max: 100, step: 1 }),
                    Slider('Director steps per wake', directorMaxSteps, { min: 1, max: 100, step: 1 }),
                    godSettings.steps(),
                ),
                Row(
                    Slider('Bank builders at once', researcherSettings.bankConcurrency, { min: 1, max: 8, step: 1 }),
                    Slider('Steps per character bank', researcherSettings.bankMaxSteps, { min: 2, max: 60, step: 1 }),
                ),
            ),
            writerCheckSection({ classifierConnectionId, classifierThreshold, classifierCheckTokens, classifierRewriteLimit, classifierOptions }),
            Details('Retries',
                h('small', { class: 'stme-module-hint' }, 'One policy for every role: network, 5xx, 429, timeout and a dropped stream pause 1 / 3 / 8 s; an empty answer is retried once with a larger limit and lower reasoning; two empty answers switch to the backup connection.'),
                Row(
                    Slider('Attempts', retryMaxAttempts, { min: 1, max: 5, step: 1 }),
                    Slider('Turn budget (ms)', retryTurnBudgetMs, { min: 1000, max: 3600000, step: 1000 }),
                    Slider('Background budget (ms)', retryBackgroundBudgetMs, { min: 1000, max: 3600000, step: 1000 }),
                ),
                Row(
                    Field('Resolver backup', Select(retryBackups.resolver, backupOptions)),
                    Field('Writer backup', Select(retryBackups.writer, backupOptions)),
                ),
                Row(
                    Field('Counsellor backup', Select(retryBackups.counsellor, backupOptions)),
                    Field('Director backup', Select(retryBackups.director, backupOptions)),
                ),
                Row(
                    Field('God backup', Select(retryBackups.god, backupOptions)),
                    Field('Bank builder backup', Select(retryBackups.banks, backupOptions)),
                ),
            ),
            bootstrapSettings.section(),
            Details('Turn behaviour',
                Toggle('Snapshots and rollback', snapshots, { hint: 'On: state before every turn is saved; swipe or delete restores it. Off: the state follows every applied form.' }),
                Toggle('Low reasoning on the turn, high between turns', adaptiveReasoning, { hint: 'On: the active cycle asks for low effort, the passive one for high.' }),
                Slider('Cut the turn\'s thinking after (tokens, 0 = never)', thinkingLimitTokens, { min: 0, max: 8000, step: 250 }),
                Toggle('Turn draft', turnDraft, { hint: 'On: the passive cycle may save a draft; if the real form times out, the writer uses the draft instead of cancelling.' }),
                Toggle('Cost counter in the log', costCounter, { hint: 'Show prompt/completion/cached tokens per cycle.' }),
                Toggle('Start on typing', startOnTyping, { hint: 'Off by default. Starts a background draft when the user begins typing; needs Turn draft.' }),
                Toggle('Implicit await', implicitAwait, { hint: 'On: an answer without a tool call ends the cycle as await. Off: the director is reminded to call a tool.' }),
            ),
            Details('Director state',
                h('small', { class: 'stme-module-hint' }, 'Active roster'),
                computed(() => rosterView(roster())),
                h('small', { class: 'stme-module-hint' }, 'Director plan'),
                computed(() => planView(plan())),
                h('small', { class: 'stme-module-hint' }, 'Character library'),
                computed(() => libraryView(library(), plans(), clock())),
            ),
            Details('Memory bank', computed(() => bankView(bank()))),
            Details('Arcs and character notes', computed(() => arcsNotesView(arcs(), notes()))),
            Details('Forced summaries', computed(() => forcedView(forced()))),
            Details('Last decision',
                computed(() => lastRun()?.decision ?? 'No decision yet in this chat.'),
            ),
            Row(Button('Save', save)),
        );
    }

    return { decisionCard, loadDecision, refresh: loadDecision };
}
