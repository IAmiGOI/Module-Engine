import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCycleEntry, createFeedState, applyFeedEvent, filterFeed } from '../libraries/core/decision-feed.js';
import { createCycleRecord } from '../libraries/core/decision-log.js';

function turnCycle(overrides = {}) {
    return createCycleRecord({
        id: 'cyc_1', runId: 'run_1', event: 'turn', at: 1000, endedAt: 1600, durationMs: 600,
        thinking: 'the guard is tired', turn: 3, clockMinutes: 120,
        wake: { type: 'turn', label: 'A new turn has started' },
        toolCalls: [
            { name: 'assess', comment: 'I need the chance first.', args: { character: 'Lena', action: 'opens the door', difficulty: 'easy', experience: 'skilled' }, result: { ok: true, character: 'Lena', action: 'opens the door', probability: 0.8, roll: 0.3, degree: 'flawless', words: 'flawlessly' } },
            { name: 'character_note', comment: 'The writer must know this.', args: { character: 'Lena', title: 'Door' }, result: { ok: true } },
            { name: 'await', comment: 'The cycle is over.', args: { reason: 'done' }, result: { ok: true } },
        ],
        form: { resolution: 'She leaves.', userResult: 'The user waits.', scene: { minutes: 2 }, characters: [{ name: 'Lena', decision: 'Leave', action: 'opens the door', outcome: 'It opens' }], meta: { place: 'Hall', timeBefore: 'noon', timeAfter: 'noon' } },
        push: 'PUSH TEXT', warnings: ['close to the limit'],
        usage: { prompt: 100, completion: 20, cached: 40, total: 120 }, ...overrides,
    });
}

test('a stored cycle becomes header, thinking, call, assess, form, push, warning and usage rows', () => {
    const entry = buildCycleEntry(turnCycle());
    assert.equal(entry.title, 'A new turn has started');
    assert.equal(entry.turn, 3);
    assert.deepEqual(entry.rows.map(row => row.kind), ['thinking', 'assess', 'call', 'call', 'form', 'push', 'warning', 'usage']);
    assert.equal(entry.rows.find(row => row.kind === 'assess').comment, 'I need the chance first.');
    assert.equal(entry.rows.find(row => row.kind === 'assess').probability, 0.8);
    assert.equal(entry.rows.find(row => row.kind === 'form').characters[0].name, 'Lena');
    assert.equal(entry.rows.find(row => row.kind === 'push').text, 'PUSH TEXT');
});

test('a rejected cycle stays in the feed and is marked, not dropped', () => {
    const entry = buildCycleEntry(turnCycle({ rejected: true }));
    assert.equal(entry.rejected, true);
    assert.equal(entry.id, 'cyc_1');
});

test('a message record is a message row; the wake cycle says what woke the director', () => {
    const message = buildCycleEntry(createCycleRecord({ event: 'message', message: { text: 'Make it rain.', at: 5 } }));
    assert.equal(message.rows[0].kind, 'message');
    assert.equal(message.rows[0].text, 'Make it rain.');
    const wake = buildCycleEntry(createCycleRecord({ event: 'message', wake: { type: 'message', label: 'A message from the user', detail: 'Make it rain.' } }));
    assert.equal(wake.title, 'A message from the user');
    assert.equal(wake.detail, 'Make it rain.');
});

test('live events append and update rows without rebuilding the cycles already on screen', () => {
    const stored = buildCycleEntry(turnCycle());
    const state = { cycles: [stored], archive: [], live: {} };
    let next = applyFeedEvent(state, 'decision.cycle.started', { runId: 'run_2', event: 'turn', wake: { label: 'A new turn has started' }, at: 2000 });
    assert.equal(next.cycles[0], stored, 'the old section is the same object');
    assert.equal(next.live.run_2.waiting, false);
    next = applyFeedEvent(next, 'decision.cycle.step', { runId: 'run_2', phase: 'waiting', at: 2001 });
    assert.equal(next.live.run_2.waiting, true);
    next = applyFeedEvent(next, 'decision.cycle.answer', { runId: 'run_2', text: 'Waiting for the turn.' });
    assert.equal(next.live.run_2.rows[0].kind, 'answer');
    next = applyFeedEvent(next, 'decision.tool.called', { runId: 'run_2', id: 'a1', name: 'assess', comment: 'Need the odds.', args: { character: 'Lena' } });
    assert.equal(next.live.run_2.rows[1].pending, true);
    next = applyFeedEvent(next, 'decision.tool.result', { runId: 'run_2', name: 'assess', result: { ok: true, probability: 0.4, degree: 'clumsy', words: 'clumsily' } });
    assert.equal(next.live.run_2.rows[1].kind, 'assess');
    assert.equal(next.live.run_2.rows[1].probability, 0.4);
    next = applyFeedEvent(next, 'decision.cycle.finished', { runId: 'run_2', cycle: turnCycle({ id: 'cyc_2', runId: 'run_2', at: 2000 }) });
    assert.equal(Object.keys(next.live).length, 0);
    assert.equal(next.cycles.length, 2);
    assert.equal(next.cycles[1].id, 'cyc_2');
});

test('the form and the push arrive live, before the cycle is written', () => {
    let state = applyFeedEvent(createFeedState(), 'decision.cycle.started', { runId: 'r', event: 'turn', at: 1 });
    state = applyFeedEvent(state, 'decision.cycle.form', { runId: 'r', form: turnCycle().form, push: 'LIVE PUSH' });
    const kinds = state.live.r.rows.map(row => row.kind);
    assert.deepEqual(kinds, ['form', 'push']);
    assert.equal(state.live.r.rows[1].text, 'LIVE PUSH');
});

test('filters hide thinking, keep only turns or passive cycles, and search the whole section', () => {
    const state = createFeedState({ cycles: [turnCycle(), createCycleRecord({ id: 'cyc_2', event: 'time', wake: { label: 'The clock moved', detail: 'plans are due' } })] });
    const noThinking = filterFeed(state, { showThinking: false });
    assert.equal(noThinking.cycles[0].rows.some(row => row.kind === 'thinking'), false);
    assert.deepEqual(filterFeed(state, { onlyTurns: true }).cycles.map(entry => entry.id), ['cyc_1']);
    assert.deepEqual(filterFeed(state, { onlyPassive: true }).cycles.map(entry => entry.id), ['cyc_2']);
    assert.deepEqual(filterFeed(state, { search: 'PUSH TEXT' }).cycles.map(entry => entry.id), ['cyc_1']);
    assert.equal(filterFeed(state, { search: 'nothing like this' }).cycles.length, 0);
});

test('the archive is built the same way and can be filtered separately', () => {
    const state = createFeedState({ cycles: [turnCycle()], archive: [createCycleRecord({ id: 'old', event: 'time', thinking: 'old thought' })] });
    assert.equal(state.archive[0].id, 'old');
    const filtered = filterFeed(state, { search: 'old thought' });
    assert.equal(filtered.archive.length, 1);
    assert.equal(filtered.cycles.length, 0);
});
