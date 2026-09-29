import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Select, Toggle, Badge, EmptyState, IconButton } from '../../../libraries/shared/widgets.js';
import { flattenRows, toggleAt, removeAt, moveNode, stepNode, createTextBlock, createWrapperGroup, createNote, unusedBlockIds } from './tree-model.js';
import { createNodeEditor } from './editor.js';

const samePath = (a, b) => Boolean(a && b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Вкладка «Order»: дерево промптов пресета — перетаскивание, вкл/выкл, свёртка групп, добавление блоков, редактор выбранного.
 * Работает с ЧЕРНОВИКОМ пресета в памяти окна (`state.preset`); на диск он уходит кнопкой Save (`actions.save`).
 */
export function createOrderTab({ state, actions }) {
    const selected = signal(null);
    const collapsed = signal(new Set());
    const drop = signal(null); // { key, where } — подсветка места сброса
    let dragging = null;

    const editor = createNodeEditor({
        getPreset: () => state.preset.peek(),
        patch: mutator => actions.patch(mutator),
        resetContribution: node => actions.resetContribution(node),
    });

    const setTree = updater => actions.edit(preset => { preset.tree = updater(preset.tree); });

    function dropWhere(event, row) {
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - box.top) / Math.max(box.height, 1);
        if (row.node.type === 'group' && ratio > 0.3 && ratio < 0.7) return 'inside';
        return ratio < 0.5 ? 'before' : 'after';
    }

    function rowView(row) {
        const isSelected = samePath(selected(), row.path);
        const dropMark = drop()?.key === row.key ? ` stme-pm-drop-${drop().where}` : '';
        return h('div', {
            class: `stme-pm-row stme-pm-kind-${row.kind}${isSelected ? ' stme-pm-selected' : ''}${row.node.enabled === false ? ' stme-pm-off' : ''}${dropMark}`,
            style: { paddingLeft: `${8 + row.depth * 18}px` },
            draggable: 'true',
            'on:dragstart': event => { dragging = row.path; event.dataTransfer?.setData('text/plain', row.key); },
            'on:dragover': event => { event.preventDefault(); drop.set({ key: row.key, where: dropWhere(event, row) }); },
            'on:dragleave': () => { if (drop.peek()?.key === row.key) drop.set(null); },
            'on:drop': event => {
                event.preventDefault();
                const where = dropWhere(event, row);
                drop.set(null);
                if (dragging) setTree(tree => moveNode(tree, dragging, row.path, where));
                dragging = null;
            },
            'on:click': () => selected.set(row.path),
        },
        row.hasChildren ? IconButton(row.collapsed ? '▸' : '▾', event => {
            event.stopPropagation();
            const next = new Set(collapsed.peek());
            if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
            collapsed.set(next);
        }, { title: 'Collapse or expand' }) : h('span', { class: 'stme-pm-spacer' }),
        h('input', { type: 'checkbox', checked: row.node.enabled !== false, title: 'Send this to the model', 'on:click': event => event.stopPropagation(), 'on:change': () => setTree(tree => toggleAt(tree, row.path)) }),
        h('span', { class: 'stme-pm-label' }, row.label),
        row.detail ? h('span', { class: 'stme-pm-detail' }, row.detail) : null,
        h('span', { class: 'stme-pm-actions' },
            IconButton('↑', event => { event.stopPropagation(); setTree(tree => stepNode(tree, row.path, -1)); }, { title: 'Move up' }),
            IconButton('↓', event => { event.stopPropagation(); setTree(tree => stepNode(tree, row.path, 1)); }, { title: 'Move down' }),
            row.kind === 'marker' ? null : IconButton('✕', event => { event.stopPropagation(); removeRow(row); }, { title: 'Remove' })),
        );
    }

    function removeRow(row) {
        actions.edit(preset => {
            preset.tree = removeAt(preset.tree, row.path);
            const drop = new Set(unusedBlockIds(preset.tree, preset.blocks));
            preset.blocks = preset.blocks.filter(block => !drop.has(block.id));
        });
        selected.set(null);
    }

    function addPrompt() {
        const { block, node } = createTextBlock({});
        actions.edit(preset => { preset.blocks.push(block); preset.tree.push(node); });
        selected.set([state.preset().tree.length - 1]);
    }
    function addGroup() {
        const group = createWrapperGroup('section');
        actions.edit(preset => { preset.blocks.push(...group.blocks); preset.tree.push(group.node); });
        selected.set([state.preset().tree.length - 1]);
    }
    function addNote() {
        actions.edit(preset => { preset.tree.push(createNote('Note')); });
        selected.set([state.preset().tree.length - 1]);
    }

    function tree() {
        return h('div', { class: 'stme-pm-order' },
            h('div', { class: 'stme-pm-toolbar' },
                Select(state.activeId, state.presetOptions, { onChange: id => actions.selectPreset(id) }),
                Toggle('Prompt Manager on', state.enabled, { onChange: value => actions.configure({ enabled: value }) }),
                computed(() => (state.dirty() ? Badge('unsaved', { tone: 'error' }) : null)),
                Button('Save', () => actions.save(), { disabled: false }),
            ),
            h('div', { class: 'stme-pm-toolbar' },
                Button('+ Prompt', addPrompt), Button('+ Group', addGroup), Button('+ Note', addNote),
                Button('Import from ST file', () => actions.pickFile('st')), Button('Import ME file', () => actions.pickFile('native')),
                Button('Export for ST', () => actions.exportSt()), Button('Export ME', () => actions.exportNative()),
                Button('Duplicate', () => actions.duplicate()), Button('Delete', () => actions.remove(), { variant: 'danger' }),
            ),
            computed(() => {
                const preset = state.preset();
                if (!preset) return EmptyState('No preset yet. Import one from ST or a file — the presets of SillyTavern are prepared automatically on the first run.');
                return h('div', { class: 'stme-pm-split' },
                    h('div', { class: 'stme-pm-list' }, computed(() => { state.rev(); return flattenRows(preset.tree, preset.blocks, collapsed()).map(rowView); })),
                    h('div', { class: 'stme-pm-side' }, computed(() => editor.form(selected()))),
                );
            }),
        );
    }
    return { tree };
}
