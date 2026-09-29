import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Field, NumberInput, Toggle, Select, Slider, EmptyState } from '../../../libraries/shared/widgets.js';

const REASONING = [{ value: 'auto', label: 'auto' }, { value: 'min', label: 'min' }, { value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }, { value: 'max', label: 'max' }];

/** Числовые параметры генерации пресета: имя ST, подпись, границы. */
const NUMBERS = [
    ['temperature', 'Temperature', 0, 5, 0.01], ['top_p', 'Top P', 0, 1, 0.01], ['top_k', 'Top K', 0, 500, 1], ['top_a', 'Top A', 0, 1, 0.01], ['min_p', 'Min P', 0, 1, 0.01],
    ['frequency_penalty', 'Frequency penalty', -2, 2, 0.01], ['presence_penalty', 'Presence penalty', -2, 2, 0.01], ['repetition_penalty', 'Repetition penalty', 0, 3, 0.01],
    ['openai_max_context', 'Max context (tokens)', 512, 2000000, 256], ['openai_max_tokens', 'Max response (tokens)', 16, 200000, 16], ['seed', 'Seed (-1 = random)', -1, 2147483647, 1],
];

/** Вкладка «Settings»: параметры самого PM, параметры генерации активного пресета, версии пресета с откатом. */
export function createSettingsTab({ state, actions, call }) {
    const versions = signal([]);
    async function loadVersions() {
        const id = state.activeId.peek();
        const answer = id ? await call('promptManager.versions', { presetId: id }) : null;
        versions.set(answer?.ok ? answer.value : []);
    }

    const paramSignal = key => {
        const value = signal(state.preset.peek()?.params?.[key] ?? '');
        const set = value.set;
        value.set = next => { set(next); actions.patch(preset => { preset.params[key] = next === '' ? undefined : Number(next); }); };
        return value;
    };
    const flagSignal = key => {
        const value = signal(Boolean(state.preset.peek()?.params?.[key]));
        const set = value.set;
        value.set = next => { set(next); actions.patch(preset => { preset.params[key] = next; }); };
        return value;
    };
    const reasoning = (() => {
        const value = signal(state.preset.peek()?.params?.reasoning_effort ?? 'auto');
        const set = value.set;
        value.set = next => { set(next); actions.patch(preset => { preset.params.reasoning_effort = next; }); };
        return value;
    })();
    const headroom = signal(Math.round((state.settings().headroom ?? 0.1) * 100));
    const setHeadroom = headroom.set;
    headroom.set = next => { setHeadroom(next); actions.configure({ headroom: next / 100 }); };

    function tree() {
        return h('div', { class: 'stme-pm-settings' },
            h('h4', {}, 'Prompt Manager'),
            Toggle('Freeze random macros per chat (keeps the prefix cache)', signal(state.settings().freezeRandom !== false), { onChange: value => actions.configure({ freezeRandom: value }) }),
            Toggle('Apply sampler values from the preset to the request', signal(state.settings().applyParams !== false), { onChange: value => actions.configure({ applyParams: value }) }),
            Slider('Trimming headroom (%) — extra cut at once, so later turns do not move the start of the history', headroom, { min: 0, max: 40, step: 1 }),
            h('h4', {}, 'Generation parameters of this preset'),
            computed(() => (state.preset() ? h('div', {},
                h('div', { class: 'stme-pm-grid' }, NUMBERS.map(([key, label, min, max, step]) => Field(label, NumberInput(paramSignal(key), { min, max, step })))),
                Field('Reasoning effort', Select(reasoning, REASONING)),
                Toggle('Streaming', flagSignal('stream_openai')), Toggle('Show reasoning', flagSignal('show_thoughts')),
                Toggle('Function calling', flagSignal('function_calling')), Toggle('Squash system messages', flagSignal('squash_system_messages')),
                Toggle('Unlocked context', flagSignal('max_context_unlocked')),
            ) : EmptyState('Select a preset first.'))),
            h('h4', {}, 'Versions'),
            Row(Button('Load versions', loadVersions)),
            computed(() => (versions().length ? h('div', {}, versions().map(version => Row(
                h('span', {}, `${new Date(version.at).toLocaleString()} · ${version.label ?? ''}`),
                Button('Roll back', () => actions.rollback(version.key)))))
                : EmptyState('No versions loaded.'))),
        );
    }
    return { tree, loadVersions };
}
