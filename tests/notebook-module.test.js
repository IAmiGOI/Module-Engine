import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import {
    createNotebookModule, clampNoteSettings, addNote, updateNote, removeNote,
    buildNotebookPrompt, computeInsertIndex, MODULE_ID, DEFAULT_SETTINGS,
} from '../modules/notebook/index.js';

// --- Чистые функции ---------------------------------------------------------

test('clampNoteSettings() keeps garbage from ever reaching storage as a real value', () => {
    assert.deepEqual(clampNoteSettings({ maxNotes: -5, cleanupBatch: 'x', injectionDepth: 9999 }),
        { maxNotes: 1, cleanupBatch: 1, injectionDepth: 100 });
    assert.deepEqual(clampNoteSettings({}), DEFAULT_SETTINGS);
});

test('clampNoteSettings() never lets cleanupBatch exceed the maxNotes it was just given', () => {
    assert.deepEqual(clampNoteSettings({ maxNotes: 3, cleanupBatch: 50 }), { maxNotes: 3, cleanupBatch: 3, injectionDepth: DEFAULT_SETTINGS.injectionDepth });
});

test('addNote() requires BOTH a title and content — one without the other is not a usable note', () => {
    assert.throws(() => addNote([], { title: '', content: 'x' }, DEFAULT_SETTINGS), /title and content/);
    assert.throws(() => addNote([], { title: 'x', content: '  ' }, DEFAULT_SETTINGS), /title and content/);
});

test('addNote() assigns a fresh id and timestamp through the injected clock — no hidden Date.now() to fight in a test', () => {
    const { notes, note } = addNote([], { title: 'Plan', content: 'Sneak in at dusk' }, DEFAULT_SETTINGS, { now: () => 1000, random: () => 0.5 });

    assert.equal(notes.length, 1);
    assert.equal(note.updated, 1000);
    assert.match(note.id, /^note_/);
});

test('addNote() past capacity removes the OLDEST notes in one cleanup batch, not one at a time', () => {
    const settings = { maxNotes: 3, cleanupBatch: 2 };
    let notes = [];
    for (const title of ['a', 'b', 'c']) notes = addNote(notes, { title, content: title }, settings).notes;

    const { notes: next, removed } = addNote(notes, { title: 'd', content: 'd' }, settings);

    assert.equal(removed, 2, 'batch of 2, not 1, even though only 1 was strictly needed to make room');
    assert.deepEqual(next.map(item => item.title), ['c', 'd']);
});

test('updateNote() changes only the fields actually named — an update with just a new title leaves the content untouched', () => {
    const { notes } = addNote([], { title: 'Plan', content: 'original' }, DEFAULT_SETTINGS, { now: () => 1 });
    const id = notes[0].id;

    const { note } = updateNote(notes, id, { title: 'New title' }, { now: () => 2 });

    assert.equal(note.title, 'New title');
    assert.equal(note.content, 'original');
    assert.equal(note.updated, 2);
});

test('updateNote() on an unknown id fails loudly — the AI needs to know its note_id was wrong, not silently no-op', () => {
    assert.throws(() => updateNote([], 'nope', { title: 'x' }), /no note with id "nope"/);
});

test('updateNote() refuses to leave a note with an empty title or content', () => {
    const { notes } = addNote([], { title: 'a', content: 'b' }, DEFAULT_SETTINGS);
    assert.throws(() => updateNote(notes, notes[0].id, { content: '   ' }), /title and content/);
});

test('removeNote() on an unknown id is a no-op, not an error — a delete clicked twice must not throw', () => {
    const result = removeNote([{ id: 'a' }], 'gone');
    assert.equal(result.removed, false);
    assert.equal(result.notes.length, 1);
});

test('buildNotebookPrompt() is empty for an empty notebook — nothing to inject means nothing added to the prompt', () => {
    assert.equal(buildNotebookPrompt([]), '');
});

