import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCycleEntry, applyFeedEvent, createFeedState } from '../libraries/core/decision-feed.js';
import { counsellorRows, queueRow } from '../libraries/core/decision-feed-rows.js';
import { createCycleRecord } from '../libraries/core/decision-log.js';

const toolCall = (name, args, result = { ok: true }) => ({ name, args, comment: `${name} because it matters.`, result, error: null, durationMs: 5, at: 1 });

test('the Counsellor cycle shows its review: petition, nothing_yet, reply, prayer and the queues', () => {
    const cycle = createCycleRecord({
        runId: 'c1', event: 'counsellor', turn: 6, clockMinutes: 300,
        wake: {
            type: 'counsellor', label: 'The Counsellor read the Ledger',
            queues: {
                petitions: [{ character: 'Lena', status: 'queued', day: true }],
                prayers: [{ text: 'The gate bent.', status: 'queued' }],
            },
        },
        toolCalls: [
            toolCall('petition', { character: 'Lena', problem: 'The Decree cannot get her out.', excerpt: '- T6 Lena', promote: { level: 'main', reason: 'She matters now.' } }, { ok: true, status: 'queued' }),
            toolCall('reply', { text: 'I will pass it on.' }, { ok: true }),
            toolCall('prayer', { text: 'The gate bent.' }, { ok: true, status: 'queued' }),
        ],
    });
    const entry = buildCycleEntry(cycle);
    assert.equal(entry.title, 'The Counsellor read the Ledger');
    const kinds = entry.rows.map(row => row.kind);
    assert.ok(kinds.includes('petition'));
    assert.ok(kinds.includes('counsellor_reply'));
    assert.ok(kinds.includes('prayer'));
    assert.ok(kinds.includes('queues'));
    const petition = entry.rows.find(row => row.kind === 'petition');
    assert.equal(petition.character, 'Lena');
    assert.equal(petition.status, 'queued');
    assert.deepEqual(petition.promote, { level: 'main', reason: 'She matters now.' });
    assert.match(petition.problem, /cannot get her out/);
    const queues = entry.rows.find(row => row.kind === 'queues');
    assert.deepEqual(queues.petitions, [{ character: 'Lena', status: 'queued', day: true }]);
    assert.deepEqual(queues.prayers, [{ text: 'The gate bent.', status: 'queued' }]);
    const reply = entry.rows.find(row => row.kind === 'counsellor_reply');
    assert.equal(reply.text, 'I will pass it on.');
});

test('nothing_yet is a row with its reason', () => {
    const cycle = createCycleRecord({
        runId: 'c2', event: 'counsellor',
        toolCalls: [toolCall('nothing_yet', { reason: 'The Decree covers all of it.' }, { ok: true, status: 'nothing' })],
        wake: { type: 'counsellor', label: 'The Counsellor read the Ledger' },
    });
    const row = buildCycleEntry(cycle).rows.find(item => item.kind === 'nothing');
    assert.equal(row.reason, 'The Decree covers all of it.');
});

test('a failed Counsellor call does not pretend it was recorded', () => {
    const rows = counsellorRows({ name: 'petition', args: { character: 'Lena', problem: 'x' }, result: { ok: false, error: 'no comment' } }, 1);
    assert.deepEqual(rows, []);
    const nothing = counsellorRows({ name: 'nothing_yet', args: { reason: 'Fine.' }, result: { ok: true } }, 2);
    assert.equal(nothing[0].kind, 'nothing');
    assert.equal(queueRow(null), null);
});

test('the day-end queue is visible as prepare the new day', () => {
    const row = queueRow({ petitions: [{ character: 'Ram', status: 'queued', day: true }], prayers: [] });
    assert.equal(row.petitions[0].day, true);
    assert.deepEqual(row.prayers, []);
});

test('the live feed starts the Counsellor cycle from its wake event, and the finished cycle replaces it', () => {
    let state = applyFeedEvent(createFeedState(), 'decision.cycle.started', { runId: 'c3', event: 'counsellor_day', wake: { label: 'The Counsellor closes the RP day' }, at: 10 });
    assert.equal(state.live.c3.title, 'The Counsellor closes the RP day');
    state = applyFeedEvent(state, 'decision.tool.called', { runId: 'c3', name: 'petition', args: { character: 'Lena' }, comment: 'Her day is over.' });
    assert.equal(state.live.c3.rows[0].name, 'petition');
    const cycle = createCycleRecord({ runId: 'c3', event: 'counsellor_day', wake: { type: 'counsellor_day', label: 'The Counsellor closes the RP day' }, toolCalls: [toolCall('petition', { character: 'Lena', problem: 'x' })] });
    state = applyFeedEvent(state, 'decision.cycle.finished', { runId: 'c3', cycle });
    assert.equal(state.live.c3, undefined);
    assert.equal(state.cycles.at(-1).event, 'counsellor_day');
});
