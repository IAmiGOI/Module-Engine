import test from 'node:test';
import assert from 'node:assert/strict';
import { createLorebookMarker } from '../cores/decision/lorebook-marker.js';

const ENTRIES = [
    { book: 'Story', uid: 1, comment: '-- VILLAINS --', content: '' },
    { book: 'Story', uid: 2, comment: 'Rem (Still comatose lmao)', key: 'Rem-tan, Rem', content: 'A demon maid.' },
];

function build(reply) {
    const replies = Array.isArray(reply) ? [...reply] : null;
    const prompts = [];
    const marker = createLorebookMarker({
        call: async (contract, params) => {
            assert.equal(contract, 'model.generate');
            prompts.push(params);
            return replies ? replies.shift() : reply;
        },
        getSettings: () => ({ decider: { workerId: 'director' } }),
        getWorkers: () => [{ id: 'director', format: 'openai', model: 'director/model' }],
        publishEvent: () => {},
    });
    return { marker, prompts };
}

test('one marking call returns clean names, aliases and optional franchise, and ignores bad rows', async () => {
    const { marker, prompts } = build({
        text: '', toolCalls: [{
            id: 'mark', name: 'mark_lorebook_characters', arguments: {
                comment: 'These entries describe single characters.',
                characters: [
                    { uid: 2, name: 'Rem', aliases: ['Rem-tan', 'Rem'], importance: 'key', franchise: '' },
                    { uid: 999, name: 'Ghost', importance: 'key' },
                    { uid: 2, name: 'Rem again' },
                    { uid: 1, name: '' },
                ],
            },
        }],
    });
    const result = await marker.mark({ book: 'Story', entries: ENTRIES, cardHint: 'Aria — isekai' });
    assert.deepEqual(result.marks, [{ uid: 2, name: 'Rem', aliases: ['Rem-tan', 'Rem'], franchise: '' }]);
    assert.equal(result.ignored.length, 3);
    const prompt = prompts[0].messages[0].content;
    assert.match(prompt, /BOOK: Story/);
    assert.match(prompt, /CHAT CHARACTER: Aria — isekai/);
    assert.match(prompt, /-- VILLAINS --/);
    assert.match(prompt, /2 \| Rem \(Still comatose lmao\) \| Rem-tan, Rem \| A demon maid\./);
});

test('importance is not the marker\'s business, and a missing franchise stays empty', async () => {
    const { marker } = build({ text: '', toolCalls: [{ id: 'm', name: 'mark_lorebook_characters', arguments: { comment: 'A character.', characters: [{ uid: 2, name: 'Rem', importance: 'legendary' }] } }] });
    const result = await marker.mark({ book: 'Story', entries: ENTRIES });
    assert.equal('importance' in result.marks[0], false);
    assert.equal(result.marks[0].franchise, '');
});

test('an answer without the marking tool is a failure, so the caller can use the section fallback', async () => {
    const { marker } = build({ text: 'I think they are all characters.', toolCalls: [] });
    await assert.rejects(() => marker.mark({ book: 'Story', entries: ENTRIES }), /did not mark/);
});

test('a call rejected for a missing comment is retried, and a good marking ends the cycle without an extra request', async () => {
    const good = { text: '', toolCalls: [{ id: 'b', name: 'mark_lorebook_characters', arguments: { comment: 'Rem is a single character.', characters: [{ uid: 2, name: 'Rem' }] } }] };
    const { marker, prompts } = build([
        { text: '', toolCalls: [{ id: 'a', name: 'mark_lorebook_characters', arguments: { characters: [{ uid: 2, name: 'Rem' }] } }] },
        good,
        good,
    ]);
    const result = await marker.mark({ book: 'Story', entries: ENTRIES });
    assert.equal(result.marks.length, 1);
    assert.equal(prompts.length, 2);
});

test('a failed marking names the reason', async () => {
    const bad = { text: '', toolCalls: [{ id: 'a', name: 'mark_lorebook_characters', arguments: { characters: [] } }] };
    const { marker } = build([bad, bad, bad, bad, bad, bad]); // две попытки по три шага
    await assert.rejects(() => marker.mark({ book: 'Story', entries: ENTRIES }), /did not mark the lorebook characters: .*comment/i);
});
