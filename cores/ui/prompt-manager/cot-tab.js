import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Field, TextInput, TextArea, NumberInput, Toggle, Badge, EmptyState } from '../../../libraries/shared/widgets.js';
import { Select } from './dropdown.js';
import { normalizeCot } from '../../../libraries/core/pm-cot.js';
import { createTextBlock } from './tree-model.js';
import { ConditionBuilder } from './condition-builder.js';

const MODES = [{ value: 'always', label: 'every generation' }, { value: 'trigger', label: 'when a condition is true' }, { value: 'manual', label: 'only when I press the button' }];
const INJECT = [{ value: 'system', label: 'system message' }, { value: 'user', label: 'user message' }];
const DISPLAY = [{ value: 'small', label: 'small: "thinking: step 2 of 4"' }, { value: 'extended', label: 'extended: step titles and text as they come' }];
const REGEN = [{ value: 'all', label: 'the whole chain again' }, { value: 'final', label: 'only the final answer' }];

/** Вкладка «CoT»: скрытая цепочка рассуждений (Guided CoT) — шаги-промпты, модель на шаг, условия запуска, вид и повтор. */
export function createCotTab({ state, actions, call }) {
    const workers = signal([]);
    const records = signal({});

    async function refresh() {
        const answer = await call('model.workers.get');
        workers.set(answer.ok ? answer.value ?? [] : []);
        const saved = await call('promptManager.cotRecords');
        records.set(saved.ok ? saved.value ?? {} : {});
    }

    const ensure = preset => { preset.cot = normalizeCot(preset.cot); return preset.cot; };
    const setCot = (key, value) => actions.patch(preset => { ensure(preset)[key] = value; });
    const bound = (key, initial) => {
        const value = signal(initial);
        const set = value.set;
        value.set = next => { set(next); setCot(key, next); };
        return value;
    };
    const workerOptions = () => [{ value: '', label: 'main connection of SillyTavern' }, ...workers().map(worker => ({ value: worker.id, label: worker.name || worker.id }))];

    function stepRow(node, index, preset) {
        const block = preset.blocks.find(item => item.id === node.block);
        if (!block) return null;
        const cot = preset.cot;
        const worker = signal(cot.stepWorkers?.[block.id] ?? '');
        const setWorker = worker.set;
        worker.set = value => { setWorker(value); actions.patch(p => { ensure(p).stepWorkers[block.id] = value || undefined; }); };
        const name = signal(block.name ?? '');
        const setName = name.set;
        name.set = value => { setName(value); actions.patch(p => { const b = p.blocks.find(item => item.id === block.id); if (b) b.name = value; }); };
        const text = signal(block.content ?? '');
        const setText = text.set;
        text.set = value => { setText(value); actions.patch(p => { const b = p.blocks.find(item => item.id === block.id); if (b) b.content = value; }); };
        return h('div', { class: 'stme-pm-rule' },
            h('div', { class: 'stme-pm-rule-head' }, h('strong', {}, `Step ${index + 1}`),
                Row(Button('↑', () => moveStep(index, -1)), Button('↓', () => moveStep(index, 1)), Button('Remove', () => removeStep(index), { variant: 'danger' }))),
            Field('Name', TextInput(name)),
            Field('What the model is asked at this step (sent as a user message)', TextArea(text, { rows: 5 })),
            Field('Model for this step', Select(worker, workerOptions)),
        );
    }

    function addStep() {
        const { block, node } = createTextBlock({ name: 'New step', role: 'user', content: '' });
        actions.edit(preset => { preset.blocks.push(block); ensure(preset).steps.push(node); });
    }
    function removeStep(index) {
        actions.edit(preset => { const [node] = ensure(preset).steps.splice(index, 1); preset.blocks = preset.blocks.filter(block => block.id !== node?.block); });
    }
    function moveStep(index, delta) {
        actions.edit(preset => {
            const steps = ensure(preset).steps;
            const to = index + delta;
            if (to >= 0 && to < steps.length) [steps[index], steps[to]] = [steps[to], steps[index]];
        });
    }

    function recordsView() {
        return computed(() => {
            const entries = Object.entries(records()).sort((a, b) => Number(b[0]) - Number(a[0]));
            if (!entries.length) return EmptyState('No saved thinking in this chat yet.');
            return h('div', {}, entries.map(([index, record]) => h('details', {},
                h('summary', {}, `Message #${index} · ${new Date(record.at).toLocaleString()} · ${record.steps.length} steps`),
                record.steps.map(step => h('div', { class: 'stme-pm-message' }, h('strong', {}, step.name), h('pre', {}, step.text), step.reasoning ? h('pre', {}, `reasoning: ${step.reasoning}`) : null)))));
        });
    }

    function tree() {
        return h('div', { class: 'stme-pm-cot' }, computed(() => {
            const preset = state.preset();
            if (!preset) return EmptyState('Select a preset first.');
            const cot = normalizeCot(preset.cot);
            const mode = bound('mode', cot.mode);
            return h('div', { class: 'stme-pm-editor' },
                h('p', { class: 'stme-pm-help' }, 'Guided CoT: hidden steps that run before the answer. Every step is a separate request; the result goes into the final prompt after the whole history, and the thinking is kept with the message in a collapsed form.'),
                Toggle('Guided CoT enabled (off by default)', bound('enabled', cot.enabled)),
                Field('Run', Select(mode, MODES)),
                computed(() => (mode() === 'trigger' ? ConditionBuilder({ plugins: state.pluginTypes(), getCondition: () => (preset.cot ?? cot).condition ?? null, setCondition: condition => setCot('condition', condition) }) : null)),
                Row(Button('Run on the next generation', () => call('promptManager.runCotNext')), Button('Refresh', refresh)),
                h('h4', {}, 'Steps'),
                cot.steps.length ? cot.steps.map((node, index) => stepRow(node, index, { ...preset, cot })) : EmptyState('No steps yet.'),
                Button('+ Add step', addStep),
                h('h4', {}, 'Options'),
                Row(Field('Answer limit per step (tokens)', NumberInput(bound('stepMaxTokens', cot.stepMaxTokens), { min: 100, max: 8000, step: 100 })), Field('Retries of a failed step', NumberInput(bound('retries', cot.retries), { min: 0, max: 3 }))),
                Field('Put the result into the final prompt as', Select(bound('injectAs', cot.injectAs), INJECT)),
                Field('While generating show', Select(bound('display', cot.display), DISPLAY)),
                Field('On regenerate or swipe run', Select(bound('regen', cot.regen), REGEN)),
                h('h4', {}, 'Saved thinking of this chat'),
                recordsView(),
            );
        }));
    }
    return { tree, refresh };
}
