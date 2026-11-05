import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { Segment } from '../../../libraries/shared/widgets.js';

/**
 * Опции группами: сегменты и одна строка последствия. Опция, отличная от
 * основы набор (у Custom основа — Classic), помечается точкой, подписью
 * «changed from …» и своим сбросом — видно, что именно сделало Custom.
 */
export function optionGroups({ groups, options, signalFor, baseFor, baseLabel, onSet, onReset }) {
    return groups.map(group => h('section', { class: 'stme-gs-group', key: group.id },
        h('h3', { class: 'stme-gs-group-title' }, group.title),
        ...options.filter(option => option.group === group.id).map(option => optionRow(option, { signalFor, baseFor, baseLabel, onSet, onReset }))));
}

function optionRow(option, { signalFor, baseFor, baseLabel, onSet, onReset }) {
    const value = signalFor(option.id);
    const changed = computed(() => value() !== baseFor()[option.id]);
    return h('div', {
        class: computed(() => (changed() ? 'stme-gs-option stme-gs-option-changed' : 'stme-gs-option')),
        key: option.id,
    },
        h('div', { class: 'stme-gs-option-head' },
            h('span', { class: 'stme-gs-option-title' }, option.title),
            computed(() => (changed() ? h('span', { class: 'stme-gs-changed' }, `• changed from ${baseLabel()}`) : null))),
        Segment(option.values.map(item => ({ value: item.value, label: item.label })), value, {
            label: option.title,
            onChange: next => onSet(option.id, next),
        }),
        h('div', { class: 'stme-gs-option-foot' },
            computed(() => h('small', { class: 'stme-gs-note' }, option.values.find(item => item.value === value())?.note ?? '')),
            computed(() => (changed()
                ? h('button', { type: 'button', class: 'stme-gs-reset-option', 'on:click': () => onReset(option.id) }, 'Reset this option')
                : null))));
}
