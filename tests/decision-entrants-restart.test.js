import test from 'node:test';
import assert from 'node:assert/strict';
import { createInscribeHandler } from '../cores/decision/handlers-inscribe.js';
import { runDecisionCycle } from '../libraries/core/decision-agent.js';

test('a character entering with a written bank sends the turn back to start with them in the scene, once', async () => {
    let roster = { active: ['Emilia'] };
    const events = [];
    const state = {};
    const bank = { 'otto suwen': { name: 'Otto Suwen', sourceKey: 'lorebook:x:29', spiritual: { 3: ['Fear and panic are loud.'] }, decree: {} } };
    const handler = createInscribeHandler({
        store: { roster: () => roster, saveRoster: async next => { roster = next; } },
        publishEvent: (name, data) => events.push([name, data]), state,
        resolvePlace: async () => '', lastTimeMark: async () => '', greatBank: async () => bank,
    });
    const result = await handler({ roster: { add: [{ name: 'Otto Suwen' }] }, characters: [{ name: 'Otto Suwen' }], beats: [] });
    assert.equal(result.restart, true);
    assert.deepEqual(roster.active, ['Emilia', 'Otto Suwen']);
    assert.equal(events[0][0], 'decision.turn.entrants');
    const agent = await runDecisionCycle({
        messages: [{ role: 'user', content: 'go' }], tools: [],
        generate: async () => ({ text: '', toolCalls: [{ id: '1', name: 'inscribe', arguments: { comment: 'Otto steps in.' } }] }),
        handlers: { inscribe: async () => ({ ok: true, restart: true }) }, maxSteps: 3,
    });
    assert.equal(agent.type, 'restart');
});

test('a stranger without a bank, or the turn already restarted once, goes on as usual', async () => {
    const state = { entrantsRestarted: true };
    let saved = false;
    const handler = createInscribeHandler({
        store: { roster: () => ({ active: [] }), saveRoster: async () => { saved = true; }, clock: () => ({ minutes: 0 }), cycles: () => [] },
        publishEvent: () => {}, state, resolvePlace: async () => '', lastTimeMark: async () => '',
        greatBank: async () => ({ 'otto suwen': { name: 'Otto Suwen', spiritual: { 3: ['x'] } } }),
    });
    const result = await handler({ roster: { add: [{ name: 'Otto Suwen' }] }, characters: [] }).catch(error => ({ error }));
    assert.notEqual(result?.restart, true);
    assert.equal(saved, false);
});

test('a power of the world used by a character the Resolver plays is rolled before the turn is accepted', async () => {
    const state = { assessments: new Map([['a1', { character: 'Roswaal' }]]) };
    const handler = createInscribeHandler({
        store: { roster: () => ({ active: ['Roswaal'] }), saveRoster: async () => {}, clock: () => ({ minutes: 0 }), cycles: () => [] },
        publishEvent: () => {}, state, resolvePlace: async () => '', lastTimeMark: async () => '',
    });
    const refused = await handler({ characters: [{ name: 'Roswaal', does: 'rises after them', power: 'Gate Magic / Yin Interference' }], beats: [{ who: 'Roswaal', kind: 'action', text: 'x' }], stop: 'x' });
    assert.equal(refused.ok, false);
    assert.match(refused.missing[0], /roll it with assess/);
});
