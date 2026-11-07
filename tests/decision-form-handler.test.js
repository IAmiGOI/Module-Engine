import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../cores/decision/handlers.js';
import { createFormChecker } from '../cores/decision/form-check.js';

function form() {
    return {
        comment: 'The form is ready.', resolution: 'She speaks.', userResult: 'The user waits.', scene: { minutes: 1 },
        beats: [{ who: 'Someone', kind: 'action', text: 'acts' }], characters: [{
            name: 'Lena', decision: 'Leave.', decisionReason: 'She is late.', action: 'Mentions the vault.', feeling: 'calm', need: 'to be safe', actionReason: 'She wants the key.',
            noCheck: 'She is only speaking about what she knows.', outcome: 'She says it.',
        }],
    };
}

function build({ answers = {}, classifier = true, error = null } = {}) {
    const events = [];
    const state = { assessments: new Map(), assessmentCounter: 0, turnCounter: 0, runId: 'run_1', sceneText: 'Lena: the mill.', knowledgeReturns: new Set(), formWarnings: [] };
    const store = {
        plan: () => ({ direction: 'Go.' }), roster: () => ({ active: ['Lena'] }), clock: () => ({ minutes: 0, updatedAt: 1 }),
        saveClock: async () => {}, notes: () => ({}), library: () => ({}), plans: () => [], bank: () => ({}),
    };
    const call = async (contract) => {
        if (contract === 'classifier.decide') {
            if (!classifier) throw new Error('no classifier');
            if (error) throw new Error(error);
            return { answers, failed: [] };
        }
        return null;
    };
    const formChecker = createFormChecker({
        call, getSettings: () => ({ classifier: { connectionId: 'test', threshold: 0.85 } }),
        banks: { persona: () => ({ name: 'Sasha' }), recordsFor: () => [{ text: 'Lena runs the ferry.' }] },
        knowledge: { textFor: async () => 'WHAT CHARACTERS KNOW: nothing yet.' },
    });
    const handlers = createHandlers({
        store, call, publishEvent: (event, data) => events.push([event, data]), getSettings: () => ({}),
        state, resolvePlace: async () => '', lastTimeMark: async () => '', banks: null, formChecker,
    });
    return { handlers, state, events };
}

test('a knowledge conflict returns the section 14 text and remembers the character', async () => {
    const { handlers, state, events } = build({ answers: { 'knowledge_conflict:Lena': 0.95 } });
    const result = await handlers.inscribe(form());
    assert.equal(result.ok, false);
    assert.match(result.error, /The form was not accepted: Lena acts on something Lena cannot know/);
    assert.equal(state.knowledgeReturns.has('Lena'), true);
    assert.ok(events.some(([event, data]) => event === 'decision.form.check' && data.refused === true));
});

test('the second conflict for the same character is accepted with a warning', async () => {
    const { handlers, state } = build({ answers: { 'knowledge_conflict:Lena': 0.95 } });
    await handlers.inscribe(form());
    const second = await handlers.inscribe(form());
    assert.equal(second.ok, true);
    assert.match(state.formWarnings.join('\n'), /accepted with a knowledge conflict for Lena/);
});

test('without a classifier the form is accepted', async () => {
    const { handlers, state } = build({ classifier: false });
    const result = await handlers.inscribe(form());
    assert.equal(result.ok, true);
    assert.match(state.formWarnings.join('\n'), /was not checked by the classifier/);
});
