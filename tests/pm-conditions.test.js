import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition } from '../libraries/core/pm-conditions.js';

const msgs = (...texts) => texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', text }));
const facts = (extra = {}) => ({ messages: msgs('I attack the dragon', 'It roars'), chatLength: 10, vars: new Map(), random: () => 0.5, ...extra });

test('an empty condition is true and an unknown type without a plugin is false', () => {
    assert.equal(evaluateCondition(null, facts()), true);
    assert.equal(evaluateCondition({ type: 'weird' }, facts()), false);
});

test('keyword looks only at the chosen number of recent messages and the chosen speaker', () => {
    assert.equal(evaluateCondition({ type: 'keyword', words: ['dragon'], scan: 1 }, facts()), true);
    assert.equal(evaluateCondition({ type: 'keyword', words: ['roars'], scan: 1, source: 'user' }, facts()), false);
    assert.equal(evaluateCondition({ type: 'keyword', words: ['/dr.gon/'], scan: 2 }, facts()), true);
});

test('all, any and not combine conditions', () => {
    const yes = { type: 'chance', percent: 100 }, no = { type: 'chance', percent: 0 };
    assert.equal(evaluateCondition({ type: 'all', items: [yes, no] }, facts()), false);
    assert.equal(evaluateCondition({ type: 'any', items: [yes, no] }, facts()), true);
    assert.equal(evaluateCondition({ type: 'not', item: no }, facts()), true);
});

test('message length, tracker values and variables compare as numbers when they are numbers', () => {
    assert.equal(evaluateCondition({ type: 'messageLength', source: 'lastUser', op: '>', value: 10 }, facts()), true);
    assert.equal(evaluateCondition({ type: 'tracker', trackerId: 't', field: 'hp', op: '<', value: 30 }, facts({ tracker: () => '5' })), true);
    assert.equal(evaluateCondition({ type: 'variable', name: 'tense', op: '=', value: 'past' }, facts({ vars: new Map([['tense', 'past']]) })), true);
});

test('every N fires on every N-th message and cooldown mutes the next turns', () => {
    assert.equal(evaluateCondition({ type: 'everyN', n: 5 }, facts()), true);
    assert.equal(evaluateCondition({ type: 'everyN', n: 3 }, facts()), false);
    const timed = {};
    const cool = { type: 'cooldown', key: 'k', turns: 3 };
    assert.equal(evaluateCondition(cool, facts({ timed, chatLength: 10 })), true);
    assert.equal(evaluateCondition(cool, facts({ timed, chatLength: 12 })), false);
    assert.equal(evaluateCondition(cool, facts({ timed, chatLength: 13 })), true);
});

test('a plugin condition is used and a plugin that throws makes the condition false and is reported', () => {
    let reported = null;
    const plugins = { mood: leaf => leaf.mood === 'angry', broken: () => { throw new Error('boom'); } };
    assert.equal(evaluateCondition({ type: 'mood', mood: 'angry' }, facts({ plugins })), true);
    assert.equal(evaluateCondition({ type: 'broken' }, facts({ plugins, onPluginError: name => { reported = name; } })), false);
    assert.equal(reported, 'broken');
});
