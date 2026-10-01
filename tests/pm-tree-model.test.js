import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { presetToSt } from '../libraries/core/pm-st-export.js';
import { flattenRows, getAt, moveNode, stepNode, toggleAt, removeAt, createTextBlock, createWrapperGroup, createNote, unusedBlockIds, describeNode } from '../cores/ui/prompt-manager/tree-model.js';

const item = block => ({ type: 'item', block, enabled: true });
const sample = () => [item('a'), { type: 'group', id: 'g', name: 'g', enabled: true, wrap: { open: 'go', close: 'gc' }, children: [item('b'), item('c')] }, item('d')];
const ids = tree => JSON.stringify(tree.map(n => n.block ?? n.children?.map(c => c.block)));

test('rows are flattened with depth and a collapsed group hides its children', () => {
    const blocks = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }];
    assert.deepEqual(flattenRows(sample(), blocks).map(r => [r.key, r.depth]), [['0', 0], ['1', 0], ['1.0', 1], ['1.1', 1], ['2', 0]]);
    assert.deepEqual(flattenRows(sample(), blocks, new Set(['1'])).map(r => r.key), ['0', '1', '2']);
});

test('rows are described by kind: marker, text with role and depth, group, module contribution and missing block', () => {
    const blocks = [{ id: 'chatHistory', marker: true, name: 'Chat History' }, { id: 't', name: 'Rules', role: 'user', position: 'depth', depth: 3 }];
    assert.equal(describeNode(item('chatHistory'), blocks).kind, 'marker');
    assert.equal(describeNode(item('t'), blocks).detail, 'user · depth 3');
    assert.equal(describeNode({ type: 'group', name: 'info', wrap: {} }, blocks).detail, '<info> … </info>');
    assert.equal(describeNode({ type: 'inject', contribution: 'graph', placement: { mode: 'depth', depth: 2 } }, blocks).detail, 'module · depth 2');
    assert.equal(describeNode(item('zzz'), blocks).kind, 'missing');
});

test('toggle and remove return a new tree and leave the old one alone', () => {
    const tree = sample();
    assert.equal(toggleAt(tree, [1, 0])[1].children[0].enabled, false);
    assert.equal(tree[1].children[0].enabled, true);
    assert.equal(ids(removeAt(tree, [0])), '[[\"b\",\"c\"],\"d\"]');
});

test('a node moves before, after and inside a group with indexes corrected after the removal', () => {
    assert.equal(ids(moveNode(sample(), [0], [2], 'after')), '[[\"b\",\"c\"],\"d\",\"a\"]');
    assert.equal(ids(moveNode(sample(), [2], [0], 'before')), '["d","a",["b","c"]]'.replace('"a",["b","c"]', '"a",["b","c"]'));
    assert.equal(ids(moveNode(sample(), [0], [1], 'inside')), '[[\"b\",\"c\",\"a\"],\"d\"]');
    assert.equal(ids(moveNode(sample(), [1, 1], [0], 'before')), '["c","a",["b"],"d"]');
});

test('a group cannot be moved into itself or its own branch', () => {
    const tree = sample();
    assert.equal(moveNode(tree, [1], [1, 0], 'before'), tree);
    assert.equal(moveNode(tree, [1], [1], 'after'), tree);
});

test('step moves a node one place inside its own list and stops at the ends', () => {
    assert.equal(ids(stepNode(sample(), [0], 1)), '[[\"b\",\"c\"],\"a\",\"d\"]');
    const tree = sample();
    assert.equal(stepNode(tree, [0], -1), tree);
    assert.equal(stepNode(tree, [2], 1), tree);
});

test('new blocks and wrapper groups come with consistent ids and tag texts', () => {
    const { block, node } = createTextBlock({ name: 'X', content: 'hi' });
    assert.equal(node.block, block.id);
    const group = createWrapperGroup('rules');
    assert.deepEqual(group.blocks.map(b => b.content), ['<rules>', '</rules>']);
    assert.equal(group.node.wrap.open, group.blocks[0].id);
    assert.equal(createNote('read me').type, 'note');
});

test('blocks nobody refers to any more are found, wrapper blocks of a live group and markers are kept', () => {
    const blocks = [{ id: 'a' }, { id: 'b' }, { id: 'go' }, { id: 'gc' }, { id: 'zombie' }, { id: 'chatHistory', marker: true }];
    assert.deepEqual(unusedBlockIds([item('a'), { type: 'group', wrap: { open: 'go', close: 'gc' }, children: [item('b')] }], blocks), ['zombie']);
});

test('notes, module contributions and choices never break the export to a ST file and notes stay out of the prompt', () => {
    const preset = stToPreset(JSON.parse(readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8')));
    preset.tree.unshift(createNote('hello'), { type: 'inject', contribution: 'graph', enabled: true });
    const order = presetToSt(preset).prompt_order.find(list => list.character_id === 100001).order;
    assert.equal(order.every(entry => typeof entry.identifier === 'string'), true);
});

// --- Разделители (полосы условий Jev) ---

import { insertDividerPair, removeDividerPair, patchDividerPair } from '../cores/ui/prompt-manager/tree-model.js';
import { createDividerPair, DIVIDER_PALETTE } from '../libraries/core/pm-dividers.js';
import { describeCondition, LEAF_TYPES, newLeaf } from '../cores/ui/prompt-manager/condition-model.js';

const blocksABCD = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));

