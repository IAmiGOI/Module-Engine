import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTextBlock, createGroup, emptySection, migratePromptSections, normalizeSection, systemLines,
    flattenRows, removeNode, toggleNode, moveNode, stepNode, addBlock, addGroup,
} from '../libraries/core/decision-prompt-model.js';
import { assemblePromptSection } from '../libraries/core/decision-prompt-assemble.js';
import { createMacroEngine } from '../libraries/core/decision-prompt-macros.js';
import {
    savePreset, loadPreset, duplicatePreset, deletePreset, appendBlocks,
    stPrompts, blocksFromStPrompts, exportSection, importSection,
} from '../libraries/core/decision-prompt-presets.js';
import { buildDeciderContext, buildWriterContext } from '../libraries/core/decision-context.js';

const block = (name, content, role = 'system') => createTextBlock({ name, content, role });
const item = id => ({ type: 'item', block: id, enabled: true });

function sectionWith(prompts = []) {
    const section = emptySection();
    for (const prompt of prompts) {
        const made = block(prompt.name, prompt.content, prompt.role);
        section.blocks.push(made);
        section.tree.push({ ...item(made.id), enabled: prompt.enabled !== false, ...(prompt.condition ? { condition: prompt.condition } : {}) });
    }
    return section;
}

test('migration turns each non-empty field of part 3 into the first prompt of its section, once', () => {
    const sections = migratePromptSections(null, { director: 'Direct me.', writer: '  ' });
    assert.equal(sections.director.blocks.length, 1);
    assert.equal(sections.director.blocks[0].content, 'Direct me.');
    assert.equal(sections.director.tree.length, 1);
    assert.equal(sections.writer.blocks.length, 0, 'an empty field does not create a prompt');
    const again = migratePromptSections(sections, { director: 'Direct me again.' });
    assert.equal(again.director.blocks.length, 1);
    assert.equal(again.director.blocks[0].content, 'Direct me.', 'an existing section is not migrated a second time');
});

test('system lines are locked and live outside the user tree: the model refuses to move, remove or disable them', () => {
    const section = sectionWith([{ name: 'Mine', content: 'text' }]);
    assert.equal(systemLines('director').length, 1);
    assert.equal(systemLines('director')[0].locked, true);
    assert.equal(removeNode(section, ['system', 0]), section);
    assert.equal(toggleNode(section, ['system', 0]), section);
    assert.equal(stepNode(section, ['system', 0], 1), section);
    assert.equal(moveNode(section, ['system', 0], [0], 'before'), section);
    assert.equal(moveNode(section, [0], ['system', 0], 'before'), section);
    const rows = flattenRows('director', section);
    assert.equal(rows[0].locked, true);
    assert.equal(rows[1].label, 'Mine');
});

test('assembly keeps order and drops disabled and empty prompts', () => {
    const section = sectionWith([
        { name: 'A', content: 'first' },
        { name: 'B', content: 'second', enabled: false },
        { name: 'C', content: '   ' },
        { name: 'D', content: 'third' },
    ]);
    const result = assemblePromptSection(section, {});
    assert.deepEqual(result.messages.map(message => message.content), ['first', 'third']);
    assert.equal(result.text, 'first\n\nthird');
    assert.deepEqual(result.report.filter(entry => entry.included === false).map(entry => entry.reason), ['disabled', 'empty']);
});

test('a group wraps its children in its tag, and an empty group sends nothing unless asked otherwise', () => {
    const a = block('A', 'inside');
    const b = block('B', 'more');
    const group = createGroup('setting');
    group.children = [item(a.id), item(b.id)];
    const section = { blocks: [a, b], tree: [group], presets: [], activePresetId: '' };
    const result = assemblePromptSection(section, {});
    assert.deepEqual(result.messages, [{ role: 'system', content: '<setting>\ninside\nmore\n</setting>' }]);

    const empty = createGroup('empty');
    const skipped = assemblePromptSection({ ...emptySection(), tree: [empty] }, {});
    assert.equal(skipped.messages.length, 0);
    const kept = createGroup('empty');
    kept.skipWhenEmpty = false;
    const keptResult = assemblePromptSection({ ...emptySection(), tree: [kept] }, {});
    assert.deepEqual(keptResult.messages.map(message => message.content), ['<empty>\n</empty>']);
});

