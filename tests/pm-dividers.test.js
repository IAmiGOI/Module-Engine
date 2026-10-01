import test from 'node:test';
import assert from 'node:assert/strict';
import { createDividerPair, applyDividers, computeBrokenPairs, collectDividerConditions, pickDividerColor, DIVIDER_PALETTE } from '../libraries/core/pm-dividers.js';
import { evaluateCondition } from '../libraries/core/pm-conditions.js';
import { assemblePrompt } from '../libraries/core/pm-assemble.js';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { resolveJevLeaf, computeJevQuestionKey, collectJevLeaves, computeJevState, groupJevCalls } from '../libraries/core/jev-question.js';
import { buildJevRequest, readJevAnswers, describeJevFailure } from '../libraries/core/jev-request.js';

const item = name => ({ type: 'item', block: name, enabled: true });
const names = nodes => nodes.map(node => node.block);
const JEV = { type: 'jev', question: 'The player is in danger.', minChance: 70 };

test('a divider pair is two strips of one colour with a shared pair id, the condition stays on the top strip, and nothing about them is a group', () => {
    const [begin, end] = createDividerPair({ color: DIVIDER_PALETTE[2], name: 'danger' });
    assert.deepEqual([begin.type, begin.edge, end.edge, begin.pair === end.pair, begin.color === end.color], ['divider', 'begin', 'end', true, true]);
    assert.equal(begin.children, undefined);
    assert.equal(begin.wrap, undefined);
});

test('the blocks between the strips go away when the condition is false and stay when it is true; the strips themselves are never sent', () => {
    const [begin, end] = createDividerPair();
    const list = [item('a'), begin, item('b'), item('c'), end, item('d')];
    assert.deepEqual(names(applyDividers(list, { passes: () => true }).nodes), ['a', 'b', 'c', 'd']);
    const hidden = applyDividers(list, { passes: () => false });
    assert.deepEqual(names(hidden.nodes), ['a', 'd']);
    assert.deepEqual(hidden.skipped.map(entry => [entry.blocks, entry.reason]), [[2, 'divider condition']]);
});

test('nested pairs work like brackets: a hidden outer region takes the inner one with it, a visible outer one lets the inner decide for itself', () => {
    const [outerBegin, outerEnd] = createDividerPair();
    const [innerBegin, innerEnd] = createDividerPair();
    const list = [item('a'), outerBegin, item('b'), innerBegin, item('c'), innerEnd, item('d'), outerEnd, item('e')];
    const only = pair => ({ passes: begin => begin.pair !== pair });
    assert.deepEqual(names(applyDividers(list, only(outerBegin.pair)).nodes), ['a', 'e'], 'the outer region closed');
    assert.deepEqual(names(applyDividers(list, only(innerBegin.pair)).nodes), ['a', 'b', 'd', 'e'], 'only the inner region closed');
    assert.equal(applyDividers(list, only(outerBegin.pair)).skipped.length, 1, 'one report entry for the region that was actually closed');
});

test('a turned-off strip lifts its condition: the blocks between always go, and a pair without its other half does nothing — a broken marking never loses blocks silently', () => {
    const [begin, end] = createDividerPair();
    const list = [begin, item('x'), end];
    assert.deepEqual(names(applyDividers([{ ...begin, enabled: false }, item('x'), end], { passes: () => false }).nodes), ['x']);
    const lonely = [item('a'), begin, item('b')];
    assert.deepEqual(names(applyDividers(lonely, { passes: () => false }).nodes), ['a', 'b']);
    assert.deepEqual(computeBrokenPairs(lonely).map(entry => entry.pair), [begin.pair]);
    assert.deepEqual(computeBrokenPairs(list), []);
    const reversed = [end, item('y'), begin];
    assert.equal(computeBrokenPairs(reversed).length, 1, 'the bottom strip above the top one is not a region');
});

test('the colour of a new pair is the first palette colour no strip uses yet, so nested pairs differ', () => {
    const [first] = createDividerPair({ color: pickDividerColor([]) });
    assert.equal(first.color, DIVIDER_PALETTE[0]);
    assert.equal(pickDividerColor([first]), DIVIDER_PALETTE[1]);
});

test('the Jev condition sends the block when the chance reaches the threshold, drops it below, and sends it when Jev did not answer at all', () => {
    const answer = chance => ({ jev: () => chance });
    assert.equal(evaluateCondition(JEV, answer(0.7)), true);
    assert.equal(evaluateCondition(JEV, answer(0.69)), false);
    assert.equal(evaluateCondition(JEV, answer(1)), true);
    assert.equal(evaluateCondition(JEV, { jev: () => undefined }), true, 'no answer: sent');
    assert.equal(evaluateCondition(JEV, {}), true, 'no classifier at all: sent');
    assert.equal(evaluateCondition({ type: 'not', item: JEV }, answer(0.9)), false);
});

const presetWith = tree => ({ ...stToPreset({ prompts: ['a', 'b', 'c', 'd'].map(id => ({ identifier: id, name: id, system_prompt: false, role: 'system', content: `text ${id}` })), prompt_order: [{ character_id: 100001, order: [] }] }), tree });

