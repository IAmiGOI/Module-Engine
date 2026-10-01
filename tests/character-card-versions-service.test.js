import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerCharacterCardVersionsService, MAX_VERSIONS_PER_CARD } from '../services/character-card-versions.js';

function memoryStore() {
    const records = new Map();
    return { all: async () => [...records.values()], get: async key => records.get(String(key)), put: async record => { records.set(record.key, record); }, delete: async key => { records.delete(String(key)); } };
}

function build() {
    const bus = createContractBus();
    registerCharacterCardVersionsService(bus, { store: memoryStore() });
    return (contract, params) => request(bus, contract, { params });
}

test('a version is stored under the avatar and the moment, listed newest first without its heavy card body, and read back whole by its key', async () => {
    const call = build();
    await call('characterCardVersions.put', { record: { avatar: 'Aria.png', at: 100, label: 'first', card: { name: 'Aria', description: 'one' } } });
    await call('characterCardVersions.put', { record: { avatar: 'Aria.png', at: 200, label: 'second', card: { name: 'Aria', description: 'two' } } });
    await call('characterCardVersions.put', { record: { avatar: 'Bram.png', at: 150, label: 'other', card: { name: 'Bram' } } });
    const listed = (await call('characterCardVersions.list', { avatar: 'Aria.png' })).value;
    assert.deepEqual(listed.map(item => [item.key, item.label]), [['Aria.png:200', 'second'], ['Aria.png:100', 'first']]);
    assert.ok(listed.every(item => !('card' in item)));
    assert.equal((await call('characterCardVersions.get', { key: 'Aria.png:100' })).value.card.description, 'one');
    assert.equal((await call('characterCardVersions.get', { key: 'nope' })).value, null);
});

test('only the newest versions of one card are kept, and other cards are never pruned for it', async () => {
    const call = build();
    for (let at = 1; at <= MAX_VERSIONS_PER_CARD + 5; at += 1) await call('characterCardVersions.put', { record: { avatar: 'Aria.png', at, label: `v${at}`, card: { name: 'Aria' } } });
    await call('characterCardVersions.put', { record: { avatar: 'Bram.png', at: 1, label: 'b', card: { name: 'Bram' } } });
    const listed = (await call('characterCardVersions.list', { avatar: 'Aria.png' })).value;
    assert.equal(listed.length, MAX_VERSIONS_PER_CARD);
    assert.equal(listed[0].at, MAX_VERSIONS_PER_CARD + 5);
    assert.equal(listed.at(-1).at, 6, 'the five oldest are gone');
    assert.equal((await call('characterCardVersions.list', { avatar: 'Bram.png' })).value.length, 1);
});

test('a version without an avatar, a moment or a card is refused, and a version can be deleted', async () => {
    const call = build();
    assert.equal((await call('characterCardVersions.put', { record: { avatar: 'Aria.png', at: 1 } })).ok, false);
    await call('characterCardVersions.put', { record: { avatar: 'Aria.png', at: 1, label: 'x', card: {} } });
    assert.equal((await call('characterCardVersions.delete', { key: 'Aria.png:1' })).ok, true);
    assert.equal((await call('characterCardVersions.list', { avatar: 'Aria.png' })).value.length, 0);
});
