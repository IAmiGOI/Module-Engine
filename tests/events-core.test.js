import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerStEventsService } from '../services/st-events.js';
import { createEventsCore, computeEngineEventName } from '../cores/events/index.js';

// --- Unit level: the name derivation, independent of any bus ---------------

test('computeEngineEventName() turns an ST key into a namespaced engine event name', () => {
    assert.equal(computeEngineEventName('CHAT_CHANGED'), 'st.chatChanged');
    assert.equal(computeEngineEventName('MESSAGE_RECEIVED'), 'st.messageReceived');
    assert.equal(computeEngineEventName('GENERATE_AFTER_COMBINE_PROMPTS'), 'st.generateAfterCombinePrompts');
});

// --- Scenario level (TESTING.md "Уровень 2") -------------------------------

/** A fake SillyTavern: real `on`/`off` bookkeeping plus a `fire()` to play an event as ST would. */
function fakeSillyTavern(eventTypes = { CHAT_CHANGED: 'chat_id_changed', MESSAGE_RECEIVED: 'message_received', STREAM_TOKEN_RECEIVED: 'stream_token_received' }) {
    const listeners = new Map(); // real name -> [handler]
    const context = {
        eventTypes,
        eventSource: {
            on: (name, handler) => listeners.set(name, [...(listeners.get(name) ?? []), handler]),
            off: (name, handler) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== handler)),
        },
    };
    return {
        context,
        listenerCount: key => (listeners.get(eventTypes[key] ?? key) ?? []).length,
        fire: (key, ...args) => { for (const handler of listeners.get(eventTypes[key] ?? key) ?? []) handler(...args); },
    };
}

function buildEngine() {
    const engine = createEngine();
    const st = fakeSillyTavern();
    registerStEventsService(engine.buses.services, { getContext: () => st.context });
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));
    return { engine, st, eventsCore };
}

test('a real ST event reaches the Шина событий under its engine name, carrying the original args', async () => {
    const { engine, st, eventsCore } = buildEngine();
    await eventsCore.bridge();
    const seen = [];
    engine.events.subscribe('st.chatChanged', payload => seen.push(payload));

    st.fire('CHAT_CHANGED', 'chat-42');

    assert.deepEqual(seen, [{ event: 'CHAT_CHANGED', args: ['chat-42'] }]);
});

test('bridge() with no argument bridges everything this ST build advertises — except the per-token streaming events', async () => {
    const { st, eventsCore } = buildEngine();

    const bridged = await eventsCore.bridge();

    assert.ok(bridged.includes('CHAT_CHANGED'));
    assert.ok(bridged.includes('MESSAGE_RECEIVED'));
    assert.equal(bridged.includes('STREAM_TOKEN_RECEIVED'), false, 'a per-token event would flood the bus for every generation');
    assert.equal(st.listenerCount('STREAM_TOKEN_RECEIVED'), 0);
});

test('every bridged event ALSO reaches the firehose, stamped with its source', async () => {
    const { engine, st, eventsCore } = buildEngine();
    await eventsCore.bridge();
    const seen = [];
    engine.events.subscribe('events.any', payload => seen.push(payload));

    st.fire('MESSAGE_RECEIVED', 7);

    assert.deepEqual(seen, [{ event: 'st.messageReceived', source: 'sillytavern', payload: { event: 'MESSAGE_RECEIVED', args: [7] } }]);
});

test('an internal Ядро publishes through the same Ядро событий, and it lands on the bus with its own source', async () => {
    const { engine, eventsCore } = buildEngine();
    const seen = [];
    const firehose = [];
    engine.events.subscribe('tracking.blocks.changed', payload => seen.push(payload));
    engine.events.subscribe('events.any', payload => firehose.push(payload));

    eventsCore.publish('tracking.blocks.changed', { trackerId: 'char' }, { source: 'core.tracking' });

    assert.deepEqual(seen, [{ trackerId: 'char' }]);
    assert.equal(firehose[0].source, 'core.tracking');
});

