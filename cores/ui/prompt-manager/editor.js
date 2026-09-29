import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, TextInput, TextArea, NumberInput, Toggle, Row, Field, Select, Badge, EmptyState } from '../../../libraries/shared/widgets.js';
import { getAt } from './tree-model.js';
import { ConditionBuilder } from './condition-builder.js';
import { describeCondition } from './condition-model.js';

const ROLES = [{ value: 'system', label: 'system' }, { value: 'user', label: 'user' }, { value: 'assistant', label: 'assistant' }];
const POSITIONS = [{ value: 'relative', label: 'in order (where it stands in the list)' }, { value: 'depth', label: 'inside the chat, N messages from the end' }];
const MARKER_HELP = {
    chatHistory: 'The chat messages. Prompts set to "inside the chat" land among them.',
    charDescription: 'Character description from the card.', charPersonality: 'Character personality (through the preset template).',
    scenario: 'Scenario from the card (through the preset template).', personaDescription: 'Your persona description.',
    worldInfoBefore: 'Lorebook entries placed before the character.', worldInfoAfter: 'Lorebook entries placed after the character.',
    dialogueExamples: 'Example dialogue from the card.',
};

/** Поле блока как сигнал, записывающий изменение обратно через `commit`. */
function bound(initial, commit) {
    const value = signal(initial);
    const set = value.set;
    value.set = next => { set(next); commit(next); };
    return value;
}

/**
 * Редактор выбранного узла: текстовый блок, группа, заметка, вклад модуля. Любое изменение сразу уходит в `apply(mutator)` —
 * окно применяет его к пресету и помечает пресет «изменён»; сохраняет пользователь кнопкой Save.
 */
export function createNodeEditor({ getPreset, patch, resetContribution }) {
    function editBlock(id, changes) {
        patch(preset => { const block = preset.blocks.find(b => b.id === id); if (block) Object.assign(block, changes); });
    }
    function editNode(path, changes) {
        patch(preset => { const node = getAt(preset.tree, path); if (node) Object.assign(node, changes); });
    }

    function blockForm(block, path) {
        if (block.marker) return h('div', { class: 'stme-pm-editor' }, Badge('marker'), h('p', { class: 'stme-pm-help' }, MARKER_HELP[block.id] ?? 'Filled in by the assembler.'));
        const position = bound(block.position ?? 'relative', value => editBlock(block.id, { position: value }));
        return h('div', { class: 'stme-pm-editor' },
            Field('Name', TextInput(bound(block.name ?? '', value => editBlock(block.id, { name: value })))),
            Field('Role', Select(bound(block.role ?? 'system', value => editBlock(block.id, { role: value })), ROLES)),
            Field('Text', TextArea(bound(block.content ?? '', value => editBlock(block.id, { content: value })), { rows: 10, placeholder: 'Prompt text. Macros like {{char}}, {{user}}, {{setvar::a::b}} work.' })),
            Field('Position', Select(position, POSITIONS)),
            computed(() => (position() === 'depth' ? Row(
                Field('Depth', NumberInput(bound(block.depth ?? 4, value => editBlock(block.id, { depth: Number(value) })), { min: 0, max: 200 })),
                Field('Order', NumberInput(bound(block.order ?? 100, value => editBlock(block.id, { order: Number(value) })), { min: 0, max: 9999 })),
            ) : null)),
            Field('Trim priority', NumberInput(bound(block.trimPriority ?? 100, value => editBlock(block.id, { trimPriority: Number(value) })), { min: 0, max: 100 }), { hint: '100 = never trimmed. Lower goes first (history is 50).' }),
        );
    }

    function groupForm(node, path) {
        return h('div', { class: 'stme-pm-editor' },
            Field('Group name', TextInput(bound(node.name ?? '', value => editNode(path, { name: value })))),
            Toggle('Send nothing when the group is empty', bound(node.skipWhenEmpty !== false, value => editNode(path, { skipWhenEmpty: value }))),
            node.wrap ? h('p', { class: 'stme-pm-help' }, `The group wraps its content in <${node.name}> … </${node.name}>. Edit the tags as prompts of this preset if needed.`) : null,
        );
    }

    function noteForm(node, path) {
        return h('div', { class: 'stme-pm-editor' }, Field('Note (never sent to the model)', TextArea(bound(node.text ?? '', value => editNode(path, { text: value })), { rows: 4 })));
    }

    function injectForm(node, path) {
        const mode = bound(node.placement?.mode === 'depth' ? 'depth' : 'order', value => editNode(path, { placement: value === 'depth' ? { mode: 'depth', depth: node.placement?.depth ?? 0, order: node.placement?.order ?? 100 } : undefined }));
        return h('div', { class: 'stme-pm-editor' },
            Badge('module contribution'),
            h('p', { class: 'stme-pm-help' }, 'A module puts its text here (memory, notebook, summaries…). You decide where; the module only suggests a start position.'),
            Field('Placement', Select(mode, [{ value: 'order', label: 'in order (where it stands in the list)' }, { value: 'depth', label: 'inside the chat, N messages from the end' }])),
            computed(() => (mode() === 'depth' ? Row(
                Field('Depth', NumberInput(bound(node.placement?.depth ?? 0, value => editNode(path, { placement: { ...(getAt(getPreset().tree, path)?.placement ?? {}), mode: 'depth', depth: Number(value) } })), { min: 0, max: 200 })),
            ) : null)),
            Row(Button('Return to the module\'s default position', () => resetContribution(node))),
        );
    }

    /** Условие отправки: включается тумблером, дальше конструктор правил (без кода). */
    function conditionSection(node, path) {
        const on = signal(Boolean(node.condition));
        const set = on.set;
        on.set = value => { set(value); if (!value) editNode(path, { condition: undefined }); };
        return h('div', { class: 'stme-pm-editor' },
            Toggle('Send only when a condition is true', on),
            computed(() => (on() ? ConditionBuilder({
                getCondition: () => getAt(getPreset().tree, path)?.condition ?? null,
                setCondition: condition => editNode(path, { condition: condition ?? undefined }),
            }) : node.condition ? null : null)),
            node.condition ? h('p', { class: 'stme-pm-help' }, `Now: ${describeCondition(node.condition)}`) : null,
        );
    }

    /** Форма выбранного узла (`path` — путь в дереве). */
    function form(path) {
        const preset = getPreset();
        const node = preset && path ? getAt(preset.tree, path) : null;
        if (!node) return EmptyState('Select a row to edit it.');
        const withCondition = body => h('div', { class: 'stme-pm-editor' }, body, node.type === 'note' ? null : conditionSection(node, path));
        if (node.type === 'group') return withCondition(groupForm(node, path));
        if (node.type === 'note') return noteForm(node, path);
        if (node.type === 'inject') return withCondition(injectForm(node, path));
        if (node.type === 'item') {
            const block = preset.blocks.find(b => b.id === node.block);
            return block ? withCondition(blockForm(block, path)) : EmptyState('This row points to a prompt that is missing.');
        }
        return EmptyState('This row type has no editor yet.');
    }
    return { form };
}
