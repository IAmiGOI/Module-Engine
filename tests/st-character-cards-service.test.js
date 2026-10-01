import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStCharacterCardsService } from '../services/st-character-cards.js';

class FakeFormData {
    constructor() { this.pairs = []; }
    append(key, value) { this.pairs.push([key, value]); }
}

function buildService({ responses = {}, characters = [] } = {}) {
    const bus = createContractBus();
    const calls = [];
    let refreshed = 0;
    const getContext = () => ({ characters, getRequestHeaders: options => (options?.omitContentType ? { 'X-CSRF': 't' } : { 'Content-Type': 'application/json', 'X-CSRF': 't' }), getCharacters: async () => { refreshed += 1; } });
    const fetch = async (url, options) => {
        calls.push({ url, options });
        const reply = responses[url] ?? { ok: true, body: {} };
        return { ok: reply.ok !== false, status: reply.status ?? 200, json: async () => reply.body, text: async () => reply.text ?? '' };
    };
    registerStCharacterCardsService(bus, { getContext, fetch, FormDataCtor: FakeFormData });
    return { call: (contract, params) => request(bus, contract, { params }), calls, refreshed: () => refreshed };
}

test('the list comes from the characters ST already holds in memory, without a request', async () => {
    const { call, calls } = buildService({ characters: [{ avatar: 'Aria.png', name: 'Aria', tags: ['x'] }, { name: 'no avatar' }] });
    assert.deepEqual((await call('stCharacterCard.list')).value, [{ avatar: 'Aria.png', name: 'Aria', tags: ['x'] }]);
    assert.equal(calls.length, 0);
});

test('a card is read in full from disk by its avatar file', async () => {
    const { call, calls } = buildService({ responses: { '/api/characters/get': { body: { name: 'Aria', data: {} } } } });
    assert.equal((await call('stCharacterCard.load', { avatar: 'Aria.png' })).value.name, 'Aria');
    assert.deepEqual(JSON.parse(calls[0].options.body), { avatar_url: 'Aria.png' });
    assert.equal((await call('stCharacterCard.load', {})).ok, false);
});

test('creating sends a multipart form where a list is a repeated key, returns the avatar file ST chose, and makes ST reread its list', async () => {
    const { call, calls, refreshed } = buildService({ responses: { '/api/characters/create': { text: 'Cleo.png\n' } } });
    const created = await call('stCharacterCard.create', { form: { ch_name: 'Cleo', alternate_greetings: ['a', 'b'], talkativeness: '0.3' } });
    assert.deepEqual(created.value, { avatar: 'Cleo.png' });
    assert.deepEqual(calls[0].options.body.pairs, [['ch_name', 'Cleo'], ['alternate_greetings', 'a'], ['alternate_greetings', 'b'], ['talkativeness', '0.3']]);
    assert.equal(calls[0].options.headers['Content-Type'], undefined, 'the browser sets the multipart boundary itself');
    assert.equal(refreshed(), 1);
    assert.equal((await call('stCharacterCard.create', { form: {} })).ok, false);
});

test('merging sends the body with the avatar file and rereads the list; a refusal from ST carries its own reason', async () => {
    const { call, calls, refreshed } = buildService({ responses: { '/api/characters/merge-attributes': { ok: true } } });
    assert.equal((await call('stCharacterCard.merge', { avatar: 'Aria.png', body: { description: 'x', data: { description: 'x' } } })).ok, true);
    assert.deepEqual(JSON.parse(calls[0].options.body), { description: 'x', data: { description: 'x' }, avatar: 'Aria.png' });
    assert.equal(refreshed(), 1);
    const refusing = buildService({ responses: { '/api/characters/merge-attributes': { ok: false, status: 400, body: { message: 'Validation failed', error: 'data.tags' } } } });
    const refused = await refusing.call('stCharacterCard.merge', { avatar: 'Aria.png', body: {} });
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /SillyTavern refused the card: data\.tags/);
    assert.equal(refusing.refreshed(), 0, 'nothing was written, so nothing is reread');
});
