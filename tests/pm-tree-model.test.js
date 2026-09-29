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
