import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createSpeakerCore } from '../cores/speaker/index.js';
import { createSpeakerColorsModule, MODULE_ID } from '../modules/speaker-colors/index.js';

/**
 * Scenario level (TESTING.md) — real engine, real speaker Core (real
 * detection + cast + persistence), real Гейт-checked dispatch. Only the
 * ST-facing DOM/`stChat` SEAM is faked — a "node" here is just an opaque
 * per-message marker object, and the fake `dom.*` services record what the
 * Module asked for instead of touching real DOM.
 */
function buildEngine() {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const speakerCore = createSpeakerCore(engine.registerCaller('core.speaker', 'cores', { tier: 'official' }));
    return { engine, speakerCore };
}

/** A fake `.mes_text`-equivalent — just an id, never touched as real DOM. */
function fakeMessageNode(mesid) {
    return { __fakeMessageNode: true, mesid };
}

function wireFakeChatDom(engine, { messages, accent = '#3f51b5' }) {
    const paintCalls = [];
    const clearCalls = [];
    const bus = engine.buses.services;
    bus.register('stChat.rendered', () => messages.map(message => ({ mesid: message.mesid, isUser: false, isSystem: false, isToolCall: false })), { loadMetric: () => 0 });
    bus.register('stChat.messages', () => messages.map(message => ({ mesid: message.mesid, name: message.name ?? '', text: message.text, isUser: false, isSystem: false })), { loadMetric: () => 0 });
    bus.register('stChat.messageTextElement', ({ mesid }) => fakeMessageNode(mesid), { loadMetric: () => 0 });
    bus.register('dom.textContent', ({ node }) => messages.find(message => message.mesid === node.mesid)?.text ?? '', { loadMetric: () => 0 });
    bus.register('dom.paintTextRuns', ({ container, runs }) => { paintCalls.push({ mesid: container.mesid, runs }); return true; }, { loadMetric: () => 0 });
    bus.register('dom.clearPaintedRuns', ({ container }) => { clearCalls.push(container.mesid); return true; }, { loadMetric: () => 0 });
    bus.register('dom.readCssVariable', () => accent, { loadMetric: () => 0 });
    return { paintCalls, clearCalls };
}

function buildModuleHost(engine) {
    return engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'speaker.resolve', 'speaker.cast.list', 'speaker.cast.add', 'speaker.cast.remove', 'speaker.cast.update',
            'speaker.presets.get', 'speaker.presets.save', 'speaker.presets.delete', 'speaker.presets.apply',
            'stChat.rendered', 'stChat.messageTextElement', 'stChat.messages',
            'dom.textContent', 'dom.paintTextRuns', 'dom.clearPaintedRuns', 'dom.readCssVariable',
        ],
    });
}

test('load() with an EMPTY cast paints nothing and adds NOBODY — the exact bug the owner reported must not happen even on a real repaint pass', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, {
        messages: [{ mesid: '3', text: 'Not gentle. Looks back. Pauses. Holds your hand. "Half a day," she says.' }],
    });
    const moduleHost = buildModuleHost(engine);
    const moduleInstance = createSpeakerColorsModule(moduleHost);

    await moduleInstance.load();

    assert.deepEqual(paintCalls[0].runs, [], 'nothing resolves with an empty cast — no run is painted');
    const cast = await new Promise(resolve => moduleHost.cores.subscribe('speaker.cast.list', {}, resolve));
    assert.deepEqual(cast.value, [], 'the cast must stay empty — no character was invented from the prose');
});

test('load() paints a quote for a character the user ALREADY ADDED to the cast, with an auto-assigned color', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, {
        messages: [{ mesid: '3', text: 'Lisawoo looks back. "Half a day," she says.' }],
        accent: '#3f51b5',
    });
    const moduleHost = buildModuleHost(engine);
    await new Promise(resolve => moduleHost.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    const moduleInstance = createSpeakerColorsModule(moduleHost);

    await moduleInstance.load();

    assert.equal(paintCalls[0].mesid, '3');
    assert.equal(paintCalls[0].runs.length, 1);
    assert.match(paintCalls[0].runs[0].color, /^#[0-9a-f]{6}$/);
});

test('a message whose OWN text never names its speaker still gets its pronoun-only quote painted, using the ST message card name — but ONLY because that name is already in the user-entered cast', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, {
        messages: [{ mesid: '7', name: 'Lisawoo', text: 'She looks at you. "Burden." She repeats the word like she\'s tasting something spoiled.' }],
    });
    const moduleHost = buildModuleHost(engine);
    await new Promise(resolve => moduleHost.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    const moduleInstance = createSpeakerColorsModule(moduleHost);

    await moduleInstance.load();

    assert.equal(paintCalls[0].runs.length, 1, 'the pronoun-only quote must resolve via the ALREADY-KNOWN cast member, not stay unattributed');
});

test('a re-render event (e.g. a swipe) triggers a full repaint again', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, { messages: [{ mesid: '1', text: 'Lisawoo walks ahead. "Half a day."' }] });
    const moduleHost = buildModuleHost(engine);
    await new Promise(resolve => moduleHost.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    const moduleInstance = createSpeakerColorsModule(moduleHost);
    await moduleInstance.load();
    assert.equal(paintCalls.length, 1);

    engine.events.emit('st.messageSwiped', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(paintCalls.length, 2, 'the swipe event must trigger a second full repaint pass');
});

test('a message with NO recoverable speaker at all (no quote) is cleared, not left with a stale paint from a previous version of the text', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { clearCalls } = wireFakeChatDom(engine, { messages: [{ mesid: '5', text: '' }] });
    const moduleInstance = createSpeakerColorsModule(buildModuleHost(engine));

    await moduleInstance.load();

    assert.deepEqual(clearCalls, ['5']);
});

test('module.stop() unsubscribes every redraw listener — a repaint no longer fires once the Module is disabled', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, { messages: [{ mesid: '1', text: 'Lisawoo walks ahead. "Half a day."' }] });
    const moduleHost = buildModuleHost(engine);
    await new Promise(resolve => moduleHost.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    const moduleInstance = createSpeakerColorsModule(moduleHost);
    await moduleInstance.load();
    const countAfterLoad = paintCalls.length;

    moduleInstance.stop();
    engine.events.emit('st.messageSwiped', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(paintCalls.length, countAfterLoad, 'no repaint must fire after stop()');
});
