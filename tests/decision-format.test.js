import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeciderResponse, applyBlockEdits, MAX_BLOCK_EDITS } from '../libraries/core/decision-format.js';

test('a fenced JSON answer is accepted: decision + add/update/remove edits, with the fence stripped', () => {
    const parsed = parseDeciderResponse('```json\n{"decision":"She draws the knife.","blocks":[{"op":"add","title":"Knife","text":"Hidden under the cloak."},{"op":"update","id":"blk_mood","text":"Alert."},{"op":"remove","id":"blk_old"}]}\n```');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.decision, 'She draws the knife.');
    assert.deepEqual(parsed.value.edits, [
        { op: 'add', id: '', title: 'Knife', text: 'Hidden under the cloak.' },
        { op: 'update', id: 'blk_mood', title: '', text: 'Alert.' },
        { op: 'remove', id: 'blk_old', title: '' },
    ]);
});

test('an answer without a decision, without JSON, and an empty answer are errors — never exceptions', () => {
    for (const raw of ['', '   ', 'I think she should run.', '{"blocks":[]}', '{"decision":"   "}', '[1,2,3]', '{"decision":']) {
        const parsed = parseDeciderResponse(raw);
        assert.equal(parsed.ok, false, JSON.stringify(raw));
        assert.ok(parsed.error.message);
    }
});

test('one malformed block edit does not lose the decision or the other edits — it is dropped with a warning', () => {
    const parsed = parseDeciderResponse(JSON.stringify({
        decision: 'He waits.',
        blocks: [
            { op: 'add', title: 'Broken' },
            { op: 'remove' },
            { op: 'add', title: 'Good', text: 'Still here.' },
            'not an object',
        ],
    }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.decision, 'He waits.');
    assert.deepEqual(parsed.value.edits, [{ op: 'add', id: '', title: 'Good', text: 'Still here.' }]);
    assert.equal(parsed.value.warnings.length, 3);
});

test(`more than ${MAX_BLOCK_EDITS} edits are capped, and the cap is reported`, () => {
    const blocks = Array.from({ length: MAX_BLOCK_EDITS + 3 }, (_, index) => ({ op: 'add', title: `B${index}`, text: 'x' }));
    const parsed = parseDeciderResponse(JSON.stringify({ decision: 'Go.', blocks }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.edits.length, MAX_BLOCK_EDITS);
    assert.match(parsed.value.warnings.at(-1), new RegExp(String(MAX_BLOCK_EDITS)));
});

test('applyBlockEdits adds, updates by id or title, removes, and keeps the list in order', () => {
    const blocks = [
        { id: 'blk_knife', title: 'Knife', text: 'Old', updatedAt: 1 },
        { id: 'blk_mood', title: 'Mood', text: 'Calm', updatedAt: 1 },
    ];
    const result = applyBlockEdits(blocks, [
        { op: 'update', id: 'blk_knife', title: '', text: 'New' },
        { op: 'update', id: '', title: 'mood', text: 'Alert' },
        { op: 'add', id: '', title: 'Goal', text: 'Find the exit' },
        { op: 'remove', id: 'blk_mood', title: '' },
    ], { now: () => 42 });
    assert.deepEqual(result.blocks.map(block => [block.id, block.title, block.text]), [
        ['blk_knife', 'Knife', 'New'],
        ['blk_goal', 'Goal', 'Find the exit'],
    ]);
    assert.deepEqual(result.applied.map(item => item.op), ['update', 'update', 'add', 'remove']);
    assert.equal(result.blocks[0].updatedAt, 42);
});

test('an update for an unknown block becomes an addition instead of being lost; a remove for an unknown block is a warning', () => {
    const result = applyBlockEdits([], [
        { op: 'update', id: 'missing', title: 'New block', text: 'Text' },
        { op: 'remove', id: 'also-missing', title: '' },
    ]);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].title, 'New block');
    assert.equal(result.applied[0].op, 'add');
    assert.match(result.warnings[0], /remove/);
});

test('generated ids are derived from the title and do not collide', () => {
    const result = applyBlockEdits([], [
        { op: 'add', id: '', title: 'Same title', text: 'one' },
        { op: 'add', id: '', title: 'same-title', text: 'two' },
    ]);
    assert.deepEqual(result.blocks.map(block => block.id), ['blk_same-title', 'blk_same-title_2']);
});
