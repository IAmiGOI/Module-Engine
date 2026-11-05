import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { Button, Row, TextInput } from '../../../libraries/shared/widgets.js';

/**
 * Ряд сохранённых наборов под режимами. Плитка совпавшего набора
 * подсвечивается сама (как режим по набору), переименование и удаление — на
 * самой плитке, обновление — отдельной кнопкой для последнего применённого.
 */
export function mixesRow({
    mixes, matchedId, activeId, editing, nameSignal, atLimit,
    onApply, onRename, onRemove, onSaveNew, onUpdate, onSaveName, onCancelName,
}) {
    return h('div', { class: 'stme-gs-mixes' },
        h('div', { class: 'stme-gs-mixes-head' },
            h('span', { class: 'stme-gs-group-title' }, 'Saved mixes'),
            Button('Save as mix…', onSaveNew, { disabled: atLimit })),
        computed(() => (mixes().length
            ? h('div', { class: 'stme-gs-mix-row' }, ...mixes().map(mix => mixTile(mix, { matchedId, onApply, onRename, onRemove })))
            : h('small', { class: 'stme-gs-note' }, 'No saved mixes yet.'))),
        computed(() => (activeId() ? Button('Update mix', onUpdate) : null)),
        computed(() => (editing()
            ? h('div', { class: 'stme-gs-mix-editor' },
                TextInput(nameSignal, { placeholder: 'Mix name' }),
                Row(Button('Save', onSaveName), Button('Cancel', onCancelName)))
            : null)),
        computed(() => (atLimit() ? h('small', { class: 'stme-gs-note' }, 'At most 8 mixes can be saved.') : null)));
}

function mixTile(mix, { matchedId, onApply, onRename, onRemove }) {
    return h('div', {
        key: mix.id,
        class: computed(() => (mix.id === matchedId() ? 'stme-gs-mix stme-gs-mix-active' : 'stme-gs-mix')),
    },
        h('button', { type: 'button', class: 'stme-gs-mix-name', 'on:click': () => onApply(mix.id) }, mix.name),
        h('button', {
            type: 'button', class: 'stme-gs-mix-icon', title: 'Rename',
            'aria-label': `Rename ${mix.name}`, 'on:click': () => onRename(mix.id),
        }, '✎'),
        h('button', {
            type: 'button', class: 'stme-gs-mix-icon', title: 'Remove',
            'aria-label': `Remove ${mix.name}`, 'on:click': () => onRemove(mix.id),
        }, '×'));
}
