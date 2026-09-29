import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRule, applyRules, importStRegexScripts } from '../libraries/core/pm-rules.js';

const msg = (role, content, extra = {}) => ({ role, content, ...extra });
const text = (find, replace, scope) => ({ id: 'r', enabled: true, find: { kind: 'text', ...find }, replace, scope });

test('a phrase is replaced everywhere in the prompt, ignoring case by default', () => {
    const out = applyRules([msg('user', 'Dragon and dragon')], [text({ value: 'dragon' }, 'wyrm')]);
    assert.equal(out[0].content, 'wyrm and wyrm');
});

test('case sensitive and whole word options narrow the match', () => {
    assert.equal(applyRules([msg('user', 'Art and party')], [text({ value: 'art', wholeWord: true }, 'X')])[0].content, 'X and party');
    assert.equal(applyRules([msg('user', 'Art art')], [text({ value: 'art', caseSensitive: true }, 'X')])[0].content, 'Art X');
});

test('a phrase can be removed and a block between two marks can be cut out', () => {
    assert.equal(applyRules([msg('assistant', 'hi <think>secret\nthoughts</think> there')], [{ enabled: true, find: { kind: 'between', from: '<think>', to: '</think>' } }])[0].content, 'hi  there');
    assert.equal(applyRules([msg('user', 'a b c')], [{ enabled: true, find: { kind: 'remove', value: ' b' } }])[0].content, 'a c');
});

test('the rule only touches the chosen roles, the chosen depth and the chosen part of the prompt', () => {
    const list = [msg('system', 'dragon', { _block: 'main' }), msg('user', 'dragon', { _hid: 0 }), msg('assistant', 'dragon', { _hid: 1 }), msg('user', 'dragon', { _hid: 2 })];
    assert.deepEqual(applyRules(list, [text({ value: 'dragon' }, 'X', { roles: ['user'] })]).map(m => m.content), ['dragon', 'X', 'dragon', 'X']);
    assert.deepEqual(applyRules(list, [text({ value: 'dragon' }, 'X', { maxDepth: 1 })]).map(m => m.content), ['dragon', 'dragon', 'X', 'X']);
    assert.deepEqual(applyRules(list, [text({ value: 'dragon' }, 'X', { targets: 'prompt' })]).map(m => m.content), ['X', 'dragon', 'dragon', 'dragon']);
    assert.deepEqual(applyRules(list, [text({ value: 'dragon' }, 'X', { targets: 'history', minDepth: 1 })]).map(m => m.content), ['dragon', 'X', 'X', 'dragon']);
});

test('a disabled rule, an empty rule and a broken regex do nothing and never throw', () => {
    const list = [msg('user', 'abc')];
    assert.equal(applyRules(list, [{ ...text({ value: 'a' }, 'X'), enabled: false }])[0].content, 'abc');
    assert.equal(applyRules(list, [text({ value: '' }, 'X')])[0].content, 'abc');
    assert.equal(compileRule({ find: { kind: 'regex', pattern: '(' } }), null);
    assert.equal(applyRules(list, [{ enabled: true, find: { kind: 'regex', pattern: '(' } }])[0].content, 'abc');
});

test('regex rules use capture groups and macros in the replacement are substituted', () => {
    const rule = { enabled: true, find: { kind: 'regex', pattern: '(\\w+) said', flags: 'i' }, replace: '$1 whispered to {{user}}' };
    assert.equal(applyRules([msg('user', 'Lena said hi')], [rule], { substitute: t => t.replace('{{user}}', 'Sasha') })[0].content, 'Lena whispered to Sasha hi');
});

test('tool messages and service fields are left alone', () => {
    const out = applyRules([msg('tool', 'dragon', { tool_call_id: 'c' }), msg('user', 'dragon', { _hid: 3 })], [text({ value: 'dragon' }, 'X')]);
    assert.equal(out[0].content, 'dragon');
    assert.equal(out[1]._hid, 3);
});

test('ST regex scripts become rules: prompt-affecting ones only, roles from the placement, disabled kept disabled', () => {
    const rules = importStRegexScripts([
        { scriptName: 'strip think', findRegex: '/<think>[\\s\\S]*?<\\/think>/gi', replaceString: '', placement: [2], promptOnly: true, disabled: false, minDepth: 1 },
        { scriptName: 'display only', findRegex: '/x/', replaceString: 'y', placement: [2], markdownOnly: true },
        { scriptName: 'off', findRegex: '/a/', replaceString: 'b', placement: [1, 2], promptOnly: true, disabled: true },
    ]);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0].scope, { roles: ['assistant'], minDepth: 1, maxDepth: undefined, targets: 'all' });
    assert.equal(rules[1].enabled, false);
    assert.equal(applyRules([msg('assistant', 'a<think>x</think>b', { _hid: 0 }), msg('user', 'u', { _hid: 1 })], [rules[0]])[0].content, 'ab');
});
