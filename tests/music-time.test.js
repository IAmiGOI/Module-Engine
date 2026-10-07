import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createMusicServerCore } from '../cores/music-server/index.js';
import { EMBEDDING_MODEL_ID } from '../libraries/core/embedding.js';
import { timesUrl, parseTimes, parseClockHour, slotOfHour, slotOfPeriod } from '../libraries/shared/music-catalog.js';

const MODEL = EMBEDDING_MODEL_ID;
const server = { url: 'https://music.example/', key: 'k 1' };

test('timesUrl() follows the key handling of the other URLs', () => {
    assert.equal(timesUrl({ url: 'https://music.example/' }), 'https://music.example/api/times');
    assert.equal(timesUrl(server), 'https://music.example/api/times?k=k%201');
});

test('parseTimes() validates shape, ids, caps and the model', () => {
    const ok = JSON.stringify({ model: MODEL, slots: [
        { id: 1, name: 'dawn', keywords: ['dawn', '', 5, 'x'.repeat(81)] },
        { id: 8, keywords: ['a'] }, { id: -1, keywords: ['a'] }, { id: 1.5, keywords: ['a'] }, { id: '2', keywords: ['a'] },
        { id: 1, keywords: ['dup'] }, { id: 3, keywords: [] }, { id: 4 }, null,
        { id: 7, name: 'night', keywords: Array.from({ length: 100 }, (_, i) => `w${i}`) },
    ] });
    const list = parseTimes(ok, { model: MODEL });
    assert.deepEqual(list.map(slot => slot.id), [1, 7]);
    assert.deepEqual(list[0].keywords, ['dawn']);
    assert.equal(list[1].keywords.length, 80);
    assert.deepEqual(parseTimes(ok, { model: 'other' }), []);
    assert.deepEqual(parseTimes('nope', { model: MODEL }), []);
    assert.deepEqual(parseTimes(JSON.stringify({ model: MODEL, slots: 'x' }), { model: MODEL }), []);
    const many = JSON.stringify({ model: MODEL, slots: Array.from({ length: 20 }, (_, i) => ({ id: i % 8, keywords: ['a'] })) });
    assert.equal(parseTimes(many, { model: MODEL }).length, 8);
});

test('parseClockHour() reads 24h, am/pm and rejects bad values', () => {
    const cases = [['14:30', 14], ['07:05', 7], ['7.45', 7], ['19h00', 19], ['Day 3, 23:59', 23], ['00:00', 0], ['7:30 pm', 19], ['7:30 PM', 19], ['7 PM', 19], ['7 am', 7],
        ['12:15 am', 0], ['12 pm', 12], ['12:00 PM', 12], ['11:59 p.m.', 23],
        ['24:00', null], ['25:10', null], ['13:00 pm', null], ['0 pm', null], ['unknown', null], ['—', null], ['', null], [null, null], [undefined, null], [{}, null]];
    for (const [input, expected] of cases) assert.equal(parseClockHour(input), expected, String(input));
});

test('slotOfHour() and slotOfPeriod()', () => {
    assert.deepEqual([0, 2, 3, 5, 6, 12, 17, 18, 20, 21, 23].map(slotOfHour), [0, 0, 1, 1, 2, 4, 5, 6, 6, 7, 7]);
    assert.equal(slotOfHour(24), null); assert.equal(slotOfHour(null), null); assert.equal(slotOfHour(1.5), null);
    assert.deepEqual(['Morning', 'afternoon', ' EVENING ', 'Night'].map(slotOfPeriod), [2, 4, 6, 7]);
    for (const bad of ['Dawn', '', null, 3]) assert.equal(slotOfPeriod(bad), null);
});

test('the core fetches the times registry and forwards `time` in pick() only when it is an integer 0..7', async () => {
    const engine = createEngine();
    const calls = [];
    engine.buses.network.register('http.request', ({ url, body }) => {
        calls.push({ url, body: body ? JSON.parse(body) : null });
        return url.includes('/api/times')
            ? { ok: true, status: 200, text: JSON.stringify({ model: MODEL, slots: [{ id: 6, keywords: ['dusk'] }] }) }
            : { ok: true, status: 200, text: JSON.stringify({ action: 'keep' }) };
    });
    const core = createMusicServerCore(engine.registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server, dim: 4 });
    assert.deepEqual(await core.times(), { ok: true, slots: [{ id: 6, keywords: ['dusk'] }] });
    assert.ok(calls[0].url.includes('/api/times') && calls[0].url.includes('k=k%201'));
    for (const time of [0, 3, 7]) await core.pick({ section: 's', vector: [1], time });
    assert.deepEqual(calls.slice(1).map(call => call.body.time), [0, 3, 7]);
    const before = calls.length;
    for (const time of [8, -1, 2.5, '3', null, NaN, undefined]) await core.pick({ section: 's', vector: [1], time });
    for (const call of calls.slice(before)) assert.equal('time' in call.body, false);

    const down = createMusicServerCore(createEngine().registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server: {}, dim: 4 });
    assert.deepEqual(await down.times(), { ok: false, slots: [] });
});
