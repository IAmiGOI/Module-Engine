import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeBuses } from '../libraries/shared/fake-buses.js';
import { registerSyncStateService } from '../services/sync-state.js';
import { request } from '../libraries/shared/request.js';

/** Крошечный IndexedDB: только то, чем пользуется сервис (open / transaction / objectStore.get|put|delete). */
function createFakeIndexedDb() {
    const stores = new Map();
    let opened = 0;
    let closed = 0;
    const later = fn => setTimeout(fn, 0);
    return {
        stats: () => ({ opened, closed }),
        open() {
            const req = {};
            later(() => {
                opened += 1;
                const db = {
                    objectStoreNames: { contains: name => stores.has(name) },
                    createObjectStore: name => { stores.set(name, new Map()); },
                    close: () => { closed += 1; },
                    transaction: name => {
                        const tx = {};
                        const map = stores.get(name);
                        const run = (fn) => { const r = { result: undefined }; later(() => { r.result = fn(); later(() => tx.oncomplete?.()); }); return r; };
                        tx.objectStore = () => ({ get: key => run(() => map.get(key)), put: (value, key) => run(() => { map.set(key, value); }), delete: key => run(() => { map.delete(key); }) });
                        return tx;
                    },
                };
                req.result = db;
                if (!stores.has('kv')) req.onupgradeneeded?.();
                req.onsuccess?.();
            });
            return req;
        },
    };
}

function setup() {
    const buses = createFakeBuses();
    const indexedDB = createFakeIndexedDb();
    registerSyncStateService(buses.services, { indexedDB });
    const call = (contract, params) => request(buses.services, contract, { params }).then(result => { if (!result.ok) throw new Error(result.error.message); return result.value; });
    return { call, indexedDB };
}

test('a value written under a key comes back, an unknown key is null', async () => {
    const { call } = setup();
    assert.equal(await call('syncState.get', { key: 'base:pc' }), null);
    await call('syncState.set', { key: 'base:pc', value: { 'a.png': 'h1' } });
    assert.deepEqual(await call('syncState.get', { key: 'base:pc' }), { 'a.png': 'h1' });
});

test('removing a key forgets it, and other keys are untouched', async () => {
    const { call } = setup();
    await call('syncState.set', { key: 'one', value: 1 });
    await call('syncState.set', { key: 'two', value: 2 });
    await call('syncState.remove', { key: 'one' });
    assert.equal(await call('syncState.get', { key: 'one' }), null);
    assert.equal(await call('syncState.get', { key: 'two' }), 2);
});

test('every operation closes the database connection it opened', async () => {
    const { call, indexedDB } = setup();
    await call('syncState.set', { key: 'k', value: 'v' });
    await call('syncState.get', { key: 'k' });
    const { opened, closed } = indexedDB.stats();
    assert.equal(opened, 2);
    assert.equal(closed, 2);
});
