import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleContext } from '../cores/decision/cycle-context.js';
import { createScalesHint } from '../cores/decision/scales-hint.js';
import {
    scalesHintState, scalesHintQuestions, scalesHintSystems, scalesHintBlock, SCALES_HINT_THRESHOLD,
} from '../libraries/core/decision-scales-hint.js';
import { normalizeScaleSystem } from '../libraries/core/decision-scales.js';
import { createCycleRecord } from '../libraries/core/decision-log.js';

function mana() {
    return normalizeScaleSystem({
        system: 'Mana', principle: '**Will** made real. It costs focus.', payment: 'focus',
        rules: [{ name: 'Shape', needs: ['a clear image'], yields: ['the imagined object'], weight: 'hard; rises with the size', limit: ['nothing alive'] }],
    });
}

function craft() {
    return normalizeScaleSystem({
        system: 'Craft', principle: 'Hands remember what the mind forgets.', payment: 'time',
        rules: [{ name: 'Mend', needs: ['a needle'], yields: ['a seam'], weight: 'easy' }],
    });
}

test('the classifier slice is the last three messages, with the latest marked', () => {
    const long = 's'.repeat(2000);
    const chat = [
        { mes: 'ignored', is_user: true },
        { mes: 'previous user', is_user: true },
        { mes: 'previous story', is_user: false },
        { mes: long, is_user: true },
        { mes: 'latest', is_user: true },
    ];
    assert.equal(
        scalesHintState(chat),
        `Story: previous story\nUser: ${'s'.repeat(1500)}\nUser (latest): latest`,
    );
    assert.equal(scalesHintState([{ mes: 'hidden', is_system: true }, { mes: 'only', is_user: true }]), 'User (latest): only');
});

test('one question per system, the second sentence is the first sentence of its principle without bold', () => {
    const questions = scalesHintQuestions([mana(), craft()]);
    assert.deepEqual(Object.keys(questions), ['scale:mana', 'scale:craft']);
    assert.equal(questions['scale:mana'], `The latest user message concerns Mana: the user's character uses it, keeps using it, or talks about it. Mana: Will made real.`);
    assert.equal(questions['scale:craft'], `The latest user message concerns Craft: the user's character uses it, keeps using it, or talks about it. Craft: Hands remember what the mind forgets.`);
    assert.doesNotMatch(questions['scale:mana'], /\*\*/);
});

test('the threshold is 0.2 and includes its own value', () => {
    assert.equal(SCALES_HINT_THRESHOLD, 0.2);
    const systems = [mana(), craft()];
    assert.deepEqual(
        scalesHintSystems(systems, { 'scale:mana': 0.19, 'scale:craft': 0.2 }).map(item => item.name),
        ['Craft'],
    );
    assert.deepEqual(
        scalesHintSystems(systems, { 'scale:mana': 0.2, 'scale:craft': 0.34 }).map(item => [item.name, item.chance]),
        [['Mana', 0.2], ['Craft', 0.34]],
    );
    assert.deepEqual(
        scalesHintSystems(systems, { 'scale:mana': 0.19 }).map(item => item.name),
        [],
    );
});

