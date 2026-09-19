import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createSpeakerCore } from '../cores/speaker/index.js';

/** Scenario level (TESTING.md) — real engine, real Гейты, real dispatch through the Шина ядер and the Шина сервисов; only the ST-facing `getContext()` boundary is faked. */
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

test('speaker.cast.add adds a character with an explicit name+gender, and speaker.cast.list reflects it', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.cast.list']);

    const added = await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    const list = await new Promise(resolve => module.cores.subscribe('speaker.cast.list', {}, resolve));

    assert.equal(added.ok, true);
    assert.equal(added.value.name, 'Lisawoo');
    assert.equal(added.value.gender, 'F');
    assert.deepEqual(list.value, [added.value]);
});

test('speaker.resolve NEVER adds anyone to the cast on its own — running it against prose full of ordinary capitalized words changes nothing', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.resolve', 'speaker.cast.list']);

    await new Promise(resolve => module.cores.subscribe('speaker.resolve', {
        params: { text: 'Not gentle. Looks back. Pauses. Holds your hand. Tighter than yesterday. "Stop calling yourself a burden."' },
    }, resolve));
    const list = await new Promise(resolve => module.cores.subscribe('speaker.cast.list', {}, resolve));

    assert.deepEqual(list.value, [], 'the cast must stay EMPTY — this is the exact bug the owner reported');
});

test('speaker.resolve attributes a quote to an ALREADY-ADDED cast member by name in the text', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.resolve']);
    const added = await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));

    const resolved = await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo looks back. "Half a day," she says.' } }, resolve));

    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.segments.find(segment => segment.type === 'dialogue').speaker.id, added.value.id);
});

test('speaker.cast.update changes gender/color of an EXISTING character without creating a new one', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.cast.update', 'speaker.cast.list']);
    const added = await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Sasha', gender: 'unknown' } }, resolve));

    await new Promise(resolve => module.cores.subscribe('speaker.cast.update', { params: { id: added.value.id, gender: 'M', color: '#123456' } }, resolve));
    const list = await new Promise(resolve => module.cores.subscribe('speaker.cast.list', {}, resolve));

    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].gender, 'M');
    assert.equal(list.value[0].color, '#123456');
});

test('speaker.cast.remove removes a character, and a later resolve() no longer attributes to them', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.cast.remove', 'speaker.resolve']);
    const added = await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));

    await new Promise(resolve => module.cores.subscribe('speaker.cast.remove', { params: { id: added.value.id } }, resolve));
    const resolved = await new Promise(resolve => module.cores.subscribe('speaker.resolve', { params: { text: 'Lisawoo looks back. "Half a day."' } }, resolve));

    assert.equal(resolved.value.segments.find(segment => segment.type === 'dialogue').speaker, null);
});

test('the cast persists through the real Гейт -> Ядро памяти чата -> Сервис chain, surviving a fresh speaker.cast.list read', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.cast.list']);
    await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F', color: '#ff8800' } }, resolve));

    const list = await new Promise(resolve => module.cores.subscribe('speaker.cast.list', {}, resolve));

    assert.equal(list.value[0].color, '#ff8800');
});

test('speaker.presets.save then speaker.presets.apply reproduces the same named+gendered character in a DIFFERENT, otherwise-empty chat cast', async () => {
    const { engine, speakerCore, chatContext } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.cast.list', 'speaker.presets.save', 'speaker.presets.apply']);
    await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F', color: '#123456' } }, resolve));
    const saved = await new Promise(resolve => module.cores.subscribe('speaker.presets.save', { params: { name: 'My Cast' } }, resolve));

    // Simulate switching to a DIFFERENT, otherwise-empty chat.
    Object.keys(chatContext.chatMetadata).forEach(key => delete chatContext.chatMetadata[key]);
    engine.events.emit('st.chatChanged', {});
    await new Promise(resolve => setTimeout(resolve, 0));

    const emptyCast = await new Promise(resolve => module.cores.subscribe('speaker.cast.list', {}, resolve));
    assert.deepEqual(emptyCast.value, []);

    const applied = await new Promise(resolve => module.cores.subscribe('speaker.presets.apply', { params: { id: saved.value.id } }, resolve));
    assert.equal(applied.ok, true);
    const lisawoo = applied.value.find(entity => entity.name === 'Lisawoo');
    assert.ok(lisawoo);
    assert.equal(lisawoo.gender, 'F');
    assert.equal(lisawoo.color, '#123456');
});

test('speaker.castChanged is published on add/update/remove, so the panel knows to refresh', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.cast.update', 'speaker.cast.remove']);
    const events = [];
    engine.events.subscribe('speaker.castChanged', () => events.push(1));

    const added = await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    await new Promise(resolve => module.cores.subscribe('speaker.cast.update', { params: { id: added.value.id, gender: 'F', color: '#fff' } }, resolve));
    await new Promise(resolve => module.cores.subscribe('speaker.cast.remove', { params: { id: added.value.id } }, resolve));

    assert.equal(events.length, 3);
});

test('speaker.paintHtml paints dialogue of a colored cast member on a detached node and returns the painted HTML — the viewport draws text from HTML, so it needs this instead of the native .mes_text', async () => {
    const { engine, speakerCore } = buildEngine();
    await speakerCore.restore();
    const dom = { painted: null };
    engine.buses.services.register('dom.createElement', () => ({ html: '' }));
    engine.buses.services.register('dom.setInnerHtml', ({ el, html }) => { el.html = html; return true; });
    engine.buses.services.register('dom.textContent', ({ node }) => node.html.replace(/<[^>]+>/g, ''));
    engine.buses.services.register('dom.paintTextRuns', ({ container, runs }) => { dom.painted = runs; container.html = `<painted>${container.html}</painted>`; return true; });
    engine.buses.services.register('dom.getInnerHtml', ({ node }) => node.html);
    const module = moduleCaller(engine, ['speaker.cast.add', 'speaker.paintHtml']);

    // Без цветов у персонажей — HTML возвращается как есть.
    await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Lisawoo', gender: 'F' } }, resolve));
    const html = '<p>Lisawoo nodded. "Fine," she said.</p>';
    const plain = await new Promise(resolve => module.cores.subscribe('speaker.paintHtml', { params: { html, mesid: '1' } }, resolve));
    assert.equal(plain.value, html);
    assert.equal(dom.painted, null);

    // С цветом — реплика красится этим цветом.
    await new Promise(resolve => module.cores.subscribe('speaker.cast.add', { params: { name: 'Mira', gender: 'F', color: '#ff8800' } }, resolve));
    const painted = await new Promise(resolve => module.cores.subscribe('speaker.paintHtml', { params: { html: '<p>Mira frowned. "No," she said.</p>', mesid: '2' } }, resolve));
    assert.equal(painted.ok, true);
    assert.ok(dom.painted?.some(run => run.color === '#ff8800'), 'the dialogue run carries the cast member color');
    assert.match(painted.value, /^<painted>/);
});
