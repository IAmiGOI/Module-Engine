import test from 'node:test';
import assert from 'node:assert/strict';
import { humanSpan, acquaintanceStage, togetherShare, withUserLine, renderWithUser } from '../libraries/core/acquaintance.js';
import { createGreatBank } from '../cores/decision/bank-great.js';
import { createBankHandlers } from '../cores/decision/handlers-bank.js';

test('the engine speaks of time in human words, never in minutes, and the words do not flicker turn to turn', () => {
    assert.equal(humanSpan(290), 'a few hours');
    assert.equal(humanSpan(300), 'a few hours');
    assert.equal(humanSpan(3 * 24 * 60), 'a few days');
    assert.equal(acquaintanceStage(290), 'the first hours of knowing each other');
    assert.equal(togetherShare(280, 300), 'almost all of that time together');
    assert.equal(togetherShare(20, 3 * 24 * 60), 'hardly any of it together');
    const line = withUserLine('Satsuki', { met: 0, together: 280, milestones: [{ at: null, when: 'a week before, on graduation day', what: 'he saved her life' }] }, { now: 300, user: 'Damion' });
    assert.doesNotMatch(line, /\d+ min|minutes?\b(?! ago)/);
    assert.match(line, /has known Damion for a few hours, almost all of that time together — the first hours of knowing each other/);
    assert.match(line, /Milestones: he saved her life \(a week before, on graduation day\)/);
});

test('a past from before the story and a first meeting read differently', () => {
    assert.match(withUserLine('Yuto', { knownSince: 'since childhood', before: 'years as neighbours' }, { user: 'Damion' }), /has known Damion since childhood \(before the story: years as neighbours\)/);
    assert.match(withUserLine('Nurse', {}, { user: 'Damion' }), /is meeting Damion for the first time now\. No milestones between them yet\./);
    assert.equal(renderWithUser([], { user: 'Damion' }), '');
});

function bankWith(state) {
    const memory = new Map([['greatBank', state]]);
    let minutes = 0;
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
        if (contract === 'chatHistory.annotations') return {};
        return undefined;
    };
    const great = createGreatBank({ call, store: { clock: () => ({ minutes }) }, banks: { records: () => [] } });
    return { great, setClock: value => { minutes = value; } };
}

test('accepted turns count the time together; the user is not counted and the first shared scene dates the meeting', async () => {
    const { great } = bankWith({ satsuki: { name: 'Satsuki', importance: 'main' }, damion: { name: 'Damion', sourceKey: 'persona:me' } });
    await great.noteTogether({ names: ['Satsuki', 'Damion'], minutes: 30, endMinutes: 130 });
    await great.noteTogether({ names: ['Satsuki'], minutes: 20, endMinutes: 200 });
    const state = await great.load();
    assert.equal(state.satsuki.withUser.met, 100);
    assert.equal(state.satsuki.withUser.together, 50);
    assert.equal(state.damion.withUser, undefined);
});

test('the Director records a past and milestones; a milestone of the story is dated by the engine', async () => {
    const { great, setClock } = bankWith({ satsuki: { name: 'Satsuki', importance: 'main' } });
    const handlers = createBankHandlers({ banks: { great } });
    assert.equal((await handlers.set_acquaintance({ character: 'Satsuki', comment: 'x' })).ok, false, 'nothing to record is refused');
    await handlers.set_acquaintance({ character: 'Satsuki', milestone: { when: 'a week ago, on graduation day', what: 'he pushed her out of the way of a bus' }, comment: 'The opening binds them.' });
    setClock(480);
    await handlers.set_acquaintance({ character: 'Satsuki', milestone: { what: 'she told him what she decided while he slept' }, comment: 'A report shows it.' });
    const record = (await great.load()).satsuki.withUser;
    assert.deepEqual(record.milestones.map(item => item.at), [null, 480]);
    assert.equal(record.milestones[0].when, 'a week ago, on graduation day');
});
