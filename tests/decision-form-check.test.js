import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormChecker } from '../cores/decision/form-check.js';

const form = () => ({
    resolution: 'She speaks.', userResult: 'The user waits.', scene: { minutes: 1 },
    characters: [
        { name: 'Lena', decision: 'Leave.', decisionReason: 'She is late.', action: 'Mentions the hidden vault.', feeling: 'calm', need: 'to be safe', actionReason: 'She wants the key.', outcome: 'She says it.', speech: 'The vault is under the mill.' },
        { name: 'Marek', decision: 'Stay.', decisionReason: 'He is tired.', action: 'Sits down.', feeling: 'calm', need: 'to be safe', actionReason: 'The chair is close.', outcome: 'He sits.' },
    ],
});

function build({ answers = {}, error = null, knowledge = 'WHAT CHARACTERS KNOW: Lena knows nothing about the vault.' } = {}) {
    const calls = [];
    const knowledgeText = () => knowledge;
    const checker = createFormChecker({
        getSettings: () => ({ classifier: { connectionId: 'test', threshold: 0.85 } }),
        banks: {
            persona: () => ({ name: 'Sasha' }),
            recordsFor: names => names.map(name => ({ name, text: `BANK ${name}` })),
        },
        knowledge: { textFor: async () => knowledgeText() },
        call: async (contract, params) => {
            calls.push({ contract, params });
            if (error) throw new Error(error);
            return { answers, failed: [], ...(Object.keys(answers).length ? {} : { error: 'no answer' }) };
        },
    });
    return { checker, calls, setKnowledge: value => { knowledge = value; } };
}

test('one classifier call carries every form character and the scene', async () => {
    const { checker, calls } = build({ answers: { 'knowledge_conflict:Lena': 0.1, 'knowledge_conflict:Marek': 0.1 } });
    const result = await checker.check({ form: form(), sceneText: 'Lena: The vault is under the mill.' });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(Object.keys(call.params.calls[0].questions).sort(), ['knowledge_conflict:Lena', 'knowledge_conflict:Marek']);
    assert.match(call.params.calls[0].state.scene, /The vault/);
    assert.equal(call.params.calls[0].state.characters.length, 2);
    assert.match(call.params.calls[0].state.characters[0].bank, /BANK Lena/);
    assert.match(call.params.calls[0].state.characters[0].knowledge, /knows nothing/);
});

test('a conflict returns the section 14 refusal with the name and quote', async () => {
    const { checker } = build({ answers: { 'knowledge_conflict:Lena': 0.95, 'knowledge_conflict:Marek': 0.1 } });
    const result = await checker.check({ form: form(), sceneText: 'scene' });
    assert.equal(result.ok, false);
    assert.equal(result.name, 'Lena');
    assert.equal(result.chance, 0.95);
    assert.equal(result.quote, 'Mentions the hidden vault.');
    assert.match(result.refusal, /The form was not accepted: Lena acts on something Lena cannot know \("Mentions the hidden vault\."\)/);
    assert.match(result.refusal, /call submit_turn again/);
});

test('the same conflict once returned is accepted with a warning on the next attempt', async () => {
    const { checker } = build({ answers: { 'knowledge_conflict:Lena': 0.95 } });
    const first = await checker.check({ form: form(), sceneText: 'scene' });
    assert.equal(first.ok, false);
    const second = await checker.check({ form: form(), sceneText: 'scene', returned: new Set(['Lena']) });
    assert.equal(second.ok, true);
    assert.match(second.warnings.join('\n'), /accepted with a knowledge conflict for Lena/);
});

test('a knowledge record added between attempts is part of the second check', async () => {
    const { checker, calls, setKnowledge } = build({ answers: { 'knowledge_conflict:Lena': 0.1 } });
    await checker.check({ form: form(), sceneText: 'scene' });
    setKnowledge('WHAT CHARACTERS KNOW: Lena learned about the vault from Marek.');
    await checker.check({ form: form(), sceneText: 'scene' });
    assert.match(calls[1].params.calls[0].state.characters[0].knowledge, /learned about the vault/);
});

test('without a classifier the form is accepted without a check, with a warning', async () => {
    const { checker } = build({ error: 'classifier is down' });
    const result = await checker.check({ form: form(), sceneText: 'scene' });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.match(result.warnings.join('\n'), /was not checked by the classifier: classifier is down/);
});

test('the user character is not checked', async () => {
    const { checker, calls } = build({ answers: { 'knowledge_conflict:Sasha': 0.99, 'knowledge_conflict:Lena': 0.1, 'knowledge_conflict:Marek': 0.1 } });
    const withUser = form();
    withUser.characters.push({ name: 'Sasha', decision: 'Wait.', decisionReason: 'The user decides.', action: 'Waits.', feeling: 'calm', need: 'to be safe', actionReason: 'The user waits.', outcome: 'Waits.' });
    await checker.check({ form: withUser, sceneText: 'scene' });
    assert.equal(Object.keys(calls[0].params.calls[0].questions).includes('knowledge_conflict:Sasha'), false);
    assert.equal(calls[0].params.calls[0].state.characters.some(character => character.name === 'Sasha'), false);
});
