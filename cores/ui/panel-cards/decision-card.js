import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Card, Toggle, Select, Field, Row, Button, TextArea, Slider, Details } from '../../../libraries/shared/widgets.js';
import { SAMPLER_PRESETS } from '../../models/generate-request.js';

/**
 * Карточка «Director / Writer» на экране настроек движка. Читает и пишет
 * только через контракты `decision.*`, `model.workers.get`,
 * `model.presets.get` — как и остальные карточки панели.
 *
 * Прозаик ризонингом не пользуется никогда (это не настройка, а правило
 * ядра), поэтому у него в карточке нет полей ризонинга вовсе — только
 * сэмплер.
 */
export function createDecisionCard({ call, collapse, notify, workers }) {
    const enabled = signal(false);
    const rules = signal('');
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
    const blocks = signal([]);
    const lastRun = signal(null);
    const presets = signal([]);

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
        enabled.set(Boolean(value.enabled));
        rules.set(String(value.rules ?? ''));
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
    }

    function collect() {
        return {
            enabled: enabled.peek(),
            rules: rules.peek(),
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
        const [settings, storedBlocks, run, savedPresets] = await Promise.all([
            call('decision.settings'), call('decision.blocks'), call('decision.lastRun'), call('model.presets.get'),
        ]);
        if (settings.ok) applySettings(settings.value);
        blocks.set(storedBlocks.ok ? storedBlocks.value ?? [] : []);
        lastRun.set(run.ok ? run.value ?? null : null);
        presets.set(savedPresets.ok ? savedPresets.value ?? [] : []);
    }

    function blockList() {
        const list = blocks();
        if (!list.length) return h('small', { class: 'stme-module-hint' }, 'No character blocks yet — the director adds them as the story goes.');
        return h('div', { class: 'stme-decision-blocks' }, list.map(block => h('div', { class: 'stme-decision-block' },
            h('strong', {}, block.title ?? 'Untitled'),
            h('div', {}, block.text ?? ''))));
    }

    function decisionCard() {
        return Card('Director / Writer', { ...collapse.bind('card:decision'), subtitle: 'One model decides, another writes' },
            Toggle('Enabled', enabled, { hint: 'Off by default. While off, no stage is registered and generation is exactly as before.', onChange: () => { save(); } }),
            Field('Director rules', TextArea(rules, { rows: 4, placeholder: 'Rules the director always follows, e.g. "Never kill a named character."' }), {
                hint: 'Written by you, appended to the director prompt before everything else.',
            }),
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
                    Toggle('Apply writer sampler', writer.applySampler, { hint: 'Off: the request keeps the sampler SillyTavern/Prompt Manager already set.' }),
                ),
                Row(
                    Slider('Temperature', writer.temperature, { min: 0, max: 2, step: 0.05 }),
                    Slider('Top P', writer.topP, { min: 0, max: 1, step: 0.01 }),
                    Slider('Top K', writer.topK, { min: 0, max: 200, step: 1 }),
                    Slider('Max tokens', writer.maxTokens, { min: 1, max: 32768, step: 1 }),
                ),
                h('small', { class: 'stme-module-hint' }, 'The writer never reasons: reasoning is always disabled in its request.'),
            ),
            Details('Character blocks',
                h('small', { class: 'stme-module-hint' }, 'Maintained by the director; the writer sees them every turn.'),
                blockList(),
            ),
            Details('Last decision',
                computed(() => lastRun()?.decision ?? 'No decision yet in this chat.'),
            ),
            Row(Button('Save', save)),
        );
    }

    return { decisionCard, loadDecision, refresh: loadDecision };
}
