import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createClassifierCore, sanitizeConnections } from '../cores/classifier/index.js';

const KEYED = { id: 'jev', apiKey: 'sk-secret', timeoutMs: 1000 };

function build({ respond = () => ({ ok: true, status: 200, text: '{}' }), stored = { connections: [KEYED] } } = {}) {
    const engine = createEngine();
    const store = new Map([['core.classifier/settings', stored]]);
    const sent = [];
    const bus = engine.buses.cores;
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => store.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { store.set(`${namespace}/${key}`, value); return true; });
    engine.buses.network.register('http.request', async params => { sent.push({ ...params, body: params.body ? JSON.parse(params.body) : null }); return respond(sent.at(-1), sent.length); });
    const sleeps = [];
    const core = createClassifierCore(engine.registerCaller('core.classifier', 'cores', { tier: 'official', networkAccess: true }), { sleep: async ms => { sleeps.push(ms); } });
    const call = (contract, params) => request(engine.buses.cores, contract, { params });
    return { core, call, sent, store, sleeps };
}

const answerWith = answers => ({ ok: true, status: 200, text: JSON.stringify({ answers }) });
const ask = (call, extra = {}, state = { a: '1' }, questions = { q: 'x' }) => call('classifier.decide', { calls: [{ state, questions, ...extra }] });

test('connections are a list of named entries with limits and defaults; nameless and duplicate names are dropped; the old single connection becomes the first one called jev so its saved key survives', () => {
    const list = sanitizeConnections({ connections: [{ id: ' a ', timeoutMs: 999999, apiKey: ' k ' }, { id: '' }, { id: 'a' }, { id: 'b', endpoint: 'https://x.org/d' }] });
    assert.deepEqual(list.map(item => [item.id, item.timeoutMs, item.apiKey, item.model]), [['a', 20000, 'k', 'typesafe/jev-1.13'], ['b', 3000, '', 'typesafe/jev-1.13']]);
    const migrated = sanitizeConnections({ endpoint: 'https://old.example/d', apiKey: 'old-key', model: 'm' });
    assert.deepEqual(migrated.map(item => [item.id, item.endpoint, item.apiKey]), [['jev', 'https://old.example/d', 'old-key']]);
    assert.deepEqual(sanitizeConnections({}), []);
    assert.deepEqual(sanitizeConnections(null), []);
});

test('the list is saved and read back through the contracts, and saving it forgets remembered answers', async () => {
    const { core, call, store, sent } = build({ stored: {}, respond: () => answerWith({ q: { noul: 0.5 } }) });
    assert.deepEqual(await core.load(), []);
    await call('classifier.connections.set', { connections: [{ id: 'jev', apiKey: 'K' }, { id: 'other', apiKey: 'K2', endpoint: 'https://o.org/d' }] });
    assert.deepEqual((await call('classifier.connections.get')).value.map(item => item.id), ['jev', 'other']);
    assert.equal(store.get('core.classifier/settings').connections.length, 2);
    await ask(call); await ask(call);
    assert.equal(sent.length, 1, 'the second ask came from memory');
    await call('classifier.connections.set', { connections: [{ id: 'jev', apiKey: 'K' }] });
    await ask(call);
    assert.equal(sent.length, 2, 'a changed list starts with an empty memory');
});

test('one call per chat slice carries all its statements as Noul questions with the key, and the answers come back as chances by question id', async () => {
    const { core, call, sent } = build({ respond: () => answerWith({ q1: { noul: 0.9 }, q2: { noul: 0.1 } }) });
    await core.load();
    const decided = await ask(call, {}, { player_message: 'I draw my sword' }, { q1: 'The player is in danger.', q2: 'It is calm.' });
    assert.deepEqual(decided.value, { answers: { q1: 0.9, q2: 0.1 }, failed: [] });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers.Authorization, 'Bearer sk-secret');
    assert.deepEqual(sent[0].body.questions.q1, { type: 'noul', instructions: 'The player is in danger.' });
    assert.deepEqual(sent[0].body.state, { player_message: 'I draw my sword' });
});