test('the block is the header and the rule cards of the touched systems, and it never says what to do', () => {
    const hinted = scalesHintSystems([mana(), craft()], { 'scale:mana': 0.5, 'scale:craft': 0.19 });
    const block = scalesHintBlock(hinted);
    assert.match(block, /^THE WORLD'S SYSTEMS THIS TURN TOUCHES — their rules in full:/);
    assert.match(block, /RULE Mana \/ Shape/);
    assert.doesNotMatch(block, /RULE Craft \/ Mend/);
    assert.doesNotMatch(block, /\bmust\b/i);
    assert.doesNotMatch(block, /\buse\b/i);
});

function harness({ connectionId = 'hint', connections = [{ id: 'hint', apiKey: 'key' }], decide = () => ({ answers: { 'scale:mana': 0.6 }, failed: [] }) } = {}) {
    const calls = [];
    const events = [];
    const call = async (contract, params) => {
        calls.push({ contract, params });
        if (contract === 'classifier.connections.get') return connections;
        if (contract === 'classifier.decide') return decide(params);
        throw new Error(`unexpected contract ${contract}`);
    };
    const creation = { load: async () => {}, state: () => ({ scales: [mana(), craft()] }) };
    const hint = createScalesHint({
        call, creation,
        getSettings: () => ({ scalesHint: { connectionId } }),
        publishEvent: (event, payload) => events.push([event, payload]),
    });
    return { hint, calls, events };
}

test('the classifier asks its connection once and the found systems come back with their rule cards', async () => {
    const world = harness();
    const result = await world.hint([{ mes: 'I shape the iron.', is_user: true }]);
    assert.deepEqual(result.systems, [{ name: 'Mana', chance: 0.6 }]);
    assert.match(result.text, /RULE Mana \/ Shape/);
    assert.doesNotMatch(result.text, /RULE Craft \/ Mend/);
    const decide = world.calls.find(item => item.contract === 'classifier.decide');
    assert.equal(decide.params.calls[0].connectionId, 'hint');
    assert.deepEqual(decide.params.calls[0].state, { player_message: 'User (latest): I shape the iron.' });
    assert.deepEqual(Object.keys(decide.params.calls[0].questions), ['scale:mana', 'scale:craft']);
    assert.deepEqual(world.events, [['decision.scales.hint', { connectionId: 'hint', systems: [{ name: 'Mana', chance: 0.6 }] }]]);
});

test('without a chosen connection or without a key no classifier call is made and no event is raised', async () => {
    const empty = harness({ connectionId: '' });
    assert.equal(await empty.hint([{ mes: 'hi', is_user: true }]), null);
    assert.equal(empty.calls.length, 0);
    assert.deepEqual(empty.events, []);

    const keyless = harness({ connections: [{ id: 'hint' }] });
    assert.equal(await keyless.hint([{ mes: 'hi', is_user: true }]), null);
    assert.deepEqual(keyless.calls.map(item => item.contract), ['classifier.connections.get']);
    assert.deepEqual(keyless.events, []);
});

test('a classifier failure is reported and leaves no block; the turn goes on without it', async () => {
    const failed = harness({ decide: () => ({ answers: {}, failed: ['scale:mana', 'scale:craft'], error: 'The request timed out.' }) });
    assert.equal(await failed.hint([{ mes: 'hi', is_user: true }]), null);
    assert.deepEqual(failed.events, [['decision.scales.hint.failed', { connectionId: 'hint', error: 'The request timed out.' }]]);

    const built = await contextWithHint('');
    assert.match(built.messages.at(-1).content, /A new turn has started/);
    assert.match(built.messages.at(-1).content, /\*\*How You Think This Turn\*\*/);
});

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

async function contextWithHint(scalesHint, task = 'A new turn has started.') {
    const creation = {
        load: async () => {},
        state: () => ({ scales: [mana(), craft()] }),
        resolverText: async () => 'CREATION — the world.',
        discoveries: () => '',
    };
    const context = createCycleContext({ call, store: store(), banks: null, creation });
    return context.runContext({
        settings: { promptSections: {} }, chat: [{ mes: 'latest', is_user: true }], worker: { id: 'director' },
        task, scalesHint,
    });
}

test('the rule cards sit at the end of the turn task, after it and before the CoT', async () => {
    const block = scalesHintBlock(scalesHintSystems([mana(), craft()], { 'scale:mana': 0.5, 'scale:craft': 0.1 }));
    const built = await contextWithHint(block);
    const last = built.messages.at(-1).content;
    const at = last.indexOf(`THE WORLD'S SYSTEMS THIS TURN TOUCHES`);
    assert.ok(at > last.indexOf('A new turn has started'));
    assert.ok(at < last.indexOf('**How You Think This Turn**'));
    assert.match(last, /RULE Mana \/ Shape/);
    assert.doesNotMatch(last, /RULE Craft \/ Mend/);
    assert.ok(built.messages.some(message => String(message.content).startsWith('CREATION —')), 'the Creation stays in the stable part');
});

test('a hint without a mode block does not replace the turn template', async () => {
    const block = scalesHintBlock(scalesHintSystems([mana()], { 'scale:mana': 0.5 }));
    const built = await contextWithHint(block, '');
    const last = built.messages.at(-1).content;
    assert.match(last, /^A new turn has started\./);
    assert.match(last, /THE WORLD'S SYSTEMS THIS TURN TOUCHES/);
});

test('the found systems are written into the turn record', () => {
    const cycle = createCycleRecord({ event: 'turn', scalesHint: [{ name: 'Mana', chance: 0.6 }] });
    assert.deepEqual(cycle.scalesHint, [{ name: 'Mana', chance: 0.6 }]);
    assert.equal('scalesHint' in createCycleRecord({ event: 'turn' }), false);
});
