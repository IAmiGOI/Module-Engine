import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TAGGING_BATCH_SIZE, TAGGING_MAX_DESCRIPTION, TAGGING_INSTRUCTION, batchTracks, buildTaggingPrompt, parseTaggingReply, cleanDescription, embeddingText, sanitizeTagKind, TAG_KINDS,
} from '../libraries/shared/music-tagging.js';

test('tracks go to the model in batches; the last batch may be shorter', () => {
    const items = Array.from({ length: 23 }, (_, index) => ({ id: index }));
    assert.deepEqual(batchTracks(items).map(batch => batch.length), [10, 10, 3]);
    assert.equal(TAGGING_BATCH_SIZE, 10);
    assert.deepEqual(batchTracks([]), []);
});

test('the prompt is a numbered list of "title — artist"; the instruction asks for meaning, not lyrics, and for JSON only', () => {
    const prompt = buildTaggingPrompt([{ name: 'Song   One', artist: 'Some Artist' }, { name: 'Untitled Piece' }, { name: '' }]);
    assert.match(prompt, /^Tracks:\n1\. Song One — Some Artist\n2\. Untitled Piece\n3\. Untitled\n/);
    assert.match(TAGGING_INSTRUCTION, /scene/i);
    assert.match(TAGGING_INSTRUCTION, /Never invent lyrics/);
    assert.match(TAGGING_INSTRUCTION, /ONLY a JSON array/);
});

test('a clean JSON reply maps descriptions to tracks by number', () => {
    const reply = '[{"n":1,"d":"Slow, wistful piano for a quiet farewell at dusk."},{"n":2,"d":"Driving percussion and brass for a chase through the streets."}]';
    assert.deepEqual(parseTaggingReply(reply, 2), ['Slow, wistful piano for a quiet farewell at dusk.', 'Driving percussion and brass for a chase through the streets.']);
});

test('replies wrapped in code fences, text or an object are still read; other keys and a missing number are tolerated', () => {
    const fenced = 'Sure!\n```json\n[{"n":2,"description":"Warm acoustic guitar for a campfire evening."}]\n```\nHope this helps.';
    assert.deepEqual(parseTaggingReply(fenced, 3), [null, 'Warm acoustic guitar for a campfire evening.', null]);
    const wrapped = '{"tracks":[{"d":"Ominous low strings for a tense negotiation."},{"d":"Bright chiptune energy for a triumphant arrival."}]}';
    assert.deepEqual(parseTaggingReply(wrapped, 2), ['Ominous low strings for a tense negotiation.', 'Bright chiptune energy for a triumphant arrival.'], 'no numbers — by position');
});

test('garbage, a truncated array and out-of-range numbers never throw and never shift descriptions onto the wrong track', () => {
    assert.deepEqual(parseTaggingReply('I cannot do that.', 2), [null, null]);
    assert.deepEqual(parseTaggingReply('', 2), [null, null]);
    assert.deepEqual(parseTaggingReply(undefined, 1), [null]);
    assert.deepEqual(parseTaggingReply('[{"n":1,"d":"Calm ambient pads for a still lake at dawn."}, {"n":2,"d":"Cut off mid', 2), ['Calm ambient pads for a still lake at dawn.', null], 'the complete entries survive a cut-off reply');
    assert.deepEqual(parseTaggingReply('[{"n":9,"d":"Way out of range for this batch."},{"n":0,"d":"Zero is not a track number."}]', 2), [null, null]);
    assert.deepEqual(parseTaggingReply('[{"n":1,"d":""},{"n":2,"d":"ok"}]', 2), [null, null], 'empty and too-short descriptions are dropped');
});

test('a long description is cut at a word; quotes around it are stripped', () => {
    const long = `${'word '.repeat(120)}end`;
    const cleaned = cleanDescription(long);
    assert.ok(cleaned.length <= TAGGING_MAX_DESCRIPTION + 1);
    assert.ok(cleaned.endsWith('…') && !cleaned.slice(0, -1).endsWith('wor'), 'cut on a word boundary');
    assert.equal(cleanDescription('“Soft rain and low synth pads for a sleepless city night.”'), 'Soft rain and low synth pads for a sleepless city night.');
});

test('the text that gets embedded keeps who the track is and what it is about; the tag kind is repaired', () => {
    assert.equal(embeddingText({ name: 'Song', artist: 'Artist', description: 'Slow piano.' }), 'Song — Artist. Slow piano.');
    assert.equal(embeddingText({ name: 'Song', description: 'Slow piano.' }), 'Song. Slow piano.');
    assert.equal(embeddingText({ name: 'Song', artist: 'Artist' }), 'Song — Artist');
    assert.equal(sanitizeTagKind('model'), 'model');
    assert.equal(sanitizeTagKind('nonsense'), TAG_KINDS.NAME);
    assert.equal(sanitizeTagKind(undefined), 'name');
});