test('a divider pair is inserted around the selected row, one colour apart from the pairs already there, or appended empty when nothing is selected', () => {
    const first = insertDividerPair([item('a'), item('b'), item('c')], [1]);
    assert.deepEqual(first.tree.map(node => node.block ?? `${node.type}:${node.edge}`), ['a', 'divider:begin', 'b', 'divider:end', 'c']);
    assert.deepEqual(first.path, [1]);
    assert.equal(first.tree[1].color, DIVIDER_PALETTE[0]);
    const second = insertDividerPair(first.tree, [4]);
    assert.equal(second.tree[4].color, DIVIDER_PALETTE[1], 'the next pair takes the next colour');
    const appended = insertDividerPair([item('a')], null);
    assert.deepEqual(appended.tree.map(node => node.block ?? node.edge), ['a', 'begin', 'end']);
    assert.deepEqual(appended.path, [1]);
    const inGroup = insertDividerPair(sample(), [1, 0]);
    assert.deepEqual(inGroup.tree[1].children.map(node => node.block ?? node.edge), ['begin', 'b', 'end', 'c'], 'the pair stays inside the list of the selected row');
});

test('rows between two strips carry the colours of the regions they stand in, outer first; strips and rows outside carry only what encloses them; a broken pair paints nothing', () => {
    const [outerBegin, outerEnd] = createDividerPair({ color: '#111111', name: 'outer' });
    const [innerBegin, innerEnd] = createDividerPair({ color: '#222222', name: 'inner' });
    const tree = [item('a'), outerBegin, item('b'), innerBegin, item('c'), innerEnd, item('d'), outerEnd, item('e')];
    const rows = flattenRows(tree, blocksABCD);
    assert.deepEqual(rows.map(row => [row.node.block ?? row.node.edge, row.rails]), [
        ['a', []], ['begin', []], ['b', ['#111111']], ['begin', ['#111111']], ['c', ['#111111', '#222222']], ['end', ['#111111', '#222222']], ['d', ['#111111']], ['end', ['#111111']], ['e', []],
    ]);
    assert.deepEqual(rows[1].divider, { edge: 'begin', color: '#111111', broken: false });
    const [lonely] = createDividerPair({ color: '#333333' });
    const broken = flattenRows([item('a'), lonely, item('b')], blocksABCD);
    assert.deepEqual(broken.map(row => row.rails), [[], [], []]);
    assert.equal(broken[1].divider.broken, true);
});

test('a strip is described by its name and its condition in plain words; removing one strip removes the pair and keeps the blocks between; name and colour change on both strips at once', () => {
    const [begin, end] = createDividerPair({ color: '#444444', name: 'danger' });
    const withCondition = { ...begin, condition: { type: 'jev', question: 'The player is in danger.', minChance: 80, user: 1, assistant: 1 } };
    assert.deepEqual([describeNode(withCondition, []).label, describeNode(withCondition, []).detail], ['danger', 'Jev finds “The player is in danger.” at least 80% likely (reads 1 of your messages and 1 replies)']);
    assert.equal(describeNode(begin, []).detail, 'no condition — always sent');
    assert.equal(describeNode(end, []).label, 'end · danger');
    const tree = [item('a'), withCondition, item('b'), end, item('c')];
    assert.deepEqual(removeDividerPair(tree, begin.pair).map(node => node.block), ['a', 'b', 'c']);
    const recolored = patchDividerPair(tree, begin.pair, { color: '#555555', name: 'calm' });
    assert.deepEqual([recolored[1].color, recolored[3].color, recolored[1].name, recolored[3].name], ['#555555', '#555555', 'calm', 'calm']);
    assert.equal(recolored[1].condition.type, 'jev', 'the condition stays');
    const nested = [{ type: 'group', id: 'g', name: 'g', enabled: true, wrap: { open: 'o', close: 'c' }, children: [begin, item('x'), end] }];
    assert.deepEqual(removeDividerPair(nested, begin.pair)[0].children.map(node => node.block), ['x'], 'found inside groups too');
});

test('the Jev rule is offered in the condition builder with its five fields, and read in plain words', () => {
    assert.deepEqual(LEAF_TYPES.jev.fields.map(field => field.key), ['question', 'minChance', 'user', 'assistant', 'connection']);
    assert.deepEqual(newLeaf('jev'), { type: 'jev', question: '', minChance: 70, user: 1, assistant: 1, connection: '' });
    assert.equal(describeCondition({ type: 'not', item: { type: 'jev', question: 'calm?', minChance: 50, user: 0, assistant: 2 } }), 'NOT Jev finds “calm?” at least 50% likely (reads 0 of your messages and 2 replies)');
});
