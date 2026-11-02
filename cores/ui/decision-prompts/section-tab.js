import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, IconButton, EmptyState } from '../../../libraries/shared/widgets.js';
import {
    createTextBlock, createGroup, flattenRows, toggleNode, removeNode, moveNode, stepNode, addBlock, addGroup, patchBlock, patchNode,
} from '../../../libraries/core/decision-prompt-model.js';
import { savePreset, loadPreset, duplicatePreset, deletePreset, exportSection, importSection, stPrompts, blocksFromStPrompts } from '../../../libraries/core/decision-prompt-presets.js';
import { Select } from './dropdown.js';
import { createNodeEditor } from './editor.js';
import { StImportPanel } from './st-import.js';

const samePath = (a, b) => Boolean(a && b) && a.length === b.length && a.every((value, index) => value === b[index]);

/** Вкладка раздела: дерево пользовательских промптов, закреплённые системные строки, пресеты и обмен. */
export function createSectionTab({ sectionId, getSection, editSections, pickFile, download, notify, appendImported }) {
    const selected = signal(null);
    const collapsed = signal(new Set());
    const drop = signal(null);
    const importPrompts = signal(null);
    let dragging = null;

    const editor = createNodeEditor({
        sectionId, getSection,
        patchBlock: (blockId, changes) => editSections(sections => ({ ...sections, [sectionId]: patchBlock(sections[sectionId], blockId, changes) })),
        patchNode: (path, changes) => editSections(sections => ({ ...sections, [sectionId]: patchNode(sections[sectionId], path, changes) })),
    });
    const edit = updater => editSections(sections => ({ ...sections, [sectionId]: updater(sections[sectionId]) }));

    const presetOptions = () => [
        { value: '', label: 'Working block' },
        ...getSection().presets.map(preset => ({ value: preset.id, label: preset.name })),
    ];
    const presetValue = Object.assign(() => getSection().activePresetId, {
        set: id => { if (id) edit(section => loadPreset(section, id)); },
    });

    function dropWhere(event, row) {
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - box.top) / Math.max(box.height, 1);
        if (row.kind === 'group' && ratio > 0.3 && ratio < 0.7) return 'inside';
        return ratio < 0.5 ? 'before' : 'after';
    }

    function rowView(row) {
        const key = row.path.join(':');
        const isSelected = samePath(selected(), row.path);
        const dropMark = drop()?.key === key ? ` stme-dp-drop-${drop().where}` : '';
        return h('div', {
            class: `stme-dp-row stme-dp-kind-${row.kind}${row.locked ? ' stme-dp-row-locked' : ''}${isSelected ? ' stme-dp-selected' : ''}${row.node.enabled === false ? ' stme-dp-off' : ''}${dropMark}`,
            style: { marginLeft: `${row.depth * 20}px` },
            draggable: row.locked ? 'false' : 'true',
            'on:dragstart': row.locked ? undefined : event => { dragging = row.path; event.dataTransfer?.setData('text/plain', key); },
            'on:dragover': row.locked ? event => event.preventDefault() : event => { event.preventDefault(); drop.set({ key, where: dropWhere(event, row) }); },
            'on:dragleave': row.locked ? undefined : () => { if (drop.peek()?.key === key) drop.set(null); },
            'on:drop': row.locked ? event => { event.preventDefault(); drop.set(null); dragging = null; } : event => {
                event.preventDefault();
                const where = dropWhere(event, row);
                drop.set(null);
                if (dragging) edit(section => moveNode(section, dragging, row.path, where));
                dragging = null;
            },
            'on:click': () => selected.set(row.path),
            'on:dblclick': row.locked ? undefined : event => { event.preventDefault(); edit(section => toggleNode(section, row.path)); },
            title: row.locked ? 'Built in — cannot be moved, removed or switched off' : 'Double-click — send on/off, drag — order',
            tabindex: '0',
            'on:keydown': row.locked ? undefined : event => {
                if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                event.preventDefault();
                edit(section => stepNode(section, row.path, event.key === 'ArrowUp' ? -1 : 1));
            },
        },
        row.locked ? h('span', { class: 'stme-dp-lock', title: 'Locked' }, '🔒') : row.hasChildren ? IconButton(row.collapsed ? '▸' : '▾', event => {
            event.stopPropagation();
            const next = new Set(collapsed.peek());
            if (next.has(key)) next.delete(key); else next.add(key);
            collapsed.set(next);
        }, { title: 'Collapse or expand' }) : h('span', { class: 'stme-dp-spacer' }),
        h('span', { class: 'stme-dp-label' }, row.label),
        row.detail ? h('span', { class: 'stme-dp-detail' }, row.detail) : null,
        h('span', { class: 'stme-dp-actions' },
            row.locked ? null : [
                h('span', { class: 'stme-dp-step' },
                    IconButton('↑', event => { event.stopPropagation(); edit(section => stepNode(section, row.path, -1)); }, { title: 'Move up' }),
                    IconButton('↓', event => { event.stopPropagation(); edit(section => stepNode(section, row.path, 1)); }, { title: 'Move down' })),
                IconButton(row.node.enabled === false ? '○' : '✓', event => { event.stopPropagation(); edit(section => toggleNode(section, row.path)); }, { title: 'Send on/off' }),
                IconButton('✕', event => { event.stopPropagation(); edit(section => removeNode(section, row.path)); selected.set(null); }, { title: 'Remove' }),
            ]),
        );
    }

    function addPrompt() {
        const index = getSection().tree.length;
        edit(section => addBlock(section, createTextBlock({})));
        selected.set([index]);
    }
    function addGroup() {
        const index = getSection().tree.length;
        edit(section => addGroup(section, createGroup('section')));
        selected.set([index]);
    }

    async function importFromSt() {
        const picked = await pickFile();
        if (!picked) return;
        try { importPrompts.set(stPrompts(picked.text)); } catch (error) { await notify('error', `Import failed: ${error.message}`); }
    }

    function confirmImport(choices) {
        try {
            appendImported(blocksFromStPrompts(importPrompts.peek() ?? [], choices));
            importPrompts.set(null);
        } catch (error) { notify('error', `Import failed: ${error.message}`); }
    }

    async function exportJson() {
        const ok = await download(`${sectionId}-prompts.json`, JSON.stringify(exportSection(getSection(), sectionId), null, 2));
        await notify(ok ? 'ok' : 'error', ok ? 'Section exported.' : 'Could not export the section.');
    }

    async function importJson() {
        const picked = await pickFile();
        if (!picked) return;
        try {
            const next = importSection(getSection(), picked.text, sectionId);
            editSections(sections => ({ ...sections, [sectionId]: next }));
            selected.set(null);
            await notify('ok', 'Section imported.');
        } catch (error) { await notify('error', `Import failed: ${error.message}`); }
    }

    function tree() {
        return h('div', { class: 'stme-dp-order' },
            h('div', { class: 'stme-dp-toolbar' },
                Select(presetValue, presetOptions),
                Button('Save preset', () => edit(section => savePreset(section, ''))),
                Button('Duplicate', () => { const id = getSection().activePresetId; if (id) edit(section => duplicatePreset(section, id)); else notify('info', 'Save a preset first.'); }),
                Button('Delete preset', () => { const id = getSection().activePresetId; if (id) edit(section => deletePreset(section, id)); }, { variant: 'danger' }),
            ),
            h('div', { class: 'stme-dp-toolbar' },
                Button('+ Prompt', addPrompt), Button('+ Group', addGroup),
                Button('Import from ST', importFromSt), Button('Export JSON', exportJson), Button('Import JSON', importJson),
            ),
            computed(() => (importPrompts() ? StImportPanel({ prompts: importPrompts(), onConfirm: confirmImport, onCancel: () => importPrompts.set(null) }) : null)),
            computed(() => sectionBody()),
        );
    }

    function sectionBody() {
        const section = getSection();
        const rows = flattenRows(sectionId, section, collapsed());
        return h('div', { class: 'stme-dp-split' },
            h('div', { class: 'stme-dp-list' }, rows.length ? rows.map(rowView) : EmptyState('No prompts yet. Add one, or import a preset.')),
            h('div', { class: 'stme-dp-side' }, computed(() => editor.form(selected()))),
        );
    }

    return { tree };
}
