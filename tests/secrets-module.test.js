import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import {
    createSecretsModule, clampSecretSettings, addSecret, updateSecret, removeSecret,
    buildSecretsPrompt, computeInsertIndex, SECRETS_MODULE_ID, DEFAULT_SETTINGS, SECRETS_TOOL_SCHEMA,
} from '../modules/tools/secrets.js';

// --- Чистые функции ---------------------------------------------------------

test('clampSecretSettings() keeps garbage from ever reaching storage as a real value', () => {
    assert.deepEqual(clampSecretSettings({ maxSecrets: -5, cleanupBatch: 'x', injectionDepth: 9999 }),
        { maxSecrets: 1, cleanupBatch: 1, injectionDepth: 100 });
    assert.deepEqual(clampSecretSettings({}), DEFAULT_SETTINGS);
});

test('clampSecretSettings() never lets cleanupBatch exceed the maxSecrets it was just given', () => {
    assert.deepEqual(clampSecretSettings({ maxSecrets: 3, cleanupBatch: 50 }), { maxSecrets: 3, cleanupBatch: 3, injectionDepth: DEFAULT_SETTINGS.injectionDepth });
});

test('addSecret() requires characters, title AND content — a secret without WHO KNOWS is not a usable secret', () => {
    assert.throws(() => addSecret([], { characters: '', title: 'x', content: 'y' }, DEFAULT_SETTINGS), /characters who know/);
    assert.throws(() => addSecret([], { characters: 'Elena', title: '', content: 'y' }, DEFAULT_SETTINGS), /characters who know/);
    assert.throws(() => addSecret([], { characters: 'Elena', title: 'x', content: '  ' }, DEFAULT_SETTINGS), /characters who know/);
});

test('addSecret() normalizes the characters list without splitting it for the model', () => {
    const { secret } = addSecret([], { characters: 'Elena ,  Marcus', title: 'T', content: 'C' }, DEFAULT_SETTINGS);
    assert.equal(secret.characters, 'Elena, Marcus');
});

test('addSecret() assigns a fresh id and timestamp through the injected clock — no hidden Date.now() to fight in a test', () => {
    const { secrets, secret } = addSecret([], { characters: 'Elena', title: 'Plan', content: 'Sneak in at dusk' }, DEFAULT_SETTINGS, { now: () => 1000, random: () => 0.5 });
    assert.equal(secrets.length, 1);
    assert.equal(secret.updated, 1000);
    assert.match(secret.id, /^secret_/);
});

test('addSecret() past capacity removes the OLDEST secrets in one cleanup batch, not one at a time', () => {
    const settings = { maxSecrets: 3, cleanupBatch: 2, injectionDepth: 4 };
    let list = [];
    for (let i = 0; i < 3; i += 1) list = addSecret(list, { characters: 'E', title: `s${i}`, content: 'c' }, settings).secrets;
    const { secrets: next, removed } = addSecret(list, { characters: 'E', title: 's3', content: 'c' }, settings);
    assert.equal(removed, 2);
    assert.deepEqual(next.map(secret => secret.title), ['s2', 's3']);
});

test('updateSecret() keeps fields that were not passed — partial edit, not a blind rewrite', () => {
    const { secret: original } = addSecret([], { characters: 'Elena', title: 'Plan', content: 'Sneak at dusk' }, DEFAULT_SETTINGS);
    const { secrets: next, secret } = updateSecret([original], original.id, { content: 'Sneak at midnight instead' });
    assert.equal(next.length, 1);
    assert.equal(secret.characters, 'Elena');
    assert.equal(secret.title, 'Plan');
    assert.equal(secret.content, 'Sneak at midnight instead');
});

test('updateSecret() rejects an empty field — partial edit must not launder emptiness into storage', () => {
    const { secret: original } = addSecret([], { characters: 'Elena', title: 'Plan', content: 'x' }, DEFAULT_SETTINGS);
    assert.throws(() => updateSecret([original], original.id, { title: '   ' }), /characters who know/);
    assert.throws(() => updateSecret([original], original.id, { characters: '' }), /characters who know/);
});

test('updateSecret() throws on an unknown id — the TOOL layer converts it to text for the model', () => {
    assert.throws(() => updateSecret([], 'nope', {}), /no secret with id/i);
});

test('removeSecret() never throws on an unknown id — a double remove is not an error', () => {
    const { removed } = removeSecret([], 'gone');
    assert.equal(removed, false);
});

