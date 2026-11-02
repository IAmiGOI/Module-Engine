import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { TextInput, TextArea, Toggle, Row, Field, Badge, EmptyState } from '../../../libraries/shared/widgets.js';
import { getNode, PROMPT_ROLES, systemLines } from '../../../libraries/core/decision-prompt-model.js';
import { describeCondition } from '../../../libraries/core/decision-prompt-conditions.js';
import { Select } from './dropdown.js';
import { ConditionBuilder } from './condition-builder.js';

const bound = (initial, commit) => { const value = signal(initial); const set = value.set; value.set = next => { set(next); commit(next); }; return value; };
const ROLES = PROMPT_ROLES.map(role => ({ value: role, label: role }));

/** Редактор выбранного узла: промпт, группа или закреплённая системная строка. */
export function createNodeEditor({ sectionId, getSection, patchBlock, patchNode }) {
    function editBlock(block, changes) { patchBlock(block.id, changes); }
    function editNode(path, changes) { patchNode(path, changes); }

    function conditionSection(node, path) {
        const on = signal(Boolean(node.condition));
        const set = on.set;
        on.set = value => { set(value); if (!value) editNode(path, { condition: undefined }); };
        return h('div', { class: 'stme-dp-editor' },
            Toggle('Send only when a condition is true', on),
            computed(() => (on() ? ConditionBuilder({
                getCondition: () => getNode(getSection(), path)?.condition ?? null,
                setCondition: condition => editNode(path, { condition: condition ?? undefined }),
            }) : null)),
            node.condition ? h('p', { class: 'stme-dp-help' }, `Now: ${describeCondition(node.condition)}`) : null,
        );
    }

    function blockForm(block, node, path) {
        return h('div', { class: 'stme-dp-editor' },
            Row(
                Field('Name', TextInput(bound(block.name ?? '', value => editBlock(block, { name: value })))),
                Field('Role', Select(bound(block.role ?? 'system', value => editBlock(block, { role: value })), ROLES)),
            ),
            Toggle('Send this prompt', bound(node.enabled !== false, value => editNode(path, { enabled: value }))),
            Field('Text', TextArea(bound(block.content ?? '', value => editBlock(block, { content: value })), { rows: 10, placeholder: 'Prompt text. Macros like {{char}}, {{user}}, {{setvar::a::b}} work.' })),
            conditionSection(node, path),
        );
    }

    function groupForm(node, path) {
        return h('div', { class: 'stme-dp-editor' },
            Row(
                Field('Group name', TextInput(bound(node.name ?? '', value => editNode(path, { name: value })))),
                Field('Wrapper tag', TextInput(bound(node.tag ?? '', value => editNode(path, { tag: value }))), { hint: 'The group sends <tag> … </tag> around its prompts.' }),
            ),
            Toggle('Send this group', bound(node.enabled !== false, value => editNode(path, { enabled: value }))),
            Toggle('Send nothing when the group is empty', bound(node.skipWhenEmpty !== false, value => editNode(path, { skipWhenEmpty: value }))),
            conditionSection(node, path),
        );
    }

    function systemForm(node) {
        return h('div', { class: 'stme-dp-editor' },
            Row(Badge('locked', { tone: 'ok' }), h('span', { class: 'stme-dp-locked-note' }, 'Built into the engine. It cannot be moved, removed or switched off.')),
            Field('Text', h('pre', { class: 'stme-dp-block-text' }, node.text)),
        );
    }

    function form(path) {
        const section = getSection();
        if (path?.[0] === 'system') return systemForm(systemLines(sectionId)[path[1]] ?? { text: '' });
        const node = section && path ? getNode(section, path) : null;
        if (!node) return EmptyState('Select a row to edit it.');
        if (node.type === 'group') return groupForm(node, path);
        const block = section.blocks.find(item => item.id === node.block);
        return block ? blockForm(block, node, path) : EmptyState('This row points to a prompt that is missing.');
    }

    return { form };
}