test('a call names its connection or takes the first; each connection uses its own endpoint, model and key, and answers are remembered per connection', async () => {
    const { core, call, sent } = build({ stored: { connections: [{ id: 'first', apiKey: 'K1', endpoint: 'https://one.org/d', model: 'm1' }, { id: 'second', apiKey: 'K2', endpoint: 'https://two.org/d', model: 'm2' }] }, respond: () => answerWith({ q: { noul: 0.4 } }) });
    await core.load();
    await ask(call);
    await ask(call, { connectionId: 'second' });
    assert.deepEqual(sent.map(item => [item.url, item.headers.Authorization, item.body.model]), [['https://one.org/d', 'Bearer K1', 'm1'], ['https://two.org/d', 'Bearer K2', 'm2']]);
    await ask(call, { connectionId: 'second' });
    assert.equal(sent.length, 2, 'the same question on the same connection is remembered');
    const missing = (await ask(call, { connectionId: 'ghost' })).value;
    assert.deepEqual([missing.failed, missing.error], [['q'], 'There is no classifier connection called “ghost”.']);
});

test('the same slice and statement is answered from memory, so a reroll or swipe of the same message costs no second call; a new message does', async () => {
    const { core, call, sent } = build({ respond: () => answerWith({ q1: { noul: 0.5 } }) });
    await core.load();
    const again = text => ask(call, {}, { player_message: text }, { q1: 'x' });
    await again('same'); await again('same');
    assert.equal(sent.length, 1);
    await again('different');
    assert.equal(sent.length, 2);
    await call('classifier.clearCache');
    await again('same');
    assert.equal(sent.length, 3);
});

test('with no connection or no key, on an HTTP failure, on garbage and on a timeout the question is simply unanswered with a reason — never an exception, so the caller can decide', async () => {
    const empty = build({ stored: {} });
    await empty.core.load();
    assert.deepEqual((await ask(empty.call)).value, { answers: {}, failed: ['q'], error: 'No classifier connection is set.' });
    const noKey = build({ stored: { connections: [{ id: 'jev' }] } });
    await noKey.core.load();
    assert.equal((await ask(noKey.call)).value.error, 'The classifier connection “jev” has no API key.');
    assert.equal(noKey.sent.length, 0);
    const rejected = build({ respond: () => ({ ok: false, status: 401, text: '{"error":{"code":401}}' }) });
    await rejected.core.load();
    assert.equal((await ask(rejected.call)).value.error, 'The API key was rejected.');
    const garbage = build({ respond: () => ({ ok: true, status: 200, text: 'not json' }) });
    await garbage.core.load();
    assert.equal((await ask(garbage.call)).value.error, 'The endpoint returned no usable answers.');
    const hanging = build({ stored: { connections: [{ id: 'jev', apiKey: 'k', timeoutMs: 500 }] }, respond: () => new Promise(() => {}) });
    await hanging.core.load();
    const slow = await ask(hanging.call);
    assert.equal(slow.ok, true);
    assert.deepEqual(slow.value.failed, ['q']);
});

test('a rate-limited answer is retried once after a pause, and a partial answer keeps what came with the rest listed as failed', async () => {
    const limited = build({ respond: (_, count) => (count === 1 ? { ok: false, status: 429, text: '{}' } : answerWith({ q1: { noul: 0.3 } })) });
    await limited.core.load();
    assert.deepEqual((await ask(limited.call, {}, { a: '1' }, { q1: 'x' })).value.answers, { q1: 0.3 });
    assert.deepEqual(limited.sleeps, [1200]);
    const partial = build({ respond: () => answerWith({ q1: { noul: 0.6 } }) });
    await partial.core.load();
    const result = (await ask(partial.call, {}, { a: '1' }, { q1: 'x', q2: 'y' })).value;
    assert.deepEqual([result.answers, result.failed], [{ q1: 0.6 }, ['q2']]);
});

test('the connection test asks one small question of the named connection and reports the chance, or the reason it failed, without keeping its answer', async () => {
    const good = build({ respond: () => answerWith({ test: { noul: 0.97 } }) });
    await good.core.load();
    const passed = (await good.call('classifier.test', { connectionId: 'jev' })).value;
    assert.deepEqual([passed.ok, passed.chance], [true, 0.97]);
    const bad = build({ respond: () => ({ ok: false, status: 402, text: '{}' }) });
    await bad.core.load();
    assert.deepEqual([(await bad.call('classifier.test')).value.ok, (await bad.call('classifier.test')).value.error], [false, 'The account has no credit left.']);
});
