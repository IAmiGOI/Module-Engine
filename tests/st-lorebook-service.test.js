import test from 'node:test';
import assert from 'node:assert/strict';
import { registerStLorebookService } from '../services/st-lorebook.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';

function fakeContext(overrides = {}) {
    return {
        chatMetadata: {},
        powerUserSettings: {},
        characters: [],
        groups: [],
        loadWorldInfo: async () => null,
        saveWorldInfo: async () => {},
        ...overrides,
    };
}

test('stLorebook.rawState pulls chatBook/personaBook/characterId/characters/groupId/groups straight off getContext()', async () => {
    const context = fakeContext({
        chatMetadata: { world_info: 'Chat Book' },
        powerUserSettings: { persona_description_lorebook: 'Persona Book' },
        characterId: 2,
        characters: [{ avatar: 'a.png' }],
        groupId: 'g1',
        groups: [{ id: 'g1' }],
    });
    const bus = createContractBus();
    registerStLorebookService(bus, { getContext: () => context, loadWorldInfoModule: async () => { throw new Error('no real ST module here'); } });

    const result = await new Promise(resolve => bus.subscribe('stLorebook.rawState', {}, resolve));

    assert.equal(result.ok, true);
    assert.equal(result.value.chatBook, 'Chat Book');
    assert.equal(result.value.personaBook, 'Persona Book');
    assert.equal(result.value.characterId, 2);
    assert.deepEqual(result.value.characters, [{ avatar: 'a.png' }]);
    assert.equal(result.value.groupId, 'g1');
    assert.deepEqual(result.value.groups, [{ id: 'g1' }]);
});

test('stLorebook.rawState degrades to empty selectedWorldInfo/charLore when the dynamic import fails — one lookup fails, not the whole Сервис', async () => {
    const context = fakeContext();
    const bus = createContractBus();
    registerStLorebookService(bus, { getContext: () => context, loadWorldInfoModule: async () => { throw new Error('wrong ST layout'); } });

    const result = await new Promise(resolve => bus.subscribe('stLorebook.rawState', {}, resolve));

    assert.equal(result.ok, true);
    assert.deepEqual(result.value.selectedWorldInfo, []);
    assert.deepEqual(result.value.charLore, []);
});

test('stLorebook.rawState reads selectedWorldInfo/charLore from the (faked) dynamically-imported world-info.js module', async () => {
    const context = fakeContext();
    const bus = createContractBus();
    registerStLorebookService(bus, {
        getContext: () => context,
        loadWorldInfoModule: async () => ({ selected_world_info: ['Global'], world_info: { charLore: [{ name: 'hero', extraBooks: ['Extra'] }] } }),
    });

    const result = await new Promise(resolve => bus.subscribe('stLorebook.rawState', {}, resolve));

    assert.deepEqual(result.value.selectedWorldInfo, ['Global']);
    assert.deepEqual(result.value.charLore, [{ name: 'hero', extraBooks: ['Extra'] }]);
});

test('stLorebook.load calls the real context.loadWorldInfo(name)', async () => {
    const calls = [];
    const context = fakeContext({ loadWorldInfo: async name => { calls.push(name); return { entries: {} }; } });
    const bus = createContractBus();
    registerStLorebookService(bus, { getContext: () => context });

    const result = await new Promise(resolve => bus.subscribe('stLorebook.load', { params: { name: 'MyBook' } }, resolve));

    assert.deepEqual(result, { ok: true, value: { entries: {} } });
    assert.deepEqual(calls, ['MyBook']);
});

test('stLorebook.save calls the real context.saveWorldInfo(name, data, immediately) — with immediately, not left to the default debounce', async () => {
    const calls = [];
    const context = fakeContext({ saveWorldInfo: async (name, data, immediately) => { calls.push({ name, data, immediately }); } });
    const bus = createContractBus();
    registerStLorebookService(bus, { getContext: () => context });

    await new Promise(resolve => bus.subscribe('stLorebook.save', { params: { name: 'MyBook', data: { entries: {} }, immediately: true } }, resolve));

    assert.deepEqual(calls, [{ name: 'MyBook', data: { entries: {} }, immediately: true }]);
});