test('conditions decide inclusion; variables written by earlier prompts are visible to later conditions', () => {
    const setvar = block('Set', '{{setvar::mood::angry}}');
    const seen = block('Seen', 'the mood is set');
    const section = {
        blocks: [setvar, seen], presets: [], activePresetId: '',
        tree: [
            item(setvar.id),
            { ...item(seen.id), condition: { type: 'variable', name: 'mood', op: '=', value: 'angry' } },
        ],
    };
    const facts = { messages: [{ role: 'user', text: 'hello' }], chatLength: 4 };
    assert.deepEqual(assemblePromptSection(section, facts).messages.map(message => message.content), ['the mood is set']);
    const off = { ...section, tree: [{ ...section.tree[1], condition: { type: 'variable', name: 'mood', op: '=', value: 'calm' } }] };
    assert.equal(assemblePromptSection(off, facts).messages.length, 0);
});

test('keyword and message length conditions read the chat from the newest message backwards', () => {
    const prompt = block('K', 'hit');
    const section = { ...emptySection(), blocks: [prompt], tree: [{ ...item(prompt.id), condition: { type: 'keyword', words: ['dragon'], scan: 2, source: 'char' } }] };
    const facts = { messages: [{ role: 'assistant', text: 'A dragon appears' }, { role: 'user', text: 'hello' }], chatLength: 2 };
    assert.equal(assemblePromptSection(section, facts).messages.length, 1);
    const long = { ...section, tree: [{ ...section.tree[0], condition: { type: 'messageLength', source: 'lastUser', op: '>', value: 3 } }] };
    assert.equal(assemblePromptSection(long, facts).messages.length, 1);
    assert.equal(assemblePromptSection(long, { ...facts, messages: [{ role: 'user', text: 'hi' }] }).messages.length, 0);
});

test('cooldown writes its state back into facts.timed, and chance uses the injected random source', () => {
    const prompt = block('C', 'fired');
    const condition = { type: 'cooldown', key: 'test', turns: 3 };
    const section = { ...emptySection(), blocks: [prompt], tree: [{ ...item(prompt.id), condition }] };
    const facts = { messages: [], chatLength: 5, timed: {}, random: () => 0 };
    assert.equal(assemblePromptSection(section, facts).messages.length, 1);
    assert.equal(facts.timed.test, 8);
    assert.equal(assemblePromptSection(section, { ...facts, chatLength: 6 }).messages.length, 0);
    const chance = { ...section, tree: [{ ...section.tree[0], condition: { type: 'chance', percent: 50 } }] };
    assert.equal(assemblePromptSection(chance, { messages: [], chatLength: 0, random: () => 0.2 }).messages.length, 1);
    assert.equal(assemblePromptSection(chance, { messages: [], chatLength: 0, random: () => 0.9 }).messages.length, 0);
});

test('macros fill values, keep variables inside one assembly and report unknown names', () => {
    const prompt = block('M', '{{user}} and {{char}}: {{setvar::x::7}}{{getvar::x}} {{unknown_thing}}');
    const section = { ...emptySection(), blocks: [prompt], tree: [item(prompt.id)] };
    const result = assemblePromptSection(section, { values: { user: 'Ann', char: 'Bob' }, random: () => 0 });
    assert.equal(result.messages[0].content, 'Ann and Bob: 7 {{unknown_thing}}');
    assert.deepEqual(result.unresolved, ['unknown_thing']);
    const engine = createMacroEngine({ seed: 'fixed' });
    assert.match(engine.substitute('{{pick::a::b::c}}'), /^[abc]$/);
    assert.equal(engine.substitute('{{time}}').length > 0, true);
});

