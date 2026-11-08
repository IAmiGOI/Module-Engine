import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CREATION_SECTIONS, resolveCreationSection, normalizeCreation, blankCreation, applySection, applySections,
    allSections, missingSections, isComplete, renderCreation, findSection, takeCreationSnapshot,
} from '../libraries/core/decision-creation.js';

function written() {
    let state = blankCreation();
    for (const section of CREATION_SECTIONS) {
        state = applySection(state, { title: section.name, text: `${section.name} is written.`, at: '[Day 1, 06:00]' }).state;
    }
    return state;
}

test('the six guaranteed sections exist from the start, in the owner\'s order', () => {
    const state = blankCreation();
    assert.deepEqual(state.sections.map(section => section.title), [
        'Geography', 'Spirituality and Culture', 'Scales', 'History', 'Politics and Conflicts', 'The User in the World',
    ]);
    assert.equal(state.sections.every(section => section.guaranteed), true);
    assert.equal(state.sections.every(section => section.text === ''), true);
});

test('a section is found by number, by its name and by a close word, and an unknown title is a free section', () => {
    assert.equal(resolveCreationSection('2').name, 'Spirituality and Culture');
    assert.equal(resolveCreationSection('the spirituality of this world').name, 'Spirituality and Culture');
    assert.equal(resolveCreationSection('history').name, 'History');
    assert.equal(resolveCreationSection('Sea routes').guaranteed, false);
    assert.equal(resolveCreationSection('Sea routes').title, undefined);
    assert.equal(resolveCreationSection(''), null);
});

test('writing a section replaces its text and keeps the old one in its history with the RP time', () => {
    let state = applySection(blankCreation(), { title: 'Geography', text: 'Three islands.', at: '[Day 1, 06:00]' }).state;
    state = applySection(state, { title: 'Geography', text: 'Three islands and a reef.', at: '[Day 2, 09:00]', comment: 'a discovery' }).state;
    const geography = state.sections.find(section => section.title === 'Geography');
    assert.equal(geography.text, 'Three islands and a reef.');
    assert.equal(geography.at, '[Day 2, 09:00]');
    assert.equal(state.history.length, 2);
    assert.equal(state.history.at(-1).old, 'Three islands.');
    assert.equal(state.history.at(-1).new, 'Three islands and a reef.');
    assert.equal(state.history.at(-1).comment, 'a discovery');
});

test('a free section goes into the free list, replaces itself on a repeat and never takes a guaranteed slot', () => {
    let state = applySections(blankCreation(), [
        { title: 'Sea routes', text: 'The reef passage.' },
        { title: 'Sea Routes', text: 'The reef passage and the strait.' },
        { title: 'Scales', text: 'Magic is a weight.' },
    ]).state;
    assert.equal(state.extra.length, 1);
    assert.equal(state.extra[0].text, 'The reef passage and the strait.');
    assert.equal(state.sections.find(section => section.title === 'Scales').text, 'Magic is a weight.');
    assert.equal(allSections(state).length, 7);
    assert.equal(findSection(state, 'sea routes')?.title, 'Sea Routes');
});

test('the Creation is complete only when every guaranteed section and at least one system of weight is written', () => {
    assert.deepEqual(missingSections(blankCreation()).length, 7);
    assert.equal(isComplete(blankCreation()), false);
    const state = written();
    assert.deepEqual(missingSections(state), ['Scales — no system is written yet']);
    assert.equal(isComplete(state), false, 'Scales is structural: a text is not enough');
    const done = { ...state, scales: [{ id: 'scale:mana', name: 'Mana', principle: 'Will made real.', payment: 'focus', rules: [], discoveries: [] }] };
    assert.deepEqual(missingSections(done), []);
    assert.equal(isComplete(done), true);
});

test('the Creation renders as the stable part of the resolver context: every written section, then the systems', () => {
    const state = { ...written(), scales: [{ id: 'scale:mana', name: 'Mana', principle: 'Will made real.', payment: 'focus', rules: [{ name: 'Shape', needs: ['an image'], yields: ['matter'], weight: { level: 'moderate', rises: '', falls: '', text: 'moderate' }, scaling: [], limit: [], cost: [], links: [], examples: [] }], discoveries: [] }] };
    const text = renderCreation(state);
    assert.match(text, /^CREATION — the world the story stands in/);
    assert.match(text, /### Geography\nGeography is written\./);
    assert.match(text, /### Scales — the systems of this world/);
    assert.match(text, /### Mana/);
    assert.equal(renderCreation(blankCreation()), '', 'an empty Creation is not a block at all');
});

test('the normalizer keeps a stored Creation safe and restores any guaranteed section it lost', () => {
    const state = normalizeCreation({ sections: [{ title: 'History', text: 'The old war.' }], scales: 'nonsense' });
    assert.equal(state.sections.length, 6);
    assert.equal(state.sections.find(section => section.title === 'History').text, 'The old war.');
    assert.deepEqual(state.scales, []);
    const fresh = takeCreationSnapshot(state, { at: '[Day 3]', seq: 4 });
    assert.deepEqual(fresh.snapshots, { at: '[Day 3]', seq: 4 });
});
