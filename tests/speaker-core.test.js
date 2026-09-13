import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createSpeakerCore } from '../cores/speaker/index.js';

/** Scenario level (TESTING.md) — real engine, real Гейты, real dispatch; only the ST-facing `getContext()` boundary is faked. */
function buildEngine() {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, saveSettingsDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const chatContext = { chatMetadata: {}, saveMetadataDebounced: () => {}, saveMetadata: async () => {} };
    registerChatMetadataService(engine.buses.services, { getContext: () => chatContext });
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const speakerHost = engine.registerCaller('core.speaker', 'cores', { tier: 'official' });
    const speakerCore = createSpeakerCore(speakerHost);
    return { engine, speakerCore, chatContext };
}

function moduleCaller(engine, contracts) {
    return engine.registerCaller('module.paint', 'modules', { tier: 'community', allowedContracts: contracts });
}

test('speaker.resolve discovers a new speaker from real prose and speaker.registry.get reflects it', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.resolve', 'speaker.registry.get']);

    const resolved = await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo looks back. "Half a day," she says.' } }, resolve));
    const registry = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));

    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.segments.some(segment => segment.speaker?.name === 'Lisawoo'), true);
    assert.equal(registry.value.some(entity => entity.name === 'Lisawoo'), true);
});

test('speaker.resolve publishes speaker.registryChanged ONLY when a genuinely NEW speaker is discovered, not on every call', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.resolve']);
    const events = [];
    engine.events.subscribe('speaker.registryChanged', () => events.push(1));

    await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo walks. "Half a day."' } }, resolve));
    await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo looks back. "You will know."' } }, resolve));

    assert.equal(events.length, 1, 'the second call resolves the SAME already-known speaker and must not re-fire the discovery event');
});

test('speaker.setColor persists the color, and it survives a fresh registry read (through the real Гейт -> Ядро памяти чата -> Сервис chain)', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.resolve', 'speaker.setColor', 'speaker.registry.get']);
    await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo walks. "Half a day."' } }, resolve));
    const before = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));
    const speakerId = before.value.find(entity => entity.name === 'Lisawoo').id;

    await new Promise(resolve => module.cores.subscribe('speaker.setColor', { params: { id: speakerId, color: '#ff8800' } }, resolve));
    const after = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));

    assert.equal(after.value.find(entity => entity.id === speakerId).color, '#ff8800');
});

test('speaker.presets.save then speaker.presets.apply reproduces the same named speaker (with its saved color) in a DIFFERENT, otherwise-empty chat registry', async () => {
    const { engine, speakerCore, chatContext } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, [
        'speaker.resolve', 'speaker.setColor', 'speaker.registry.get', 'speaker.presets.save', 'speaker.presets.apply',
    ]);
    await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo walks. "Half a day."' } }, resolve));
    const registered = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));
    const speakerId = registered.value.find(entity => entity.name === 'Lisawoo').id;
    await new Promise(resolve => module.cores.subscribe('speaker.setColor', { params: { id: speakerId, color: '#123456' } }, resolve));
    const saved = await new Promise(resolve => module.cores.subscribe('speaker.presets.save', { params: { name: 'My Cast' } }, resolve));

    // Simulate switching to a DIFFERENT, otherwise-empty chat: swap the
    // chatMetadata object under the SAME chat-memory core and fire the real
    // `st.chatChanged` event this Core already subscribes to — the preset,
    // being global `storage.settings` state, survives the swap untouched.
    Object.keys(chatContext.chatMetadata).forEach(key => delete chatContext.chatMetadata[key]);
    engine.events.emit('st.chatChanged', {});
    await new Promise(resolve => setTimeout(resolve, 0)); // let the async reload settle

    const emptyRegistry = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));
    assert.deepEqual(emptyRegistry.value, [], 'the new chat must start with no speakers of its own');

    const applied = await new Promise(resolve => module.cores.subscribe('speaker.presets.apply', { params: { id: saved.value.id } }, resolve));
    assert.equal(applied.ok, true);
    const lisawoo = applied.value.find(entity => entity.name === 'Lisawoo');
    assert.ok(lisawoo, 'applying the preset must (re)create the speaker in the new chat');
    assert.equal(lisawoo.color, '#123456', 'the color saved into the preset must come along with it');
});

test('speaker.rename changes the canonical display name without discarding the entity\'s already-accumulated gender votes', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.resolve', 'speaker.rename', 'speaker.registry.get']);
    await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Her tail streams behind her as Lisawoo walks. "Stay close."' } }, resolve));
    const before = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));
    const entity = before.value.find(item => item.name === 'Lisawoo');
    assert.equal(entity.gender, 'F');

    await new Promise(resolve => module.cores.subscribe('speaker.rename', { params: { id: entity.id, name: 'Lisa' } }, resolve));
    const after = await new Promise(resolve => module.cores.subscribe('speaker.registry.get', {}, resolve));

    const renamed = after.value.find(item => item.id === entity.id);
    assert.equal(renamed.name, 'Lisa');
    assert.equal(renamed.gender, 'F', 'renaming must not reset the gender signal already accumulated for this entity');
});
