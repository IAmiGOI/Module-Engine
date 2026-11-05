import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { createRollNoteCore } from '../cores/ui/roll-note.js';
import { buildWriterContext } from '../libraries/core/decision-context.js';
import { buildRollLines, shortAction } from '../libraries/core/decision-push.js';
import { makeFakeDocument, FakeElement, FakeTextNode } from './helpers/fake-document.js';

const DOM_CONTRACTS = ['dom.createElement', 'dom.createTextNode', 'dom.setProp', 'dom.removeProp', 'dom.append', 'dom.remove', 'dom.replaceWith'];
const tick = (ms = 10) => new Promise(done => setTimeout(done, ms));

function build({ showRolls = 'chat', lines = ['Kael — picks the lock — cleanly, without a hitch'] } = {}) {
    const engine = createEngine();
    const doc = makeFakeDocument();
    registerDomService(engine.registerCaller('service.dom', 'services', { tier: 'official' }).own, { document: doc });

    const text = new FakeElement('div');
    text.className = 'mes_text';
    text.append(new FakeTextNode('The door opens.'));
    const block = new FakeElement('div');
    block.className = 'mes_block';
    block.append(text);

    let rendered = [{ mesid: '3', isUser: false, isSystem: false }];
    let current = { showRolls, lines };
    engine.buses.services.register('stChat.rendered', () => rendered);
    engine.buses.services.register('stChat.renderedIds', () => rendered.map(item => item.mesid));
    engine.buses.services.register('stChat.messageTextElement', ({ mesid }) => (rendered.some(item => item.mesid === mesid) ? text : null));
    engine.buses.services.register('stChat.messageElement', () => block);
    engine.buses.services.register('stChat.container', () => new FakeElement('div'));
    engine.buses.cores.register('decision.messageRolls', ({ mesid }) => ({ ...current, mesid }));

    const host = engine.registerCaller('core.ui.rollNote', 'cores', { tier: 'official' });
    const finalUiHost = engine.registerCaller('core.ui.rollNote.final', 'cores', { tier: 'official', allowedContracts: DOM_CONTRACTS });
    const core = createRollNoteCore(host, { createFinalUi: () => createFinalUiPc(finalUiHost), observe: () => () => {} });
    return {
        engine, core, block, text,
        set: value => { current = value; },
        setRendered: value => { rendered = value; },
    };
}

test('a chat roll line is its own element above the reply, and the message text stays untouched', async () => {
    const world = build();
    await world.core.start();
    const note = world.block.children[0];
    assert.equal(note.className, 'stme-roll-note');
    assert.equal(world.block.children[1], world.text);
    assert.match(note.textContent, /Kael — picks the lock — cleanly, without a hitch/);
    assert.doesNotMatch(note.textContent, /\d|%/);
    assert.equal(world.text.textContent, 'The door opens.', 'the reply itself is not rewritten');
});

test('the roll line is drawn only for "In the chat"', async () => {
    for (const showRolls of ['log', 'hidden']) {
        const world = build({ showRolls });
        await world.core.start();
        assert.equal(world.block.children.length, 1, `${showRolls}: no element`);
        assert.equal(world.block.children[0], world.text);
        assert.deepEqual(world.core.notes(), []);
    }
});

test('no rolls for the turn means no element', async () => {
    const world = build({ lines: [] });
    await world.core.start();
    assert.equal(world.block.children.length, 1);
    assert.deepEqual(world.core.notes(), []);
});

test('a swipe shows the rolls of its own variant', async () => {
    const world = build();
    await world.core.start();
    world.set({ showRolls: 'chat', lines: ['Mira — slips through the gap — barely, with visible effort'] });
    await world.core.attach();
    const note = world.block.children[0];
    assert.match(note.textContent, /Mira — slips through the gap/);
    assert.doesNotMatch(note.textContent, /Kael/);
    assert.equal(world.block.children[1], world.text);
});

test('the line appears once the turn is saved, not only on generation.completed', async () => {
    const world = build({ lines: [] });
    await world.core.start();
    assert.equal(world.block.children.length, 1, 'nothing to show before the run is written');
    world.set({ showRolls: 'chat', lines: ['Kael — picks the lock — cleanly, without a hitch'] });
    world.engine.events.emit('decision.run.saved', { mesid: '3' });
    await tick();
    assert.equal(world.block.children[0].className, 'stme-roll-note');
});

test('a deleted message takes its roll line with it', async () => {
    const world = build();
    await world.core.start();
    assert.equal(world.core.notes().length, 1);
    world.setRendered([]);
    await world.core.attach();
    assert.deepEqual(world.core.notes(), []);
    assert.equal(world.block.children.length, 1);
});

test('the writer context has no roll line at all', () => {
    const context = buildWriterContext({ chat: [], decision: 'The door opens.' });
    assert.doesNotMatch(JSON.stringify(context), /ROLL LINE/);
});

test('roll lines carry no odds and shorten a long action', () => {
    const form = { characters: [
        { name: 'Kael', action: 'tries to pick the lock of the old cellar door while the guard is talking', assessId: 'a1' },
        { name: 'Mira', action: 'watches', idle: true },
        { name: 'Puck', action: 'slips away' },
    ] };
    const assessments = new Map([['a1', { id: 'a1', probability: 0.62, roll: 0.4, words: 'cleanly, without a hitch' }]]);
    const lines = buildRollLines({ form, assessments });
    assert.equal(lines.length, 1, 'only the roll the form refers to');
    assert.match(lines[0], /^Kael — .+… — cleanly, without a hitch$/);
    assert.doesNotMatch(lines[0], /\d|%/);
    assert.ok(shortAction('a short action') === 'a short action');
});

test('the user\'s own roll, not cited by the form, is shown first', async () => {
    const { buildRollLines } = await import('../libraries/core/decision-push.js');
    const lines = buildRollLines({
        form: { characters: [{ name: 'Emilia', action: 'Raises a wall of ice', assessId: 'a2' }] },
        assessments: [{ id: 'a1', character: 'Sasha', action: 'Heals the burst vessels', words: 'cleanly, without a hitch' }, { id: 'a2', character: 'Emilia', action: 'Raises a wall of ice', words: 'barely, with visible effort' }],
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Sasha — .* — cleanly/);
    assert.match(lines[1], /^Emilia — /);
});
