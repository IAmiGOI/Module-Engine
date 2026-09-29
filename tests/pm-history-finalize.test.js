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

test('tool invocations of a message are expanded into a call and its results kept together', () => {
    const chat = [{ is_user: false, mes: 'ok', extra: { tool_invocations: [{ id: 'c1', name: 'Notebook', parameters: { a: 1 }, result: 'Saved' }] } }];
    const messages = chatToMessages(chat);
    assert.deepEqual(messages.map(m => m.role), ['assistant', 'assistant', 'tool']);
    assert.equal(messages[1].tool_calls[0].function.name, 'Notebook');
    assert.equal(messages[2].tool_call_id, 'c1');
});

test('macros in history text are substituted with the given function', () => {
    assert.equal(chatToMessages([{ is_user: true, mes: 'I am {{user}}' }], { substitute: t => t.replace('{{user}}', 'Sasha') })[0].content, 'I am Sasha');
});

test('only the parameters set in the preset go into the request body under the endpoint names', () => {
    assert.deepEqual(paramsToBody({ temperature: 0.85, openai_max_tokens: 4000, stream_openai: true, seed: -1, top_k: undefined }), { temperature: 0.85, max_tokens: 4000, stream: true, seed: -1 });
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