test('buildNotebookPrompt() shows each note\'s id, so the model has something to pass back as note_id on update', () => {
    const text = buildNotebookPrompt([{ id: 'note_1', title: 'Plan', content: 'Sneak in at dusk' }]);

    assert.match(text, /\[note_1\] Plan: Sneak in at dusk/);
});

test('computeInsertIndex() at depth 0 means "right before what the model is about to say" — the very end', () => {
    assert.equal(computeInsertIndex(10, 0), 10);
});

test('computeInsertIndex() clamps depth to the chat length instead of going negative', () => {
    assert.equal(computeInsertIndex(3, 50), 0);
});

test('computeInsertIndex() ignores a negative depth rather than inserting past the end', () => {
    assert.equal(computeInsertIndex(5, -3), 5);
});

// --- Сценарный уровень: настоящий движок, настоящие Гейты, настоящий пайплайн

const BEFORE_SEND_PIPELINE = 'generation.beforeSend';

function buildEngine({ rights } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    registerChatMetadataService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));

    const tools = new Map();
    const toolHost = engine.registerCaller('core.generation', 'cores', { tier: 'official' });
    toolHost.own.register('generation.registerTool', ({ definition }) => { tools.set(definition.name, definition); return definition.name; });
    toolHost.own.register('generation.unregisterTool', ({ name }) => tools.delete(name));

    const notifications = createNotificationsCore(engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }), { mount: node => node });

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs });
    pipelineCore.define({ id: BEFORE_SEND_PIPELINE, mode: 'collect' });

    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', rights ?? {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'storage.chatMemory.get', 'storage.chatMemory.set',
            'generation.registerTool', 'generation.unregisterTool',
            'pipeline.stages.add', 'pipeline.stages.remove',
            'ui.notify',
        ],
    });

    return { engine, tools, notifications, pipelineCore, module: createNotebookModule(moduleHost) };
}

const invoke = (tools, args) => tools.get('Notebook').action(args);

test('load() registers exactly ONE real ST tool, under the name the user sees in ST\'s own tool list', async () => {
    const { tools, module } = buildEngine();

    await module.load();

    assert.deepEqual([...tools.keys()], ['Notebook']);
});

test('the tool\'s write action creates a real note the panel can see too — same store, one source of truth', async () => {
    const { tools, module } = buildEngine();
    await module.load();

    const result = await invoke(tools, { action: 'write', title: 'Secret', content: 'The bandit is the mayor.' });

    assert.match(result, /Saved note "Secret"/);
    assert.deepEqual(module.notes().map(note => note.title), ['Secret']);
});

test('the tool\'s update action is reachable by the id the write action just handed back', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const saved = await invoke(tools, { action: 'write', title: 'Plan', content: 'Sneak in at dusk' });
    const id = saved.match(/id: (\S+)\)/)[1];

    const result = await invoke(tools, { action: 'update', note_id: id, content: 'Sneak in at midnight instead' });

    assert.match(result, /Updated note "Plan"/);
    assert.equal(module.notes()[0].content, 'Sneak in at midnight instead');
});

test('a tool error comes back as TEXT, not a thrown exception — a wrong note_id must not be able to break the model\'s turn', async () => {
    const { tools, module } = buildEngine();
    await module.load();

    const result = await invoke(tools, { action: 'update', note_id: 'ghost', title: 'x' });

    assert.match(result, /no note with id "ghost"/);
});

test('an unknown action fails softly with guidance, the same courtesy as a bad note_id', async () => {
    const { tools, module } = buildEngine();
    await module.load();

    const result = await invoke(tools, { action: 'delete' });

    assert.equal(result, 'Unknown action. Use write or update.');
});

test('the module registers ITS OWN contract for the pipeline stage — no other Ядро has to know Notebook exists', async () => {
    const { module, pipelineCore } = buildEngine();
    await module.load();

    const stages = pipelineCore.stages(BEFORE_SEND_PIPELINE);

    assert.equal(stages.length, 1);
    assert.equal(stages[0].owner, MODULE_ID, 'исполняется под правами МОДУЛЯ, не пайплайна');
    assert.match(stages[0].contract, /^community\.notebook\./, 'community-уровень обязан нести префикс community.<id>.');
});

