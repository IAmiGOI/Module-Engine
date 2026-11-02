import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DIFFICULTY_ANCHORS, EXPERIENCE_ANCHORS, DEGREE_BANDS,
    lexicalSimilarity, projectPhrase, effectiveDifficulty, computeProbability,
    rollFromSeed, degreeFor, assessAction,
} from '../libraries/core/decision-probability.js';

const near = (actual, expected, tolerance = 0.02) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is within ${tolerance} of ${expected}`);

test('the reference scales cover both ends and every band of the outcome dictionary is reachable', () => {
    assert.equal(DIFFICULTY_ANCHORS[0].value, 0);
    assert.equal(DIFFICULTY_ANCHORS.at(-1).value, 1);
    assert.equal(EXPERIENCE_ANCHORS[0].value, 0);
    assert.equal(EXPERIENCE_ANCHORS.at(-1).value, 1);
    assert.deepEqual(DEGREE_BANDS.map(band => band.id), ['flawless', 'clean', 'barely', 'clumsy', 'botched']);
});

test('lexicalSimilarity() matches whole phrases and shared words, and gives zero for unrelated text', () => {
    near(lexicalSimilarity('trivial', 'trivial'), 1);
    assert.ok(lexicalSimilarity('very hard', 'hard') > 0.3);
    assert.equal(lexicalSimilarity('weather', 'impossible'), 0);
});

test('projectPhrase() lands a word near its own anchor, and the middle of the scale when nothing matches', () => {
    near(projectPhrase('trivial', DIFFICULTY_ANCHORS), 0, 0.05);
    near(projectPhrase('impossible', DIFFICULTY_ANCHORS), 1, 0.05);
    near(projectPhrase('master', EXPERIENCE_ANCHORS), 1, 0.05);
    near(projectPhrase('novice', EXPERIENCE_ANCHORS), 0, 0.05);
    assert.equal(projectPhrase('zzz qqq', DIFFICULTY_ANCHORS), 0.5);
});

test('difficulty sits on an absolute scale: trivial is below a novice, impossible is above a master', () => {
    assert.equal(effectiveDifficulty(0), -0.5);
    assert.equal(effectiveDifficulty(0.5), 0.5);
    assert.equal(effectiveDifficulty(1), 1.5);
});

test('probability is 0.5 at parity, high for a master on a trivial task, low for a novice on an impossible one', () => {
    near(computeProbability(0.5, 0.5), 0.5, 0.001);
    assert.ok(computeProbability(0, 0) > 0.85, 'novice on a trivial task still succeeds most of the time');
    assert.ok(computeProbability(1, 1) < 0.15, 'a master cannot do the impossible');
    assert.ok(computeProbability(1, 0) > 0.99);
    assert.ok(computeProbability(0, 1) < 0.01);
});

test('the same seed always produces the same roll — tests never depend on Math.random', () => {
    assert.equal(rollFromSeed(42), rollFromSeed(42));
    assert.notEqual(rollFromSeed(42), rollFromSeed(43));
    assert.ok(rollFromSeed(42) >= 0 && rollFromSeed(42) < 1);
});

test('degree bands turn probability minus roll into the words the Push carries', () => {
    assert.equal(degreeFor(0.8, 0.1).id, 'flawless');
    assert.equal(degreeFor(0.8, 0.65).id, 'barely');
    assert.equal(degreeFor(0.3, 0.45).id, 'clumsy');
    assert.equal(degreeFor(0.2, 0.6).id, 'botched');
    assert.match(degreeFor(0.8, 0.1).words, /flawless/);
});

test('assessAction() gives the documented examples: a trivial task and an impossible one are far apart', () => {
    const trivial = assessAction({ character: 'Lena', action: 'opens the door', difficulty: 'trivial', experience: 'novice', seed: 1 });
    const impossible = assessAction({ character: 'Lena', action: 'stops time', difficulty: 'impossible', experience: 'novice', seed: 1 });
    assert.ok(trivial.probability > 0.8);
    assert.ok(impossible.probability < 0.05);
    assert.equal(trivial.roll, Math.round(rollFromSeed(1) * 1000) / 1000);
    assert.ok(['flawless', 'clean'].includes(trivial.degree));
    assert.equal(impossible.degree, 'botched');
});

test('a fully seeded assessment is reproducible — the engine, not the model, owns the dice', () => {
    const first = assessAction({ character: 'Lena', action: 'picks the lock', difficulty: 'hard', experience: 'skilled', seed: 7 });
    const second = assessAction({ character: 'Lena', action: 'picks the lock', difficulty: 'hard', experience: 'skilled', seed: 7 });
    assert.deepEqual(first, second);
});
