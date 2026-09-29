import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRequests, analyzeStability } from '../libraries/core/pm-cache.js';

const sys = (block, content) => ({ role: 'system', content, _block: block });
const hist = (hid, content) => ({ role: hid % 2 ? 'assistant' : 'user', content, _hid: hid });
const count = () => 10;

test('two identical requests share everything', () => {
    const r = [sys('main', 'a'), hist(0, 'x')];
    const result = compareRequests(r, r.map(m => ({ ...m })), count);
    assert.equal(result.identical, true);
    assert.equal(result.ratio, 1);
});

test('a new message at the end keeps the whole earlier prompt as the shared prefix', () => {
    const a = [sys('main', 'a'), hist(0, 'x')];
    const result = compareRequests(a, [...a, hist(1, 'y')], count);
    assert.equal(result.sharedMessages, 2);
    assert.equal(result.culprit.reason, 'appended');
});

test('the first changed block is named as the culprit and everything after it is lost', () => {
    const a = [sys('main', 'a'), sys('graph', 'v1'), sys('rules', 'r'), hist(0, 'x')];
    const b = [sys('main', 'a'), sys('graph', 'v2'), sys('rules', 'r'), hist(0, 'x')];
    const result = compareRequests(a, b, count);
    assert.equal(result.culprit.block, 'graph');
    assert.equal(result.sharedMessages, 1);
    assert.equal(result.ratio, 0.25);
});

test('stable blocks standing after a changing block are reported as recoverable', () => {
    const req = graph => [sys('main', 'm'), sys('graph', graph), sys('rules', 'stable rules'), hist(0, 'x')];
    const result = analyzeStability([req('1'), req('2'), req('3')], count);
    assert.deepEqual(result.volatile, ['graph']);
    assert.equal(result.recoverableTokens, 10);
    assert.deepEqual(result.advice, [{ block: 'rules', movesAbove: 'graph' }]);
});

test('with fewer than two requests there is nothing to analyze', () => {
    assert.deepEqual(analyzeStability([[sys('a', 'x')]]).volatile, []);
});
