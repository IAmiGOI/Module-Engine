import test from 'node:test';
import assert from 'node:assert/strict';
import {
    draftFeatures, predictReady, learnReady, defaultWeights, emptyHistory,
    rememberSentLength, rememberPause, endsWithEnding, unclosedQuoteOrStar,
} from '../libraries/core/draft-readiness.js';

const longDraft = ('I open the door slowly and look into the hall, then wait for an answer from the other side of the room. ').repeat(3).trim();
const shortComplete = 'I step through the door and wait.';

test('features: length is logarithmic, ending marks and an unclosed quote are visible', () => {
    const draft = `"${'word '.repeat(30)}"`;
    const balanced = draftFeatures({
        draft,
        pauseMs: 3000,
        history: { lengths: [100], pauses: [1000] },
    });
    assert.equal(balanced.ends, 1, 'a closing quote ends the draft');
    assert.equal(balanced.unclosed, 0, 'paired quotes are not unclosed');
    assert.ok(Math.abs(balanced.lengthRatio - (Math.log2(1 + draft.trim().length) - Math.log2(101))) < 1e-9, 'length compares on a log scale');
    assert.ok(balanced.pauseSeconds > 2.9 && balanced.pauseSeconds <= 3, 'seconds are reported, with a ceiling later');
    assert.ok(balanced.pauseRatio > 0, 'a pause longer than the usual one is positive');

    const open = draftFeatures({ draft: '"Hello there', pauseMs: 500, history: emptyHistory() });
    assert.equal(open.unclosed, 1);
    assert.equal(open.ends, 0, 'an open quote does not end the draft');

    assert.equal(endsWithEnding('Wait…'), true);
    assert.equal(endsWithEnding('and then'), false);
    assert.equal(unclosedQuoteOrStar('*a thought'), true);
    assert.equal(unclosedQuoteOrStar('*a thought*'), false);
});

test('default weights: a short broken draft waits, a long finished one fires after a pause', () => {
    const weights = defaultWeights();
    const short = draftFeatures({ draft: 'and then I', pauseMs: 500, history: emptyHistory() });
    const long = draftFeatures({ draft: longDraft, pauseMs: 3000, history: emptyHistory() });
    assert.ok(predictReady(weights, short) < 0.5, 'a short fragment is not a message');
    assert.ok(predictReady(weights, long) > 0.6, 'a long finished draft after a pause is ready');
});

test('after learning that the player writes long, short finished drafts stop firing', () => {
    let weights = defaultWeights();
    let history = emptyHistory();
    const before = predictReady(weights, draftFeatures({ draft: shortComplete, pauseMs: 2600, history }));
    assert.ok(before > 0.6, 'with no history this draft reads as ready');

    for (let index = 0; index < 30; index += 1) {
        const features = draftFeatures({ draft: longDraft, pauseMs: 3000, history });
        weights = learnReady(weights, features, 1, { rate: 0.1 });
        history = rememberSentLength(history, longDraft.length);
        history = rememberPause(history, 3000);
    }
    const after = predictReady(weights, draftFeatures({ draft: shortComplete, pauseMs: 2600, history }));
    assert.ok(after < 0.6, 'the same draft now reads as a short intermediate pause');
});

test('learning is one SGD step and does not mutate the old weights; history keeps only its tail', () => {
    const weights = defaultWeights();
    const features = draftFeatures({ draft: longDraft, pauseMs: 3000, history: emptyHistory() });
    const next = learnReady(weights, features, 1, { rate: 0.5 });
    assert.notDeepEqual(next, weights);
    assert.deepEqual(weights, defaultWeights(), 'the old weights are untouched');

    let history = emptyHistory();
    for (let index = 0; index < 60; index += 1) history = rememberSentLength(history, 10 + index);
    assert.equal(history.lengths.length, 50, 'only the last 50 sent lengths are kept');
    assert.equal(history.lengths.at(-1), 69);
    for (let index = 0; index < 250; index += 1) history = rememberPause(history, 100 + index);
    assert.equal(history.pauses.length, 200, 'only the last 200 pauses are kept');
    assert.equal(history.pauses.at(-1), 349);
});