test('an internal publisher may NOT forge an "st.*" event — that namespace belongs to the real ST bridge', async () => {
    const { eventsCore } = buildEngine();

    assert.throws(() => eventsCore.publish('st.chatChanged', {}, { source: 'core.sneaky' }), /reserved/);
});

test('a re-publish of the SAME event from inside its own dispatch is suppressed — that is a loop, never legitimate', async () => {
    const { engine, eventsCore } = buildEngine();
    let deliveries = 0;
    engine.events.subscribe('demo.tick', () => {
        deliveries += 1;
        eventsCore.publish('demo.tick', {}, { source: 'core.demo' }); // re-entrant, must not recurse
    });

    eventsCore.publish('demo.tick', {}, { source: 'core.demo' });

    assert.equal(deliveries, 1);
});

test('an UNguarded event never loses deliveries, however fast it fires — the lossy guard is opt-in for a reason', async () => {
    const { engine, eventsCore } = buildEngine();
    const seen = [];
    engine.events.subscribe('demo.noisy', () => seen.push(1));

    for (let i = 0; i < 12; i++) eventsCore.publish('demo.noisy', { i }, { source: 'core.demo' });

    assert.equal(seen.length, 12);
});

test('a storm of the guarded ST event stops being delivered once it passes the burst limit', async () => {
    const { engine, st, eventsCore } = buildEngine();
    await eventsCore.bridge();
    let deliveries = 0;
    engine.events.subscribe('st.chatChanged', () => { deliveries += 1; });

    for (let i = 0; i < 12; i++) st.fire('CHAT_CHANGED', i);

    assert.ok(deliveries > 0, 'normal chat switching still works');
    assert.ok(deliveries < 12, `a runaway loop must be cut off, got ${deliveries} deliveries`);
});

test('stop() detaches every ST listener — a fired event afterwards reaches nothing', async () => {
    const { engine, st, eventsCore } = buildEngine();
    await eventsCore.bridge();
    const seen = [];
    engine.events.subscribe('st.chatChanged', payload => seen.push(payload));

    await eventsCore.stop();
    st.fire('CHAT_CHANGED', 'after-teardown');

    assert.equal(st.listenerCount('CHAT_CHANGED'), 0);
    assert.deepEqual(seen, []);
});

test('events.surface reports the live event surface — what fired, from where, how often', async () => {
    const { engine, st, eventsCore } = buildEngine();
    await eventsCore.bridge();
    const module = engine.registerCaller('module.devPanel', 'modules', { tier: 'official' });
    st.fire('CHAT_CHANGED', 'a');
    st.fire('CHAT_CHANGED', 'b');
    eventsCore.publish('tracking.blocks.changed', {}, { source: 'core.tracking' });

    const result = await new Promise(resolve => module.cores.subscribe('events.surface', {}, resolve));

    const chatChanged = result.value.find(entry => entry.event === 'st.chatChanged');
    assert.equal(chatChanged.count, 2);
    assert.equal(chatChanged.source, 'sillytavern');
    assert.ok(result.value.some(entry => entry.event === 'tracking.blocks.changed' && entry.source === 'core.tracking'));
});

test('a Module publishes through the Gate-checked contract; one without the right is refused', async () => {
    const { engine } = buildEngine();
    const allowed = engine.registerCaller('module.ok', 'modules', { tier: 'community', allowedContracts: ['events.publish'] });
    const denied = engine.registerCaller('module.nope', 'modules', { tier: 'community', allowedContracts: [] });
    const seen = [];
    engine.events.subscribe('module.ok.something', payload => seen.push(payload));

    const okResult = await new Promise(resolve => allowed.cores.subscribe('events.publish', { params: { event: 'module.ok.something', payload: { a: 1 }, source: 'module.ok' } }, resolve));
    const deniedResult = await new Promise(resolve => denied.cores.subscribe('events.publish', { params: { event: 'module.nope.something', payload: {} } }, resolve));

    assert.equal(okResult.ok, true);
    assert.deepEqual(seen, [{ a: 1 }]);
    assert.equal(deniedResult.ok, false);
});