test('presets save, load, duplicate and delete the working block', () => {
    let section = sectionWith([{ name: 'A', content: 'one' }]);
    section = savePreset(section, 'First');
    assert.equal(section.presets.length, 1);
    assert.equal(section.activePresetId, section.presets[0].id);
    section = addBlock(section, block('B', 'two'));
    section = savePreset(section, 'First');
    assert.equal(section.presets[0].blocks.length, 2, 'saving again updates the active preset');
    const first = section.presets[0].id;
    section = { ...section, blocks: [], tree: [] };
    section = loadPreset(section, first);
    assert.equal(section.blocks.length, 2);
    section = duplicatePreset(section, first);
    assert.equal(section.presets.length, 2);
    assert.match(section.presets[1].name, /copy/);
    section = deletePreset(section, section.presets[1].id);
    assert.equal(section.presets.length, 1);
    assert.equal(section.activePresetId, '');
});

test('ST import lists prompts, skips markers and empties, and appends chosen ones to the right section', () => {
    const source = { prompts: [
        { identifier: 'main', name: 'Main', role: 'system', content: 'Rule one' },
        { identifier: 'chatHistory', name: 'History', marker: 'chatHistory', content: '' },
        { identifier: 'empty', name: 'Empty', content: '   ' },
        { identifier: 'style', name: 'Style', role: 'user', content: 'Write well' },
    ] };
    const prompts = stPrompts(source);
    assert.equal(prompts.length, 4);
    const made = blocksFromStPrompts(prompts, { main: 'director', style: 'writer', chatHistory: 'writer', empty: 'writer' });
    assert.deepEqual(made.director.map(block => block.content), ['Rule one']);
    assert.deepEqual(made.writer.map(block => block.content), ['Write well']);
    const director = appendBlocks(emptySection(), made.director);
    assert.equal(director.blocks.length, 1);
    assert.equal(director.tree.length, 1);
    assert.equal(director.tree[0].type, 'item');
});

test('a section JSON round-trips through export and import, and rejects another section', () => {
    const section = sectionWith([{ name: 'A', content: 'one' }]);
    const json = exportSection(section, 'director');
    const imported = importSection(emptySection(), json, 'director');
    assert.equal(imported.blocks.length, 1);
    assert.equal(imported.blocks[0].content, 'one');
    assert.throws(() => importSection(emptySection(), json, 'writer'), /director section/);
    assert.throws(() => importSection(emptySection(), { kind: 'other' }, 'director'), /not a decision prompt section/);
});

test('the user block keeps its automatic depth: two cycles for the director, five messages for the writer', () => {
    const chat = [];
    for (let index = 0; index < 5; index += 1) {
        chat.push({ mes: `user ${index}`, is_user: true }, { mes: `assistant ${index}` });
    }
    const directorBlock = [{ role: 'system', content: 'DIRECTOR BLOCK' }];
    const writerBlock = [{ role: 'system', content: 'WRITER BLOCK' }];
    const director = buildDeciderContext({ chat, directorBlock });
    const writer = buildWriterContext({ chat, decision: 'push', writerBlock });
    const directorHistory = director.messages.slice(1, -2);
    const writerHistory = writer.messages.slice(1, -1);
    const directorIndex = directorHistory.findIndex(message => message.content === 'DIRECTOR BLOCK');
    const writerIndex = writerHistory.findIndex(message => message.content === 'WRITER BLOCK');
    assert.equal(directorHistory.length - directorIndex - 1, 4, 'the block sits before the last two cycles');
    assert.equal(writerHistory.length - writerIndex - 1, 5, 'the block sits five messages from the end');
});

test('moving inside the tree works for prompts and groups, but a group cannot be moved into its own branch', () => {
    const a = block('A', 'a');
    const b = block('B', 'b');
    const group = createGroup('g');
    let section = { ...emptySection(), blocks: [a, b], tree: [item(a.id), item(b.id), group] };
    section = moveNode(section, [0], [2], 'inside');
    assert.equal(section.tree.length, 2);
    assert.equal(section.tree[1].children.length, 1);
    const before = section;
    section = moveNode(section, [1], [1, 0], 'before');
    assert.deepEqual(section, before, 'moving a group into itself changes nothing');
});