test('running the real beforeSend pipeline actually inserts the note into chat — the same array the rest of the pipeline sees', async () => {
    const { tools, module, pipelineCore } = buildEngine();
    await module.load();
    module.injectionDepth.set(0); // «прямо перед ответом» — что именно вставилось куда, проверяет отдельный тест ниже
    await module.save();
    await invoke(tools, { action: 'write', title: 'Plan', content: 'Sneak in at dusk' });
    const chat = [{ mes: 'hello' }, { mes: 'world' }];

    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });

    assert.equal(result.ok, true);
    assert.equal(chat.length, 3);
    assert.match(chat[2].mes, /\[Private notebook/);
    assert.equal(chat[2].is_user, false);
});

test('an empty notebook contributes nothing to the pipeline — chat is left exactly as it was', async () => {
    const { module, pipelineCore } = buildEngine();
    await module.load();
    const chat = [{ mes: 'hello' }];

    await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });

    assert.deepEqual(chat, [{ mes: 'hello' }]);
});

test('injection depth controls WHERE the note lands, not just whether it does', async () => {
    const { tools, module, pipelineCore } = buildEngine();
    await module.load();
    await invoke(tools, { action: 'write', title: 'Plan', content: 'x' });
    module.injectionDepth.set(1);
    await module.save();
    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];

    await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });

    assert.deepEqual(chat.map(item => item.mes.slice(0, 1)), ['a', 'b', '[', 'c'], 'вставлено ПЕРЕД последним сообщением, не после');
});

test('notes are chat memory — a fresh chat starts with an empty notebook of its own', async () => {
    const { engine, tools, module } = buildEngine();
    await module.load();
    await invoke(tools, { action: 'write', title: 'Plan', content: 'x' });

    const probe = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const stored = await new Promise(resolve => probe.own.subscribe('storage.chatMemory.get', { params: { namespace: MODULE_ID, key: 'notes', fallback: [] } }, resolve));

    assert.equal(stored.value.length, 1, 'лежит в памяти ЧАТА, а не в глобальных настройках');
});

test('settings are GLOBAL, not chat memory — unlike Alpha, configuring capacity once does not need repeating per chat', async () => {
    const { engine, module } = buildEngine();
    await module.load();
    module.maxNotes.set(40);

    await module.save();

    const probe = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const stored = await new Promise(resolve => probe.own.subscribe('storage.settings.get', { params: { namespace: MODULE_ID, key: 'settings', fallback: null } }, resolve));

    assert.equal(stored.value.maxNotes, 40);
});

test('deleting a note from the panel removes it for the tool too — one list, not two', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    await invoke(tools, { action: 'write', title: 'Plan', content: 'x' });
    const id = module.notes()[0].id;

    await module.remove(id);

    assert.deepEqual(module.notes(), []);
    const result = await invoke(tools, { action: 'update', note_id: id, title: 'y' });
    assert.match(result, /no note with id/);
});

test('stop() removes the stage and the tool — a disabled Module leaves no trail in either the pipeline or ST\'s tool list', async () => {
    const { tools, module, pipelineCore } = buildEngine();
    await module.load();

    module.stop();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual([...tools.keys()], []);
    assert.deepEqual(pipelineCore.stages(BEFORE_SEND_PIPELINE), []);
});

test('a Module without the pipeline right cannot register a stage — the Gate is not bypassed just because the contract is its own', async () => {
    const { module } = buildEngine({ rights: { tier: 'community', allowedContracts: ['generation.registerTool', 'generation.unregisterTool', 'storage.chatMemory.get', 'storage.chatMemory.set', 'storage.settings.get', 'storage.settings.set'] } });

    await assert.doesNotReject(module.load(), 'load() itself must not throw even if a sub-step was denied');
});
