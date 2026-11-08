import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutLegacyBlocks } from '../libraries/core/decision-legacy-blocks.js';

test('the old pre-five-role blocks leave the sections, their trees and preset copies; FOV and Range stay', () => {
    const sections = {
        director: { blocks: [{ id: 'd1', name: 'PSYCHO' }, { id: 'd2', name: 'Where?' }], tree: [{ type: 'item', block: 'd1' }, { type: 'group', children: [{ type: 'item', block: 'd2' }] }], presets: [{ blocks: [{ id: 'd1', name: 'PSYCHO' }] }] },
        writer: { blocks: [{ id: 'w1', name: 'FOV' }, { id: 'w2', name: 'Range' }, { id: 'w3', name: 'New prompt' }], tree: [{ type: 'item', block: 'w1' }, { type: 'item', block: 'w3' }], presets: [{ blocks: [{ name: 'Goal Guidelines' }, { name: 'FOV' }] }] },
    };
    const { sections: next, removed } = withoutLegacyBlocks(sections);
    assert.deepEqual(next.director.blocks, []);
    assert.deepEqual(next.director.tree, [{ type: 'group', children: [] }]);
    assert.deepEqual(next.director.presets[0].blocks, []);
    assert.deepEqual(next.writer.blocks.map(block => block.name), ['FOV', 'Range']);
    assert.deepEqual(next.writer.tree, [{ type: 'item', block: 'w1' }]);
    assert.deepEqual(next.writer.presets[0].blocks.map(block => block.name), ['FOV']);
    assert.equal(removed.length, 3);
    assert.deepEqual(withoutLegacyBlocks(next).removed, [], 'a second pass removes nothing');
});
