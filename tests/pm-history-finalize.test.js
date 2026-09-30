import test from 'node:test';
import assert from 'node:assert/strict';
import { chatToMessages } from '../libraries/core/pm-history.js';
import { finalizeMessages, paramsToBody, squashSystem } from '../libraries/core/pm-finalize.js';

test('chat entries become user and assistant messages with stable history numbers', () => {
    const messages = chatToMessages([{ is_user: false, name: 'Lena', mes: 'hi' }, { is_user: true, name: 'Sasha', mes: 'hello' }, { is_user: false, mes: '  ' }]);
    assert.deepEqual(messages, [{ role: 'assistant', content: 'hi', _hid: 0 }, { role: 'user', content: 'hello', _hid: 1 }]);
});

test('module injections marked as system entries are sent as assistant messages', () => {
    assert.equal(chatToMessages([{ is_user: false, is_system: true, name: 'Memory', mes: 'facts' }])[0].role, 'assistant');
});

test('names are prefixed or attached as a field according to the names behavior', () => {
    const chat = [{ is_user: true, name: 'Sasha', mes: 'hello' }];
    assert.equal(chatToMessages(chat, { namesBehavior: 1 })[0].content, 'Sasha: hello');
    assert.equal(chatToMessages(chat, { namesBehavior: 2 })[0].name, 'Sasha');
    assert.equal(chatToMessages(chat, { namesBehavior: 0 })[0].name, undefined);
});

test('tool invocations of a message are expanded into a call and its results kept together, and the on-screen summary text of that message is not sent — as SillyTavern 1.18 does', () => {
    const chat = [{ is_user: false, is_system: true, mes: '<div>Notebook called</div>', extra: { tool_invocations: [{ id: 'c1', name: 'Notebook', parameters: { a: 1 }, result: 'Saved' }, { id: 'c2', name: 'Secrets', parameters: '{}', result: '' }] } }];
    const messages = chatToMessages(chat);
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'tool', 'tool']);
    assert.deepEqual(messages[0].tool_calls.map(call => [call.id, call.function.name, call.function.arguments]), [['c1', 'Notebook', '{"a":1}'], ['c2', 'Secrets', '{}']]);
    assert.deepEqual(messages.slice(1).map(m => [m.tool_call_id, m.content]), [['c1', 'Saved'], ['c2', '[No content]']]);
    assert.ok(!messages.some(m => String(m.content).includes('Notebook called')));
});

test('macros in history text are substituted with the given function', () => {
    assert.equal(chatToMessages([{ is_user: true, mes: 'I am {{user}}' }], { substitute: t => t.replace('{{user}}', 'Sasha') })[0].content, 'I am Sasha');
});

test('only the parameters set in the preset go into the request body under the endpoint names', () => {
    assert.deepEqual(paramsToBody({ temperature: 0.85, openai_max_tokens: 4000, stream_openai: true, seed: -1, top_k: undefined }), { temperature: 0.85, max_tokens: 4000, seed: -1 });
    assert.equal('stream' in paramsToBody({ stream_openai: false }), false, 'streaming is never rewritten in the body: ST parses the answer by its own setting');
});

test('reasoning_effort: ST\'s own labels ("auto", "min") are translated, not sent literally — a real OpenRouter route rejected "auto" with a 400', () => {
    // "auto" resolves to the KEY existing with value `undefined`, not the key being absent: ST's own base payload
    // already carries its OWN reasoning_effort (its connection-profile default, "auto") before we ever run, and
    // `{...payload, ...body}` only overrides a key that is actually present — an absent key changes nothing.
    const autoBody = paramsToBody({ reasoning_effort: 'auto' });
    assert.equal('reasoning_effort' in autoBody, true, 'the key must be present so it OVERRIDES whatever ST already put in the payload');
    assert.equal(autoBody.reasoning_effort, undefined, 'and its value must be undefined so JSON.stringify drops it from the actual request');
    assert.equal(paramsToBody({ reasoning_effort: 'min' }).reasoning_effort, 'minimal');
    assert.equal(paramsToBody({ reasoning_effort: 'high' }).reasoning_effort, 'high', 'values already valid for the API pass through unchanged');
    assert.equal('reasoning_effort' in paramsToBody({}), false, 'preset never configured it at all — leave ST\'s own payload value alone');
});

test('consecutive system messages are squashed only when the preset asks for it', () => {
    const list = [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'c' }, { role: 'system', content: 'd' }];
    assert.deepEqual(squashSystem(list).map(m => m.content), ['a\nb', 'c', 'd']);
    assert.equal(finalizeMessages(list, { params: {} }).length, 4);
    assert.equal(finalizeMessages(list, { params: { squash_system_messages: true } }).length, 3);
});

test('an assistant prefill is appended and service fields are stripped', () => {
    const out = finalizeMessages([{ role: 'user', content: 'x', _hid: 0, _block: 'b' }], { params: { assistant_prefill: '{{char}}:' }, substitute: t => t.replace('{{char}}', 'Lena') });
    assert.deepEqual(out, [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'Lena:' }]);
});
