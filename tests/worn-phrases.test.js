import test from 'node:test';
import assert from 'node:assert/strict';
import { wornPhrases, wornPhrasesBlock } from '../libraries/core/worn-phrases.js';

test('a phrase that stands in two recent replies is worn; one reply, or filler words alone, are not', () => {
    const replies = [
        'The words come level, measured out like coin on a counter. She waits.',
        'Rain on the roof. "No," she says, the words come level, measured out like coin on a counter.',
        'He laughs and the room is warm and the fire is low.',
    ];
    const worn = wornPhrases(replies);
    assert.ok(worn.some(item => item.includes('measured out like coin on a counter')), JSON.stringify(worn));
    assert.ok(!worn.some(item => item.includes('fire is low')));
    assert.equal(wornPhrasesBlock(['one reply only, nothing repeated here at all']), '');
    assert.match(wornPhrasesBlock(replies), /^WORN PHRASES — /);
});