test('buildSecretsPrompt() shows who knows, title and content per line; empty list contributes NOTHING', () => {
    assert.equal(buildSecretsPrompt([]), '');
    const { secrets } = addSecret([], { characters: 'Elena, Marcus', title: 'Bastard', content: 'Elena is the baron\'s daughter' }, DEFAULT_SETTINGS);
    const prompt = buildSecretsPrompt(secrets);
    assert.match(prompt, /\[Private secrets/);
    assert.match(prompt, /\(known by: Elena, Marcus\) Bastard: Elena is the baron's daughter/);
    assert.match(prompt, /\[secret_/);
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

test('tool schema requires all three data fields and offers exactly create/update/remove', () => {
    assert.deepEqual(SECRETS_TOOL_SCHEMA.parameters.required, ['action', 'characters', 'title', 'content']);
    assert.deepEqual(SECRETS_TOOL_SCHEMA.parameters.properties.action.enum, ['create', 'update', 'remove']);
    assert.equal(SECRETS_TOOL_SCHEMA.name, 'Secrets');
    assert.match(SECRETS_TOOL_SCHEMA.description, /before.{0,40}(reply|completion)/i, 'TIMING — вызов обязателен ДО реплики');
    for (const key of ['action', 'characters', 'title', 'content', 'secret_id']) {
        const property = SECRETS_TOOL_SCHEMA.parameters.properties[key];
        assert.ok(property.description && property.description.length > 10, `"${key}" needs a real description`);
    }
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

    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), { resolveAs: engine.resolveAs });
    pipelineCore.define({ id: BEFORE_SEND_PIPELINE, mode: 'collect' });

    const moduleHost = engine.registerCaller(SECRETS_MODULE_ID, 'modules', rights ?? {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'storage.chatMemory.get', 'storage.chatMemory.set',
            'generation.registerTool', 'generation.unregisterTool',
            'pipeline.stages.add', 'pipeline.stages.remove',
            'ui.notify',
        ],
    });

    return { engine, tools, pipelineCore, settingsContext, module: createSecretsModule(moduleHost) };
}

const invoke = (tools, args) => tools.get('Secrets').action(args);

test('load() registers exactly ONE real ST tool under the name the user sees in ST\'s own tool list', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    assert.deepEqual([...tools.keys()], ['Secrets']);
});

test('the REGISTERED tool really carries SECRETS_TOOL_SCHEMA, not a copy that drifted from it', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const registered = tools.get('Secrets');
    assert.equal(registered.description, SECRETS_TOOL_SCHEMA.description);
    assert.deepEqual(registered.parameters, SECRETS_TOOL_SCHEMA.parameters);
});

test('the tool\'s create action records a real secret the panel can see too — same store, one source of truth', async () => {
    const { tools, module } = buildEngine();
    await module.load();

    const result = await invoke(tools, { action: 'create', characters: 'Elena', title: 'Bastard', content: 'Elena is the baron\'s daughter.' });

    assert.match(result, /Recorded secret "Bastard"/);
    assert.deepEqual(module.secrets().map(secret => secret.title), ['Bastard']);
    assert.equal(module.secrets()[0].characters, 'Elena');
});

test('the tool\'s update action is reachable by the id the create action just handed back — and keeps unmentioned fields', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const saved = await invoke(tools, { action: 'create', characters: 'Elena', title: 'Plan', content: 'Sneak in at dusk' });
    const id = saved.match(/id: (\S+),/)[1];

    const result = await invoke(tools, { action: 'update', secret_id: id, content: 'Sneak in at midnight instead' });

    assert.match(result, /Updated secret "Plan"/);
    assert.equal(module.secrets()[0].content, 'Sneak in at midnight instead');
    assert.equal(module.secrets()[0].characters, 'Elena', 'characters не названы — остались прежними');
});

test('the tool\'s remove action deletes a secret that is no longer a secret', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const saved = await invoke(tools, { action: 'create', characters: 'Elena', title: 'Plan', content: 'x' });
    const id = saved.match(/id: (\S+),/)[1];

    const result = await invoke(tools, { action: 'remove', secret_id: id });

    assert.match(result, /Secret removed\./);
    assert.deepEqual(module.secrets(), []);
});

test('a tool error comes back as TEXT, not a thrown exception — a wrong secret_id must not be able to break the model\'s turn', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const result = await invoke(tools, { action: 'update', secret_id: 'ghost', title: 'x' });
    assert.match(result, /no secret with id "ghost"/);
});