test('in a real assembly the region is dropped when Jev says no, kept when Jev says yes, kept when Jev is silent, and the report names the region', () => {
    const [begin, end] = createDividerPair({ name: 'danger' });
    const tree = [item('a'), { ...begin, condition: JEV }, item('b'), item('c'), end, item('d')];
    const run = jev => assemblePrompt(presetWith(tree), { markers: {}, history: [], facts: { jev } });
    assert.deepEqual(run(() => 0.2).messages.map(message => message.content), ['text a', 'text d']);
    assert.deepEqual(run(() => 0.9).messages.map(message => message.content), ['text a', 'text b', 'text c', 'text d']);
    assert.deepEqual(run(() => undefined).messages.map(message => message.content), ['text a', 'text b', 'text c', 'text d']);
    const gone = run(() => 0.2).report.find(line => line.name === 'danger');
    assert.deepEqual([gone.included, gone.reason, gone.blocks], [false, 'divider condition', 2]);
    const broken = assemblePrompt(presetWith([item('a'), { ...begin, condition: JEV }, item('b')]), { markers: {}, history: [], facts: { jev: () => 0 } });
    assert.deepEqual(broken.messages.map(message => message.content), ['text a', 'text b']);
    assert.ok(broken.report.some(line => line.reason === 'divider pair is not closed'));
});

test('the Jev conditions of the tree are found in strips, groups and nested conditions, once per question and chat slice, and disabled rows are ignored', () => {
    const [begin, end] = createDividerPair();
    const tree = [
        { ...begin, condition: { type: 'all', items: [JEV, { type: 'chance', percent: 10 }] } },
        { type: 'group', enabled: true, children: [{ ...item('a'), condition: { type: 'not', item: { ...JEV } } }, { ...item('b'), condition: { type: 'jev', question: 'Other?', user: 0, assistant: 2 } }] },
        { ...item('c'), enabled: false, condition: { type: 'jev', question: 'Hidden one' } },
        end,
    ];
    const leaves = collectJevLeaves(tree);
    assert.deepEqual(leaves.map(leaf => [leaf.question, leaf.user, leaf.assistant]), [['The player is in danger.', 1, 1], ['Other?', 0, 2]]);
    assert.equal(computeJevQuestionKey(JEV), computeJevQuestionKey({ ...JEV, minChance: 10 }), 'the threshold does not change the question');
    assert.notEqual(computeJevQuestionKey(JEV), computeJevQuestionKey({ ...JEV, assistant: 3 }));
    assert.deepEqual(collectDividerConditions(tree).length, 1);
});

test('the chat slice names the newest reply, the newest player message and the older ones oldest first, and questions with the same slice share one call', () => {
    const chat = [
        { is_user: false, mes: 'Welcome.' }, { is_user: true, mes: 'I enter.' }, { is_user: false, mes: 'A door.' }, { is_system: true, mes: 'sys' },
        { is_user: true, mes: 'I open it.' }, { is_user: false, mes: 'It creaks.' }, { is_user: true, mes: 'I step in.' },
    ];
    assert.deepEqual(computeJevState(chat, { user: 1, assistant: 1 }), { latest_turn: 'It creaks.', player_message: 'I step in.' });
    assert.deepEqual(computeJevState(chat, { user: 2, assistant: 2 }), { latest_turn: 'It creaks.', player_message: 'I step in.', history: 'narrator: A door.\nplayer: I open it.' });
    assert.deepEqual(computeJevState(chat, { user: 0, assistant: 0 }), {});
    const calls = groupJevCalls(collectJevLeaves([{ ...item('a'), condition: JEV }, { ...item('b'), condition: { ...JEV, question: 'Second?' } }, { ...item('c'), condition: { ...JEV, question: 'Wide?', assistant: 2 } }]), chat);
    assert.equal(calls.length, 2);
    assert.equal(Object.keys(calls[0].questions).length, 2, 'two questions, one slice, one call');
    assert.equal(resolveJevLeaf({ question: ' x ' }).user, 1);
});

test('the Jev request carries the model, the slice and every statement as a Noul question, and only well-formed chances count as answers', () => {
    const built = buildJevRequest({ endpoint: 'https://example.org/decisions', apiKey: 'K', model: 'jev-1' }, { state: { player_message: 'hi' }, questions: { q1: 'It is calm.' } });
    assert.equal(built.url, 'https://example.org/decisions');
    assert.equal(built.headers.Authorization, 'Bearer K');
    assert.deepEqual(JSON.parse(built.body), { model: 'jev-1', state: { player_message: 'hi' }, questions: { q1: { type: 'noul', instructions: 'It is calm.' } } });
    assert.deepEqual(readJevAnswers({ answers: { q1: { noul: 0.4 }, q2: { noul: 7 }, q3: {} } }, ['q1', 'q2', 'q3', 'q4']), { q1: 0.4 });
    assert.equal(describeJevFailure(401, {}), 'The API key was rejected.');
    assert.equal(describeJevFailure(402, {}), 'The account has no credit left.');
    assert.equal(describeJevFailure(500, { error: { message: 'boom' } }), 'boom');
    assert.equal(describeJevFailure(502, null), 'The endpoint answered 502.');
});

test('a condition can name its classifier connection: the name is part of the question key, and questions for different connections never share a call', () => {
    const withConnection = { ...JEV, connection: 'second' };
    assert.notEqual(computeJevQuestionKey(JEV), computeJevQuestionKey(withConnection));
    assert.equal(resolveJevLeaf(JEV).connection, '');
    const leaves = collectJevLeaves([{ ...item('a'), condition: JEV }, { ...item('b'), condition: withConnection }]);
    const calls = groupJevCalls(leaves, [{ is_user: true, mes: 'hi' }]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.connectionId), [undefined, 'second']);
});
