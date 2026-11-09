import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGodToolList, buildDirectorToolList, buildCounsellorToolList, buildTurnToolList } from '../libraries/core/decision-tools.js';

const names = list => list.map(tool => tool?.name);

test('every role\'s tool list is made of real schemas: no undefined entry ever reaches the provider', () => {
    for (const [role, list] of Object.entries({
        god: buildGodToolList(), director: buildDirectorToolList(), counsellor: buildCounsellorToolList(), turn: buildTurnToolList(),
    })) {
        assert.ok(list.length > 0, `${role} has tools`);
        for (const tool of list) assert.ok(tool && typeof tool.name === 'string' && tool.name.trim(), `${role} has a nameless tool`);
    }
});

test('God edits the world as files: view, edit, create, questions, the review form and await', () => {
    assert.deepEqual(names(buildGodToolList()), ['view', 'edit', 'create', 'ask', 'review_creation', 'await']);
});

test('the Director ends its work with a real await, not a missing schema', () => {
    assert.equal(names(buildDirectorToolList()).at(-1), 'await');
    assert.ok(names(buildDirectorToolList()).includes('edit'), 'the Director edits decree.md as a file');
});
