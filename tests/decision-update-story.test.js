import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateStoryHandler } from '../cores/decision/handlers-story.js';
import { buildToolList } from '../libraries/core/decision-tools.js';

test('update_story runs each part through its own handler, keeps going past a failed part and reports it', async () => {
    const seen = [];
    const handler = createUpdateStoryHandler({
        character_knowledge: async args => { seen.push(['k', args.character, args.comment]); return { ok: true, id: 'kn1' }; },
        character_note: async args => (args.character === 'Ghost' ? { ok: false, error: 'no such character' } : (seen.push(['n', args.character]), { ok: true })),
        set_character_plan: async args => { seen.push(['p', args.character]); return { ok: true }; },
        set_plan: async args => { seen.push(['plan', args.direction]); return { ok: true }; },
    });
    const result = await handler({
        comment: 'The turn changed these.',
        knowledge: [{ op: 'add', character: 'Emilia', fact: 'f' }],
        notes: [{ character: 'Ghost', op: 'add' }, { character: 'Puck', op: 'add' }],
        characterPlans: [{ character: 'Ram', summary: 's' }],
        plan: { direction: 'd' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.done, 4);
    assert.deepEqual(result.errors, ['character_note Ghost: no such character']);
    assert.deepEqual(seen, [['k', 'Emilia', 'The turn changed these.'], ['n', 'Puck'], ['p', 'Ram'], ['plan', 'd']]);
});

test('update_story is in the tool list, and submit_turn requires beats', () => {
    const tools = buildToolList();
    assert.ok(tools.some(tool => tool.name === 'update_story'));
    assert.ok(tools.find(tool => tool.name === 'submit_turn').parameters.required.includes('beats'));
});
