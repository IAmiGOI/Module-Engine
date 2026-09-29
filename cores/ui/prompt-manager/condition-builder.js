import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button } from '../../../libraries/shared/widgets.js';
import { LEAF_TYPES, describeCondition, newLeaf, newGroup, ensureRoot, updateAt, addTo, removeAt, normalizeCondition } from './condition-model.js';

/**
 * Визуальный конструктор условий: правила читаются как предложения, собираются кнопками, без кода. Значения полей
 * применяются по `change` (уход из поля / Enter), чтобы форма не перерисовывалась под курсором.
 *   getCondition() / setCondition(condition|null) — где условие хранится; `plugins` — имена типов правил от плагинов.
 */
export function ConditionBuilder({ getCondition, setCondition, plugins = [] }) {
    const root = signal(ensureRoot(getCondition()));
    const commit = next => { root.set(next); setCondition(normalizeCondition(next)); };

    function field(spec, value, onChange) {
        if (spec.kind === 'select') {
            return h('select', { class: 'text_pole', 'on:change': event => onChange(event.target.value) },
                spec.options.map(([optionValue, text]) => h('option', { value: optionValue, selected: optionValue === value }, text)));
        }
        if (spec.kind === 'number') return h('input', { class: 'text_pole stme-number', type: 'number', min: spec.min, max: spec.max, value: String(value ?? ''), 'on:change': event => onChange(Number(event.target.value)) });
        if (spec.kind === 'words') return h('input', { class: 'text_pole', type: 'text', value: (value ?? []).join(', '), 'on:change': event => onChange(event.target.value.split(',').map(word => word.trim()).filter(Boolean)) });
        return h('input', { class: 'text_pole', type: 'text', value: String(value ?? ''), 'on:change': event => onChange(event.target.value) });
    }

    function leafView(leaf, path) {
        const meta = LEAF_TYPES[leaf.type];
        return h('div', { class: 'stme-pm-rule' },
            h('div', { class: 'stme-pm-rule-head' }, h('strong', {}, meta?.label ?? `Plugin: ${leaf.type}`), Button('Remove', () => commit(removeAt(root.peek(), path)), { variant: 'danger' })),
            ...(meta?.fields ?? []).map(spec => h('label', { class: 'stme-pm-rule-field' }, h('span', {}, spec.label), field(spec, leaf[spec.key], value => commit(updateAt(root.peek(), path, { [spec.key]: value }))))),
            h('div', { class: 'stme-pm-rule-sentence' }, `→ ${describeCondition(leaf)}`),
        );
    }

    function groupView(group, path) {
        const typeSelect = h('select', { class: 'text_pole', 'on:change': event => commit(updateAt(root.peek(), path, { type: event.target.value })) },
            h('option', { value: 'all', selected: group.type === 'all' }, 'All of these must be true'),
            h('option', { value: 'any', selected: group.type === 'any' }, 'Any of these is enough'));
        const addSelect = h('select', { class: 'text_pole', 'on:change': event => {
            const type = event.target.value;
            event.target.value = '';
            if (type === '__group') commit(addTo(root.peek(), path, newGroup('any')));
            else if (type) commit(addTo(root.peek(), path, plugins.includes(type) ? { type } : newLeaf(type)));
        } },
        h('option', { value: '' }, '+ Add a rule…'),
        ...Object.entries(LEAF_TYPES).map(([type, meta]) => h('option', { value: type }, meta.label)),
        ...plugins.map(type => h('option', { value: type }, `Plugin: ${type}`)),
        h('option', { value: '__group' }, 'A nested group of rules'));
        return h('div', { class: 'stme-pm-rulegroup' },
            h('div', { class: 'stme-pm-rule-head' }, typeSelect, path.length ? Button('Remove group', () => commit(removeAt(root.peek(), path)), { variant: 'danger' }) : null),
            (group.items ?? []).map((item, index) => (item.type === 'all' || item.type === 'any' ? groupView(item, [...path, index]) : leafView(item, [...path, index]))),
            addSelect,
        );
    }

    return h('div', { class: 'stme-pm-condition' },
        computed(() => groupView(root(), [])),
        h('div', { class: 'stme-pm-rule-sentence' }, computed(() => `Sent when: ${describeCondition(normalizeCondition(root()))}`)));
}
