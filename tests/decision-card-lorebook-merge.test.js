import test from 'node:test';
import assert from 'node:assert/strict';
import { bankSourcesForChat } from '../libraries/core/decision-banks.js';

test('a card and a lorebook entry about the same character become one source, by name or alias, with no model', () => {
    const sources = bankSourcesForChat({
        cards: [{ avatar: 'Mara.png', name: 'Mara', description: 'A courier.' }],
        lorebookEntries: [{ book: 'World', uid: 3, comment: 'Mara Voss', key: ['Mara', 'Voss'], content: 'Mara Voss runs the night route.' }],
        lorebookMarks: { World: { marks: [{ uid: 3, name: 'Mara Voss', aliases: ['Mara', 'Voss'] }] } },
    });
    const people = sources.filter(source => source.sourceKind !== 'scene');
    assert.equal(people.length, 1);
    assert.equal(people[0].sourceKind, 'card');
    assert.match(people[0].source, /night route/);
    assert.ok(people[0].aliases.includes('Mara Voss'));
});