test('a create missing the characters field fails softly with guidance — the model can correct itself', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const result = await invoke(tools, { action: 'create', characters: '', title: 'x', content: 'y' });
    assert.match(result, /characters who know/);
});

test('an unknown action fails softly with guidance, the same courtesy as a bad secret_id', async () => {
    const { tools, module } = buildEngine();
    await module.load();
    const result = await invoke(tools, { action: 'delete' });
    assert.equal(result, 'Unknown action. Use create, update or remove.');
});

test('the module registers ITS OWN contract for the pipeline stage — no other Ядро has to know Secrets exists', async () => {
    const { module, pipelineCore } = buildEngine();
    await module.load();

    const stages = pipelineCore.stages(BEFORE_SEND_PIPELINE);

    assert.equal(stages.length, 1);
    assert.equal(stages[0].owner, SECRETS_MODULE_ID, 'исполняется под правами МОДУЛЯ, не пайплайна');
    assert.match(stages[0].contract, /^community\.secrets\./, 'community-уровень обязан нести префикс community.<id>.');
});

test('running the real beforeSend pipeline actually inserts the secrets block into chat — the same array the rest of the pipeline sees', async () => {
    const { tools, module, pipelineCore } = buildEngine();
    await module.load();
    module.injectionDepth.set(0);
    await invoke(tools, { action: 'create', characters: 'Elena, Marcus', title: 'Bastard', content: 'Elena is the baron\'s daughter.' });
    const chat = [{ mes: 'hello' }, { mes: 'world' }];

    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });

    assert.equal(result.ok, true);
    assert.equal(chat.length, 3);
    assert.match(chat[2].mes, /\[Private secrets/);
    assert.match(chat[2].mes, /known by: Elena, Marcus/);
    assert.equal(chat[2].is_user, false);
});

test('an empty secrets list contributes nothing to the pipeline — chat is left exactly as it was', async () => {
    const { module, pipelineCore } = buildEngine();
    await module.load();
    const chat = [{ mes: 'hello' }];
    const result = await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });
    assert.equal(result.ok, true);
    assert.equal(chat.length, 1, 'пустой блокнот секретов не добавляет сообщения из воздуха');
});

test('injection depth controls WHERE the secrets block lands, not just whether it does', async () => {
    const { tools, module, pipelineCore } = buildEngine();
    await module.load();
    module.injectionDepth.set(1);
    await invoke(tools, { action: 'create', characters: 'E', title: 's', content: 'c' });
    const chat = [{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }];

    await pipelineCore.run({ pipelineId: BEFORE_SEND_PIPELINE, input: { chat } });

    assert.equal(chat[2].mes.includes('[Private secrets'), true, 'depth 1 = за одно сообщение до конца');
});

test('secrets are CHAT memory — a fresh chat starts with an empty list of its own', async () => {
    const { tools, module, settingsContext } = buildEngine();
    await module.load();
    await invoke(tools, { action: 'create', characters: 'E', title: 's', content: 'c' });
    assert.equal(module.secrets().length, 1);

    // Новый чат — чистый stme_memory.
    settingsContext.chatMetadata = { stme_memory: {} };
    await module.load();
    assert.deepEqual(module.secrets(), []);
});

test('st.chatChanged reloads secrets from chat memory — a Module booted before ST finished loading chatMetadata must not get stuck showing an empty list', async () => {
    const { module, settingsContext } = buildEngine();
    await module.load();
    assert.deepEqual(module.secrets(), []);

    settingsContext.chatMetadata = { stme_memory: { [SECRETS_MODULE_ID]: { secrets: [{ id: 'secret_1', characters: 'E', title: 'Plan', content: 'x', updated: 1 }] } } };
    // Смена чата: чатChanged-событие уходит из сервиса — здесь имитируем прямым вызовом load()
    await module.load();
    assert.deepEqual(module.secrets().map(secret => secret.title), ['Plan'], 'перечитал память чата, не остался на пустой первой загрузке');
});

test('settings are GLOBAL, not chat memory — unlike the notes, configuring capacity once does not need repeating per chat', async () => {
    const { engine, module } = buildEngine();
    await module.load();
    module.maxSecrets.set(40);

    await module.save();

    const probe = engine.registerCaller('probe', 'cores', { tier: 'official' });
    const stored = await new Promise(resolve => probe.own.subscribe('storage.settings.get', { params: { namespace: SECRETS_MODULE_ID, key: 'settings', fallback: null } }, resolve));

    assert.equal(stored.value.maxSecrets, 40);
});
