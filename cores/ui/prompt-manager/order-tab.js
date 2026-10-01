import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, Badge, EmptyState, IconButton } from '../../../libraries/shared/widgets.js';
import { Select } from './dropdown.js';
import { flattenRows, toggleAt, removeAt, moveNode, stepNode, createTextBlock, createWrapperGroup, createNote, unusedBlockIds, insertDividerPair, removeDividerPair } from './tree-model.js';
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
        getPreset: () => state.preset.peek(), getPluginTypes: state.pluginTypes,
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

    /** Рейки областей слева (внешние ближе к краю) и цвет самой полосы. */
    const RAIL_WIDTH = 5;
    function railStyle(row) {
        const rails = row.rails ?? [];
        const style = {};
        if (rails.length) {
            style.boxShadow = rails.map((color, index) => `inset ${(index + 1) * RAIL_WIDTH}px 0 0 0 ${color}`).join(', ');
            style.paddingLeft = `${8 + rails.length * RAIL_WIDTH}px`;
        }
        // Цвет полосы — прямо в стиле строки: `h()` задаёт style присваиванием свойств, а пользовательские CSS-переменные так не ставятся.
        if (row.divider) { style.background = `color-mix(in srgb, ${row.divider.color} 32%, transparent)`; style.borderColor = row.divider.color; }
        return style;
    }

    function rowView(row) {
        const isSelected = samePath(selected(), row.path);
        const dropMark = drop()?.key === row.key ? ` stme-pm-drop-${drop().where}` : '';
        return h('div', {
            class: `stme-pm-row stme-pm-kind-${row.kind}${row.divider ? ` stme-pm-divider-${row.divider.edge}${row.divider.broken ? ' stme-pm-divider-broken' : ''}` : ''}${row.rails?.length ? ' stme-pm-railed' : ''}${isSelected ? ' stme-pm-selected' : ''}${row.node.enabled === false ? ' stme-pm-off' : ''}${dropMark}`,
            // Отступ вложенности — на самом БЛОКЕ (margin, сдвигает всю рамку строки), не только на тексте внутри
            // него: владелец хотел, чтобы вложенность группы было видно по смещению самих строк, а не только текста.
            style: { marginLeft: `${row.depth * 20}px`, ...railStyle(row) },
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
            'on:dblclick': event => { event.preventDefault(); setTree(tree => toggleAt(tree, row.path)); },
            title: 'Двойной клик — вкл/выкл, перетаскивание — порядок',
            // Клавиатура: Alt+↑/↓ двигает выбранную строку (мышью — перетаскиванием).
            tabindex: '0',
            'on:keydown': event => {
                if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                event.preventDefault();
                step(row, event.key === 'ArrowUp' ? -1 : 1);
            },
        },
        row.hasChildren ? IconButton(row.collapsed ? '▸' : '▾', event => {
            event.stopPropagation();
            const next = new Set(collapsed.peek());
            if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
            collapsed.set(next);
        }, { title: 'Collapse or expand' }) : h('span', { class: 'stme-pm-spacer' }),
        h('span', { class: 'stme-pm-label' }, row.label),
        row.detail ? h('span', { class: 'stme-pm-detail' }, row.detail) : null,
        h('span', { class: 'stme-pm-actions' },
            // Стрелки — только на тач-экране (CSS: `.stme-android`): перетаскивание HTML5 там не работает.
            h('span', { class: 'stme-pm-step' },
                IconButton('↑', event => { event.stopPropagation(); step(row, -1); }, { title: 'Move up' }),
                IconButton('↓', event => { event.stopPropagation(); step(row, 1); }, { title: 'Move down' })),
            row.kind === 'marker' ? null : IconButton('✕', event => { event.stopPropagation(); removeRow(row); }, { title: 'Remove' })),
        );
    }

    /** Сдвиг на одну позицию; выделение идёт вслед за строкой. */
    function step(row, delta) {
        const to = row.path.at(-1) + delta;
        const siblings = row.path.length > 1 ? null : state.preset.peek()?.tree;
        setTree(tree => stepNode(tree, row.path, delta));
        if (to >= 0 && (!siblings || to < siblings.length)) selected.set([...row.path.slice(0, -1), to]);
    }

    function removeRow(row) {
        // Полосу удаляем вместе с парой: одна половина разметки ничего не значит; блоки между ними остаются.
        if (row.node.type === 'divider') { setTree(tree => removeDividerPair(tree, row.node.pair)); selected.set(null); return; }
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
    /** Пара полос вокруг выбранной строки или пустая в конце списка; выделяется верхняя полоса — у неё условие. */
    function addDivider() {
        let created = null;
        actions.edit(preset => { created = insertDividerPair(preset.tree, selected.peek()); preset.tree = created.tree; });
        if (created) selected.set(created.path);
    }
    function addNote() {
        actions.edit(preset => { preset.tree.push(createNote('Note')); });
        selected.set([state.preset().tree.length - 1]);
    }

    function tree() {
        return h('div', { class: 'stme-pm-order' },
            h('div', { class: 'stme-pm-toolbar' },
                Select(state.activeId, state.presetOptions, { onChange: id => actions.selectPreset(id) }),
                computed(() => (state.dirty() ? Badge('unsaved', { tone: 'error' }) : null)),
                Button('Save', () => actions.save(), { disabled: false }),
            ),
            h('div', { class: 'stme-pm-toolbar' },
                Button('+ Prompt', addPrompt), Button('+ Group', addGroup), Button('+ Divider', addDivider), Button('+ Note', addNote),
                Button('Import from ST file', () => actions.pickFile('st')), Button('Export for ST', () => actions.exportSt()),
                Button('Delete', () => actions.remove(), { variant: 'danger' }),
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
