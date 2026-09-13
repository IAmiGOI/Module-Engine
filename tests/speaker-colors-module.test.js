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
 * detection + registry + persistence), real Гейт-checked dispatch. Only the
 * ST-facing DOM/`stChat` SEAM is faked, the same discipline every other
 * scenario test in this repo already uses for `getContext()` — a "node" here
 * is just an opaque per-message marker object, and the fake `dom.*`
 * services record what the Module asked for instead of touching real DOM
 * (there is no real `document` in this Node test environment at all, and
 * neither services/dom.js's nor services/st-chat.js's DOM-querying paths are
 * exercised by ANY existing test in this repo for that same reason).
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
            'speaker.resolve', 'speaker.registry.get', 'speaker.setColor', 'speaker.rename',
            'speaker.presets.get', 'speaker.presets.save', 'speaker.presets.delete', 'speaker.presets.apply',
            'stChat.rendered', 'stChat.messageTextElement', 'stChat.messages',
            'dom.textContent', 'dom.paintTextRuns', 'dom.clearPaintedRuns', 'dom.readCssVariable',
        ],
    });
}

test('load() paints the ONE rendered message\'s dialogue run with an auto-assigned color derived from the ST theme accent', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, {
        messages: [{ mesid: '3', text: 'Lisawoo looks back. "Half a day," she says.' }],
        accent: '#3f51b5',
    });
    const moduleInstance = createSpeakerColorsModule(buildModuleHost(engine));

    await moduleInstance.load();

    assert.equal(paintCalls.length, 1);
    assert.equal(paintCalls[0].mesid, '3');
    assert.equal(paintCalls[0].runs.length, 1, 'exactly one dialogue run — the resolved quote');
    assert.match(paintCalls[0].runs[0].color, /^#[0-9a-f]{6}$/);
});

test('load() persists the auto-assigned color into the real speaker registry, not just the paint call', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    wireFakeChatDom(engine, { messages: [{ mesid: '1', text: 'Lisawoo walks ahead. "Half a day."' }] });
    const moduleHost = buildModuleHost(engine);
    const moduleInstance = createSpeakerColorsModule(moduleHost);

    await moduleInstance.load();

    const registry = await new Promise(resolve => moduleHost.cores.subscribe('speaker.registry.get', {}, resolve));
    const lisawoo = registry.value.find(entity => entity.name === 'Lisawoo');
    assert.ok(lisawoo, 'the speaker discovered while painting must land in the persisted registry');
    assert.ok(lisawoo.color, 'and it must already carry the auto-assigned color, not null');
});

test('a re-render event (e.g. a swipe) triggers a full repaint again, through the SAME subscription mechanism as message-footer\'s own redraw guard', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, { messages: [{ mesid: '1', text: 'Lisawoo walks ahead. "Half a day."' }] });
    const moduleInstance = createSpeakerColorsModule(buildModuleHost(engine));
    await moduleInstance.load();
    assert.equal(paintCalls.length, 1);

    engine.events.emit('st.messageSwiped', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(paintCalls.length, 2, 'the swipe event must trigger a second full repaint pass');
});

test('a message whose OWN text never names its speaker still gets its pronoun-only quote painted, using the ST message card\'s own name as the fallback', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const { paintCalls } = wireFakeChatDom(engine, {
        messages: [{ mesid: '7', name: 'Lisawoo', text: 'She looks at you. "Burden." She repeats the word like she\'s tasting something spoiled.' }],
    });
    const moduleHost = buildModuleHost(engine);
    const moduleInstance = createSpeakerColorsModule(moduleHost);

    await moduleInstance.load();

    assert.equal(paintCalls[0].runs.length, 1, 'the pronoun-only quote must still resolve via the message card fallback, not stay unattributed');
    const registry = await new Promise(resolve => moduleHost.cores.subscribe('speaker.registry.get', {}, resolve));
    assert.ok(registry.value.some(entity => entity.name === 'Lisawoo'));
});

test('a message with NO recoverable speaker (no quote at all) is cleared, not left with a stale paint from a previous version of the text', async () => {
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
    const moduleInstance = createSpeakerColorsModule(buildModuleHost(engine));
    await moduleInstance.load();
    const countAfterLoad = paintCalls.length;

    moduleInstance.stop();
    engine.events.emit('st.messageSwiped', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(paintCalls.length, countAfterLoad, 'no repaint must fire after stop()');
});
