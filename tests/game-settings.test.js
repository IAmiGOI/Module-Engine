import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GAME_OPTIONS, DEFAULT_GAME_SETTINGS, GAME_MODES, clampGameSettings, modeValues, modeOf,
    patchGameSettings, resolveGameSettings, difficultyShift, bootstrapQuestionCount,
} from '../libraries/core/game-settings.js';
import { computeProbability, PROBABILITY_TABLE, EXPERIENCE_LEVELS, DIFFICULTY_LEVELS, assessAction } from '../libraries/core/decision-probability.js';
import { createAssessHandler } from '../cores/decision/handlers-assess.js';
import { createBootstrap } from '../cores/decision/bootstrap.js';
import { buildRollLine } from '../libraries/core/decision-push.js';

const valueOf = (settings, id) => settings[id];

test('every mode sets exactly its own values and the rest stay Classic', () => {
    const marked = {
        story: { difficulty: 'easy', consequences: 'safe', pacing: 'eventful', initiative: 'living', canon: 'flavoured', romance: 'fast', tone: 'light' },
        classic: {},
        hardcore: { difficulty: 'hard', consequences: 'lethal', initiative: 'relentless', tone: 'dark' },
    };
    for (const mode of GAME_MODES) {
        const values = modeValues(mode.id);
        for (const option of GAME_OPTIONS) {
            const expected = marked[mode.id][option.id] ?? DEFAULT_GAME_SETTINGS[option.id];
            assert.equal(valueOf(values, option.id), expected, `${mode.id}.${option.id}`);
        }
        assert.equal(modeOf(values), mode.id, `${mode.id} is recognised by its own set`);
    }
});

test('a manual edit makes the set Custom and keeps everything else', () => {
    const story = modeValues('story');
    const edited = patchGameSettings(story, { tone: 'dark' });
    assert.equal(modeOf(edited), 'custom');
    assert.equal(edited.tone, 'dark');
    for (const option of GAME_OPTIONS) {
        if (option.id === 'tone') continue;
        assert.equal(edited[option.id], story[option.id], `${option.id} is kept`);
    }
    // Ручной возврат всех значений к готовому набору снова даёт его имя, а не Custom.
    assert.equal(modeOf(patchGameSettings(edited, { tone: 'light' })), 'story');
});

test('garbage on disk is clamped to Classic instead of leaking into a turn', () => {
    const clean = clampGameSettings({ difficulty: 'impossible', tone: 42, unknown: 'x', consequences: null });
    assert.deepEqual(clean, DEFAULT_GAME_SETTINGS);
    assert.deepEqual(clampGameSettings('nonsense'), DEFAULT_GAME_SETTINGS);
});

test('a new chat takes the saved default, and Classic when there is none', () => {
    const saved = { difficulty: 'brutal', tone: 'dark' };
    assert.equal(resolveGameSettings(null, saved).difficulty, 'brutal');
    assert.equal(resolveGameSettings(null, saved).tone, 'dark');
    assert.deepEqual(resolveGameSettings(null, null), DEFAULT_GAME_SETTINGS);
    assert.equal(resolveGameSettings({ difficulty: 'easy' }, saved).difficulty, 'easy', 'the chat wins over the default');
});

test('the difficulty shift moves the table column on every row and stops at the edges', () => {
    for (const experience of EXPERIENCE_LEVELS) {
        for (let index = 0; index < DIFFICULTY_LEVELS.length; index += 1) {
            const difficulty = DIFFICULTY_LEVELS[index];
            assert.equal(computeProbability(experience, difficulty, -1), PROBABILITY_TABLE[EXPERIENCE_LEVELS.indexOf(experience)][Math.max(0, index - 1)], `${experience}/${difficulty} easy`);
            assert.equal(computeProbability(experience, difficulty, 1), PROBABILITY_TABLE[EXPERIENCE_LEVELS.indexOf(experience)][Math.min(DIFFICULTY_LEVELS.length - 1, index + 1)], `${experience}/${difficulty} hard`);
            assert.equal(computeProbability(experience, difficulty, 2), PROBABILITY_TABLE[EXPERIENCE_LEVELS.indexOf(experience)][Math.min(DIFFICULTY_LEVELS.length - 1, index + 2)], `${experience}/${difficulty} brutal`);
        }
    }
    assert.equal(computeProbability('novice', 'trivial', -1), PROBABILITY_TABLE[1][0], 'easy cannot go past the easy edge');
    assert.equal(computeProbability('novice', 'nearly impossible', 2), PROBABILITY_TABLE[1][5], 'brutal stops at the hard edge');
    assert.equal(computeProbability('legendary', 'hard', 1), null);
});

test('difficulty applies to every roll, NPC rolls included', async () => {
    const game = { difficulty: 'brutal' };
    const state = { assessments: new Map(), assessmentCounter: 0, runId: 'r1' };
    const handler = createAssessHandler({ state, getSettings: () => ({}), getGameSettings: () => game });
    const answer = await handler({ kind: 'body', character: 'Kael', action: 'picks the lock', difficulty: 'moderate', experience: 'novice', why: 'The lock is old.', comment: 'A roll.' });
    assert.equal(answer.ok, true);
    assert.equal(answer.probability, Math.round(PROBABILITY_TABLE[1][4] * 1000) / 1000, 'moderate +2 columns is very hard');
    assert.equal(answer.difficulty, 'moderate', 'the director still names the level it picked');
    const flat = assessAction({ difficulty: 'moderate', experience: 'novice', difficultyShift: difficultyShift('normal') });
    assert.equal(flat.probability, PROBABILITY_TABLE[1][2]);
});

test('bootstrap reads its question limit from the game settings', async () => {
    const calls = [];
    const memory = new Map();
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? memory.get(params.key) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return true; }
        if (contract === 'chatHistory.messages') return [{ mes: 'The greeting.', is_user: false }];
        return undefined;
    };
    const store = { cycles: () => [] };
    const cycle = { runBootstrap: async options => { calls.push(options); return { briefWritten: true }; } };
    const bootstrap = createBootstrap({
        call, store, cycle,
        getSettings: () => ({ bootstrap: { maxQuestions: 5, maxSteps: 30, timeoutMs: 1000 } }),
        getGameSettings: () => ({ bootstrapQuestions: 'many' }),
        publishEvent: () => {},
    });
    await bootstrap.maybeStart();
    assert.equal(calls[0].maxQuestions, 8);
    assert.equal(bootstrapQuestionCount({ bootstrapQuestions: 'few' }), 2);
    assert.equal(bootstrapQuestionCount({ bootstrapQuestions: 'normal' }), 5);
    assert.equal(bootstrapQuestionCount({ bootstrapQuestions: 'garbage' }), 5);
});

test('the roll line names who, what and how well, and never a number', () => {
    const form = { characters: [
        { name: 'Kael', action: 'picks the lock', assessId: 'a1' },
        { name: 'Mira', action: 'watches', idle: true },
        { name: 'Puck', action: 'slips away' },
    ] };
    const assessments = new Map([['a1', { probability: 0.62, roll: 0.4, degree: 'clean', words: 'cleanly, without a hitch' }]]);
    const line = buildRollLine({ form, assessments });
    assert.equal(line, 'Kael — picks the lock — cleanly, without a hitch');
    assert.doesNotMatch(line, /\d|%/);
    assert.equal(buildRollLine({ form: { characters: [] }, assessments: new Map() }), '');
});
