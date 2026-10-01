import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNegationProblems, computeCardNegationProblems, buildNegationRefusal } from '../libraries/core/character-lint.js';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createCharacterCardsCore } from '../cores/character-cards/index.js';

const problems = text => computeNegationProblems(text).map(item => item.problem);

test('a negation next to the positive wording it belongs to is fine, in the same line or in a parenthesis; characters speaking in quotes are not judged', () => {
    assert.deepEqual(problems('Mira answers in one sentence. (She does not fill silences.)'), []);
    assert.deepEqual(problems('This leads to her standing her ground; it does not lead to flexibility.'), []);
    assert.deepEqual(problems('She has no whiskers. Her face is smooth.'), []);
    assert.deepEqual(problems('She says "I will never forgive you. Do not follow me." and walks on.'), []);
    assert.deepEqual(problems('**Speech**\nShe speaks gently and formally.'), []);
});

test('two negations in a row are punished, also the short fragment form', () => {
    assert.deepEqual(problems('She does not step back. She does not step forward. She waits.'), ['two negations in a row']);
    assert.deepEqual(problems('Emilia: "I am." No stutter. No hesitation. She meets his eyes.'), ['two negations in a row']);
});

test('a prohibition written as an order is punished wherever it stands', () => {
    assert.deepEqual(problems('Mira is calm. Never write her shouting.'), ['a prohibition written as an order']);
    assert.ok(problems("Don't describe her tears.").includes('a prohibition written as an order'));
    assert.ok(problems('Avoid long speeches.').includes('a prohibition written as an order'));
});

test('a line with a lone negation and nothing positive beside it is punished; the same sentence beside a positive one is not', () => {
    assert.deepEqual(problems('She does not trust strangers.'), ['a negation with no positive wording next to it']);
    assert.deepEqual(problems('She keeps her distance from strangers. She does not trust them.'), []);
});

test('only the fields that go to the model are checked: the description, personality, scenario, examples, post-history, system prompt and depth prompt; the greeting and the notes are not', () => {
    const found = computeCardNegationProblems({ description: 'She never lies.', first_mes: 'He did not answer. She did not wait.', creator_notes: 'Do not use with X.', depth_prompt: { prompt: 'Never rush.', depth: 4, role: 'system' } });
    assert.deepEqual(found.map(item => item.field), ['description', 'depth_prompt']);
    assert.match(buildNegationRefusal(found), /Not written: standing negations[^]*- description: “She never lies” — a negation[^]*"negations_ok": true/);
});

function build() {
    const engine = createEngine();
    const written = [];
    engine.buses.services.register('stCharacterCard.list', () => []);
    engine.buses.services.register('stCharacterCard.create', ({ form }) => ({ avatar: `${form.ch_name}.png` }));
    engine.buses.services.register('stCharacterCard.merge', ({ body }) => { written.push(body); return true; });
    engine.buses.services.register('characterCardVersions.put', () => true);
    createCharacterCardsCore(engine.registerCaller('core.characterCard', 'cores', { tier: 'official' }), { publish: () => {}, now: () => 1 });
    return { call: (contract, params) => request(engine.buses.cores, contract, { params }), written };
}

test('a card with standing negations is not written at all: the refusal names the places, and with negations_ok the same card goes through', async () => {
    const { call, written } = build();
    const fields = { name: 'Cleo', description: 'She is calm.', post_history_instructions: 'Cleo never raises her voice. She does not swear.' };
    const refused = await call('characterCard.create', { fields });
    assert.equal(refused.ok, false);
    assert.match(refused.error.message, /Not written: standing negations[^]*post_history_instructions/);
    assert.equal(written.length, 0, 'nothing reached SillyTavern');
    const allowed = await call('characterCard.create', { fields, negationsOk: true });
    assert.equal(allowed.ok, true);
    assert.equal(written.length, 1);
});
