import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleContext } from '../cores/decision/cycle-context.js';
import { createCreationStore } from '../cores/decision/creation.js';
import { blankCreation, CREATION_SECTIONS, applySection } from '../libraries/core/decision-creation.js';

/** Creation в контексте резолвера: стабильная часть, снимок, открытия — у задания. */
const memory = new Map();
const call = async (contract, params = {}) => {
    if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? memory.get(params.key) : params.fallback ?? null;
    if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return params.value; }
    if (contract === 'lorebook.books') return [];
    if (contract === 'lorebook.entries') return [];
    return null;
};

function store() {
    return {
        roster: () => ({ active: [] }), library: () => ({}), plans: () => [], clock: () => ({ minutes: 0, updatedAt: 0 }),
        plan: () => null, arcs: () => [], notes: () => ({}), cycles: () => [], window: () => ({ entries: [] }), frozen: () => [],
        boundary: () => null, saveBoundary: async () => {}, papers: () => ({}), gameSettings: () => null,
    };
}

function fullCreation() {
    let state = blankCreation();
    for (const section of CREATION_SECTIONS) state = applySection(state, { title: section.name, text: `${section.name} is written.` }).state;
    return { ...state, scales: [{ id: 'scale:mana', name: 'Mana', principle: 'Will made real.', payment: 'focus', rules: [], discoveries: [{ at: '[Day 1]', rule: 'Shape', text: 'iron can burn', seq: 1 }] }] };
}

async function build(creation) {
    const context = createCycleContext({ call, store: store(), banks: null, creation });
    return context.runContext({ settings: { promptSections: {} }, chat: [], worker: { id: 'director' } });
}

test('a built Creation stands in the stable part of the resolver context, before the far bank projection', async () => {
    memory.clear();
    memory.set('creation', fullCreation());
    const creation = createCreationStore({ call, publishEvent: () => {} });
    const built = await build(creation);
    const messages = built.messages.map(message => String(message.content));
    const creationAt = messages.findIndex(content => content.startsWith('CREATION — the world the story stands in'));
    assert.ok(creationAt > 0, 'the Creation is a block in the context');
    assert.match(messages[creationAt], /Geography is written\./);
    assert.match(messages[0], /^You are the Resolver of a living roleplay world\./, 'the system prompt is first');
    assert.ok(creationAt > 0, 'the Creation is never the first message');
});

test('a new Discovery since the snapshot travels as a short block at the task, not in the stable part', async () => {
    memory.clear();
    const creation = fullCreation();
    memory.set('creation', creation);
    const storeInstance = createCreationStore({ call, publishEvent: () => {} });
    await build(storeInstance);
    // Новая система-правило не нужна: важно открытие с номером выше снимка.
    await storeInstance.writeDiscovery({ system: 'Mana', rule: 'Shape', text: 'iron can burn in a closed room', at: '[Day 2]' });
    const built = await build(storeInstance);
    const messages = built.messages.map(message => String(message.content));
    const task = messages.at(-1);
    assert.match(task, /NEW DISCOVERIES/);
    assert.match(task, /iron can burn in a closed room/);
    const stable = messages.find(content => content.startsWith('CREATION —'));
    assert.doesNotMatch(stable, /iron can burn in a closed room/, 'the stable part holds the snapshot until the window switch');
});
