import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Card, Toggle, Select, Field, Row, Button, Slider, Details } from '../../../libraries/shared/widgets.js';
import { SAMPLER_PRESETS } from '../../models/generate-request.js';
import { rosterView, planView, libraryView, bankView, arcsNotesView, researchView, forcedView, logView } from './decision-views.js';

/**
 * Карточка «Director / Writer» на экране настроек движка. Читает и пишет
 * только через контракты `decision.*`, `model.workers.get`,
 * `model.presets.get` — как и остальные карточки панели.
 *
 * Прозаик ризонингом не пользуется никогда (это не настройка, а правило
 * ядра), поэтому у него в карточке нет полей ризонинга вовсе — только
 * сэмплер.
 */
export function createDecisionCard({ call, collapse, notify, workers, openPrompts }) {
    const regen = signal('decider');
    const deciderWorkerId = signal('');
    const writerWorkerId = signal('');
    const decider = {
        samplerPreset: signal(''), temperature: signal(0.7), topP: signal(1), topK: signal(0), maxTokens: signal(2000),
        reasoningMode: signal('inherit'), reasoningEffort: signal('medium'), reasoningBudget: signal(0),
    };
    const writer = {
        samplerPreset: signal(''), applySampler: signal(false),
        temperature: signal(0.9), topP: signal(1), topK: signal(0), maxTokens: signal(1000),
    };
    const lastRun = signal(null);
    const presets = signal([]);
    const maxSteps = signal(50);
    const formTimeoutMs = signal(180000);
    const logLimitTokens = signal(500000);
    const compression = { workerId: signal(''), thresholdTokens: signal(50000) };
    const researcherSettings = { workerId: signal(''), maxTasks: signal(2), maxSteps: signal(50) };
    const snapshots = signal(true);
    const adaptiveReasoning = signal(true);
    const turnDraft = signal(false);
    const costCounter = signal(true);
    const startOnTyping = signal(false);
    const implicitAwait = signal(false);
    const roster = signal({ active: [] });
    const plan = signal(null);
    const arcs = signal([]);
    const notes = signal({});
    const library = signal({});
    const plans = signal([]);
    const bank = signal({});
    const research = signal([]);
    const clock = signal({ minutes: 0 });
    const log = signal([]);
    const forced = signal([]);

    const workerOptions = computed(() => [
        { value: '', label: 'Any connection (load-balanced)' },
        ...workers().map(worker => ({ value: worker.id, label: worker.name ? `${worker.name} (${worker.id})` : worker.id })),
    ]);
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
        maxSteps.set(Number(value.maxSteps ?? 50));
        formTimeoutMs.set(Number(value.formTimeoutMs ?? 180000));
        logLimitTokens.set(Number(value.logLimitTokens ?? 500000));
        compression.workerId.set(String(value.compression?.workerId ?? ''));
        compression.thresholdTokens.set(Number(value.compression?.thresholdTokens ?? 50000));
        researcherSettings.workerId.set(String(value.researcher?.workerId ?? ''));
        researcherSettings.maxTasks.set(Number(value.researcher?.maxTasks ?? 2));
        researcherSettings.maxSteps.set(Number(value.researcher?.maxSteps ?? 50));
        snapshots.set(value.snapshots !== false);
        adaptiveReasoning.set(value.adaptiveReasoning !== false);
        turnDraft.set(Boolean(value.turnDraft));
        costCounter.set(value.costCounter !== false);
        startOnTyping.set(Boolean(value.startOnTyping));
        implicitAwait.set(Boolean(value.implicitAwait));
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
                temperature: writer.temperature.peek(), topP: writer.topP.peek(), topK: writer.topK.peek(), maxTokens: writer.maxTokens.peek(),
            },
            maxSteps: maxSteps.peek(), formTimeoutMs: formTimeoutMs.peek(), logLimitTokens: logLimitTokens.peek(),
            compression: { workerId: compression.workerId.peek(), thresholdTokens: compression.thresholdTokens.peek() },
            researcher: {
                workerId: researcherSettings.workerId.peek(),
                maxTasks: researcherSettings.maxTasks.peek(), maxSteps: researcherSettings.maxSteps.peek(),
            },
            snapshots: snapshots.peek(), adaptiveReasoning: adaptiveReasoning.peek(),
            turnDraft: turnDraft.peek(), costCounter: costCounter.peek(),
            startOnTyping: startOnTyping.peek(), implicitAwait: implicitAwait.peek(),
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
        const [settings, run, savedPresets, rosterAnswer, planAnswer, arcsAnswer, notesAnswer, libraryAnswer, plansAnswer, bankAnswer, researchAnswer, clockAnswer, logAnswer, forcedAnswer] = await Promise.all([
            call('decision.settings'), call('decision.lastRun'), call('model.presets.get'),
            call('decision.roster'), call('decision.plan'), call('decision.arcs'), call('decision.notes'),
            call('decision.library'), call('decision.plans'), call('decision.bank'), call('decision.research'),
            call('decision.clock'), call('decision.log'), call('summary.forced'),
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
        research.set(researchAnswer.ok ? researchAnswer.value ?? [] : []);
        clock.set(clockAnswer.ok ? clockAnswer.value ?? { minutes: 0 } : { minutes: 0 });
        log.set(logAnswer.ok ? logAnswer.value ?? [] : []);
        forced.set(forcedAnswer.ok ? forcedAnswer.value ?? [] : []);
    }

    function decisionCard() {
        return Card('Director / Writer', { ...collapse.bind('card:decision'), subtitle: 'Every generation: one model decides, another writes' },
            h('small', { class: 'stme-module-hint' }, 'Always on. Without an openai director connection, generation is not sent; this card is opened for you.'),
            Row(Button('Open prompts', openPrompts ?? (() => {}))),
            h('small', { class: 'stme-module-hint' }, 'Two sections in one window, like Prompt Manager: the built-in instructions are locked, and your own prompts move only inside their block. The director block sits two cycles before the end; the writer block sits five messages before the end.'),
            Field('On swipe / regenerate', Select(regen, regenOptions), {
                hint: 'The default asks the director again. "Writer only" reuses the last decision for this chat and only rewrites the prose.',
            }),
            Row(
                Field('Director model connection', Select(deciderWorkerId, workerOptions)),
                Field('Writer model connection', Select(writerWorkerId, workerOptions), {
                    hint: 'The writer model id is applied inside the SillyTavern request; the endpoint and key still belong to that connection.',
                }),
            ),
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
                ),
                h('small', { class: 'stme-module-hint' }, 'The writer never reasons: reasoning is always disabled in its request.'),
            ),
            Details('Limits and background workers',
                Row(
                    Slider('Max steps without await', maxSteps, { min: 1, max: 500, step: 1 }),
                    Slider('Form timeout (ms)', formTimeoutMs, { min: 1000, max: 3600000, step: 1000 }),
                    Slider('Log limit (tokens)', logLimitTokens, { min: 1000, max: 5000000, step: 10000 }),
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
            ),
            Details('Turn behaviour',
                Toggle('Snapshots and rollback', snapshots, { hint: 'On: state before every turn is saved; swipe or delete restores it. Off: the state follows every applied form.' }),
                Toggle('Low reasoning on the turn, high between turns', adaptiveReasoning, { hint: 'On: the active cycle asks for low effort, the passive one for high.' }),
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
            Details('Researcher reports', computed(() => researchView(research()))),
            Details('Forced summaries', computed(() => forcedView(forced()))),
            Details('Last decision',
                computed(() => lastRun()?.decision ?? 'No decision yet in this chat.'),
            ),
            Details('Director log (never shown in chat)',
                h('small', { class: 'stme-module-hint' }, 'Cycles, tool calls with their comments, forms, push, researcher reports and warnings.'),
                computed(() => logView(log())),
            ),
            Row(Button('Save', save)),
        );
    }

    return { decisionCard, loadDecision, refresh: loadDecision };
}
