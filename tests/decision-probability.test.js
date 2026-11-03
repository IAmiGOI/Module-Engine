import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DIFFICULTY_LEVELS, EXPERIENCE_LEVELS, PROBABILITY_TABLE, DEGREE_BANDS,
    computeProbability, rollFromSeed, degreeFor, assessAction, levelProblem,
} from '../libraries/core/decision-probability.js';

const near = (actual, expected, tolerance = 0.02) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is within ${tolerance} of ${expected}`);

test('the two level lists are the only levels the engine accepts', () => {
    assert.deepEqual(DIFFICULTY_LEVELS, ['trivial', 'easy', 'moderate', 'hard', 'very hard', 'nearly impossible']);
    assert.deepEqual(EXPERIENCE_LEVELS, ['none', 'novice', 'practised', 'skilled', 'expert', 'master']);
    assert.equal(PROBABILITY_TABLE.length, 6);
    assert.equal(PROBABILITY_TABLE.every(row => row.length === 6), true);
    assert.deepEqual(DEGREE_BANDS.map(band => band.id), ['flawless', 'clean', 'barely', 'clumsy', 'botched']);
});

test('the documented examples land where the owner asked', () => {
    near(computeProbability('novice', 'hard'), 0.15, 0.001);
    near(computeProbability('master', 'nearly impossible'), 0.10, 0.001);
    near(computeProbability('skilled', 'moderate'), 0.75, 0.001);
});

test('experience and difficulty actually move the chance, instead of collapsing to 0.5', () => {
    assert.ok(computeProbability('novice', 'hard') < computeProbability('master', 'hard') / 3, 'a master on the same hard task is far above a novice');
    assert.ok(computeProbability('master', 'nearly impossible') < computeProbability('novice', 'trivial'), 'the impossible stays out of reach even for a master');
    for (let index = 1; index < EXPERIENCE_LEVELS.length; index += 1) {
        for (let column = 0; column < DIFFICULTY_LEVELS.length; column += 1) {
            assert.ok(PROBABILITY_TABLE[index][column] >= PROBABILITY_TABLE[index - 1][column], 'more experience never lowers the chance');
        }
    }
});

test('an unknown level is refused with the list of allowed levels, never guessed', () => {
    assert.equal(computeProbability('legendary', 'hard'), null);
    assert.equal(computeProbability('novice', 'impossible'), null);
    assert.match(levelProblem({ difficulty: 'hard', experience: 'legendary' }), /none, novice, practised, skilled, expert, master/);
    assert.match(levelProblem({ difficulty: 'impossible', experience: 'novice' }), /trivial, easy, moderate, hard, very hard, nearly impossible/);
    assert.equal(levelProblem({ difficulty: 'hard', experience: 'novice' }), '');
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

test('assessAction() uses the table, keeps the seed reproducible and refuses unknown levels', () => {
    const hardNovice = assessAction({ character: 'Lena', action: 'picks the lock', difficulty: 'hard', experience: 'novice', why: 'Wet stone and no tools.', seed: 7 });
    const hardMaster = assessAction({ character: 'Lena', action: 'picks the lock', difficulty: 'hard', experience: 'master', why: 'Wet stone and no tools.', seed: 7 });
    assert.equal(hardNovice.ok, true);
    assert.ok(hardMaster.probability > hardNovice.probability);
    assert.deepEqual(hardNovice, assessAction({ character: 'Lena', action: 'picks the lock', difficulty: 'hard', experience: 'novice', why: 'Wet stone and no tools.', seed: 7 }));
    assert.equal(hardNovice.difficulty, 'hard');
    assert.equal(hardNovice.experience, 'novice');
    const refused = assessAction({ character: 'Lena', action: 'picks the lock', difficulty: 'legendary', experience: 'novice', why: 'x', seed: 1 });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Unknown difficulty/);
});
