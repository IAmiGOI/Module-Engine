import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreationStore } from '../cores/decision/creation.js';
import { createPapersStore } from '../cores/decision/store-papers.js';
import { answerGodQuestion, renderGodQuestions } from '../libraries/core/decision-god-queue.js';
import { blankCreation, CREATION_SECTIONS, applySection } from '../libraries/core/decision-creation.js';

function memoryCall() {
    const memory = new Map();
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? memory.get(params.key) : params.fallback ?? null;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return params.value; }
        return null;
    };
    return { call, memory };
}

function storeWithCreation() {
    const { call, memory } = memoryCall();
    let state = blankCreation();
    for (const section of CREATION_SECTIONS) state = applySection(state, { title: section.name, text: `${section.name} is written.`, at: '[Day 1, 06:00]' }).state;
    memory.set('creation', { ...state, scales: [{ id: 'scale:mana', name: 'Mana', principle: 'Will made real.', payment: 'focus', rules: [], discoveries: [] }] });
    const creation = createCreationStore({ call, publishEvent: () => {} });
    return { creation, memory, call };
}

test('Creation lives in the chat memory, and a build writes section by section', async () => {
    const { call, memory } = memoryCall();
    const creation = createCreationStore({ call, publishEvent: () => {} });
    const result = await creation.writeSections({ sections: [{ title: 'Geography', text: 'Three islands.' }], at: '[Day 1]' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.sections, ['Geography']);
    assert.equal(memory.get('creation').sections.find(section => section.title === 'Geography').text, 'Three islands.');
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('History'));
});

test('a system of weight is written structurally, and its Discoveries survive a rewrite', async () => {
    const { call } = memoryCall();
    const creation = createCreationStore({ call, publishEvent: () => {} });
    const first = await creation.writeScale({ system: 'Mana', principle: 'Will made real.', payment: 'focus', rules: [{ name: 'Shape', needs: 'an image', yields: 'matter', weight: 'moderate' }] });
    assert.equal(first.ok, true);
    assert.equal(first.rules, 1);
    await creation.writeDiscovery({ system: 'Mana', rule: 'Shape', text: 'Iron can burn.', at: '[Day 2]' });
    const again = await creation.writeScale({ system: 'Mana', principle: 'Will made real.', payment: 'focus and blood', rules: [{ name: 'Shape', needs: 'an image', yields: 'matter', weight: 'hard' }] });
    assert.equal(again.replaced, true);
    const system = creation.state().scales[0];
    assert.equal(system.payment, 'focus and blood');
    assert.equal(system.discoveries.length, 1, 'a rewrite of the rules does not erase the world\'s precedents');
});

test('the resolver sees the Creation through a snapshot, and a new Discovery arrives as the short block at the task', async () => {
    const { creation } = storeWithCreation();
    const text = await creation.resolverText();
    assert.match(text, /CREATION — the world the story stands in/);
    assert.match(text, /Geography is written\./);
    assert.equal(creation.discoveries(), '', 'nothing new since the snapshot');
    await creation.writeDiscovery({ system: 'Mana', rule: 'Shape', text: 'Iron can burn.', at: '[Day 2]' });
    // Снимок не переписан: резолвер видит прежний текст, а открытие — коротким блоком у задания.
    assert.match(creation.discoveries(), /Iron can burn/);
    await creation.refreshSnapshot();
    assert.equal(creation.discoveries(), '', 'after the window switch the Discovery lives in the stable part');
    const fresh = await creation.resolverText();
    assert.match(fresh, /Iron can burn/, 'the window switch brings the Discovery into the stable part');
});

test('a God question is answered into a Declaration only after every question is closed', () => {
    const questions = [
        { id: 'q1', question: 'Is there iron?', answer: '' },
        { id: 'q2', question: 'Who rules the reef?', answer: '' },
    ];
    const first = answerGodQuestion(questions, { id: 'q1', answer: 'Yes, under the reef.', at: 5 });
    assert.equal(first.closed, false);
    assert.equal(first.declaration, null, 'one answer is not a Declaration');
    const second = answerGodQuestion(first.questions, { id: 'q2', answer: 'The reef council.', at: 6 });
    assert.equal(second.closed, true);
    assert.equal(second.declaration.answers.length, 2);
    assert.deepEqual(second.declaration.answers.map(item => item.question), ['Is there iron?', 'Who rules the reef?']);
});

test('the papers store keeps God\'s questions, answers and the Declaration across a load', async () => {
    const { call } = memoryCall();
    const papers = createPapersStore({ enqueue: job => job(), call });
    papers.load({ papers: null });
    await papers.addGodQuestions([{ question: 'Is there iron?', why: 'the mines' }], { turn: 4, at: 100 });
    const asked = papers.god().questions;
    assert.equal(asked.length, 1);
    assert.equal(asked[0].turn, 4);
    const answered = await papers.answerGod({ id: asked[0].id, answer: 'Yes, under the reef.', at: 200 });
    assert.equal(answered.closed, true);
    assert.equal(papers.god().declaration.answers[0].answer, 'Yes, under the reef.');
    await papers.markPrayersRead?.(300);
});
