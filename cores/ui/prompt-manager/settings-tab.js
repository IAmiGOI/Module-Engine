import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Row, Field, NumberInput, Toggle, Slider, EmptyState, Badge } from '../../../libraries/shared/widgets.js';
import { Select } from './dropdown.js';

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
    const pluginList = signal([]);
    async function loadPlugins() { const answer = await call('promptManager.plugins'); pluginList.set(answer.ok ? answer.value : []); }
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
    // Переопределения: слой (модель / персонаж / чат) → пять самых нужных параметров. По умолчанию выключено.
    const OVERRIDE_KEYS = [['temperature', 'Temperature'], ['top_p', 'Top P'], ['top_k', 'Top K'], ['min_p', 'Min P'], ['openai_max_tokens', 'Max response']];
    const scope = signal('character');
    const context = signal(null);
    const layer = Object.fromEntries(OVERRIDE_KEYS.map(([key]) => [key, signal('')]));
    const overrideOn = signal(Boolean(state.settings().overrides?.enabled));
    const setOverrideOn = overrideOn.set;
    overrideOn.set = value => { setOverrideOn(value); actions.configure({ overrides: { ...(state.settings().overrides ?? {}), enabled: value } }); };
    const keyOf = () => ({ model: context()?.model, character: context()?.char, chat: context()?.chatId })[scope()] ?? '';
    async function loadOverrideContext() {
        const answer = await call('promptManager.context');
        context.set(answer.ok ? answer.value : null);
        const saved = state.settings().overrides?.[{ model: 'byModel', character: 'byCharacter', chat: 'byChat' }[scope()]]?.[keyOf()] ?? {};
        for (const [key] of OVERRIDE_KEYS) layer[key].set(saved[key] ?? '');
    }
    async function saveLayer(clear = false) {
        const params = clear ? {} : Object.fromEntries(OVERRIDE_KEYS.map(([key]) => [key, layer[key]()]).filter(([, value]) => value !== '' && value !== null).map(([key, value]) => [key, Number(value)]));
        await call('promptManager.setOverride', { scope: scope(), key: keyOf(), params });
        const fresh = await call('promptManager.settings');
        if (fresh.ok) await actions.configure({ overrides: fresh.value.overrides });
        if (clear) for (const [key] of OVERRIDE_KEYS) layer[key].set('');
    }
    // Подключения к классификатору (Jev) — не здесь: это отдельная категория моделей, карточка «Classifiers» в основной панели. Здесь только то, что касается сборки запроса.
    const jevWait = signal(Math.round((state.settings().jevWaitMs ?? 4000) / 100) / 10);
    const setJevWait = jevWait.set;
    jevWait.set = next => { setJevWait(next); actions.configure({ jevWaitMs: Math.round(Number(next) * 1000) }); };
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
            h('h4', {}, 'Jev conditions'),
            h('p', { class: 'stme-pm-help' }, 'A block or a divider can be sent only when a classifier (Jev) finds a statement likely enough. The connections are in the Classifiers card of the main panel. If the classifier does not answer in time, the block is sent.'),
            Field('Longest wait for the classifier before sending, s', NumberInput(jevWait, { min: 0.5, max: 20, step: 0.5 })),
            h('h4', {}, 'Overrides (off by default)'),
            Toggle('Use overrides for this model, character or chat', overrideOn),
            Row(Select(scope, [{ value: 'character', label: 'this character' }, { value: 'chat', label: 'this chat' }, { value: 'model', label: 'this model' }], { onChange: () => loadOverrideContext() }), Button('Load current', loadOverrideContext),
                computed(() => (context() ? Badge(keyOf() || 'unknown') : null))),
            h('div', { class: 'stme-pm-grid' }, OVERRIDE_KEYS.map(([key, label]) => Field(label, NumberInput(layer[key], { step: 0.01 })))),
            Row(Button('Save this layer', () => saveLayer(false)), Button('Clear this layer', () => saveLayer(true), { variant: 'danger' })),
            h('p', { class: 'stme-pm-help' }, 'Priority: chat over character over model over the preset. Empty fields keep the preset value.'),
            h('h4', {}, 'Plugins'),
            Row(Button('Refresh plugins', loadPlugins)),
            computed(() => (pluginList().length ? h('div', {}, pluginList().map(plugin => Row(
                h('strong', {}, `${plugin.name} ${plugin.version}`), Badge(plugin.provides.join(', ')),
                plugin.error ? Badge(`switched off: ${plugin.error}`, { tone: 'error' }) : null,
                Button(plugin.enabled ? 'Switch off' : 'Switch on', async () => { await call('promptManager.setPluginEnabled', { id: plugin.id, enabled: !plugin.enabled }); await loadPlugins(); }))))
                : EmptyState('No plugins installed. A plugin adds condition types, macros or prompt transforms and can be swapped without a reload.'))),
            h('h4', {}, 'Versions'),
            Row(Button('Load versions', loadVersions)),
            computed(() => (versions().length ? h('div', {}, versions().map(version => Row(
                h('span', {}, `${new Date(version.at).toLocaleString()} · ${version.label ?? ''}`),
                Button('Roll back', () => actions.rollback(version.key)))))
                : EmptyState('No versions loaded.'))),
        );
    }
    return { tree, loadVersions, loadPlugins };
}
