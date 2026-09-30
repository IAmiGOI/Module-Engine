import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button } from '../../../libraries/shared/widgets.js';
import { Select } from './dropdown.js';
import { LEAF_TYPES, describeCondition, newLeaf, newGroup, ensureRoot, updateAt, addTo, removeAt, normalizeCondition } from './condition-model.js';

const bound = (initial, commit) => { const value = signal(initial); const set = value.set; value.set = next => { set(next); commit(next); }; return value; };

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
            return Select(bound(value, onChange), spec.options.map(([optionValue, text]) => ({ value: optionValue, label: text })));
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
        const typeSelect = Select(bound(group.type, type => commit(updateAt(root.peek(), path, { type }))), [
            { value: 'all', label: 'All of these must be true' },
            { value: 'any', label: 'Any of these is enough' },
        ]);
        // Не постоянное значение, а разовое действие: после выбора возвращается к плейсхолдеру «+ Add a rule…».
        const addValue = signal('');
        const addSelect = Select(addValue, [
            { value: '', label: '+ Add a rule…' },
            ...Object.entries(LEAF_TYPES).map(([type, meta]) => ({ value: type, label: meta.label })),
            ...plugins.map(type => ({ value: type, label: `Plugin: ${type}` })),
            { value: '__group', label: 'A nested group of rules' },
        ], {
            onChange: type => {
                addValue.set('');
                if (type === '__group') commit(addTo(root.peek(), path, newGroup('any')));
                else if (type) commit(addTo(root.peek(), path, plugins.includes(type) ? { type } : newLeaf(type)));
            },
        });
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
