import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDeliveryFilters } from '../libraries/shared/delivery-filters.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('with no options at all, every call is delivered straight through', () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload));

    deliver('a'); deliver('b');

    assert.deepEqual(seen, ['a', 'b']);
});

test('every: N delivers only every Nth call', () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload), { every: 3 });

    for (const payload of ['a', 'b', 'c', 'd', 'e', 'f']) deliver(payload);

    assert.deepEqual(seen, ['c', 'f']);
});

test('dedupe skips a payload identical to the previous one, but not a later repeat after something else', () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload), { dedupe: true });

    deliver({ id: 1 }); deliver({ id: 1 }); deliver({ id: 2 }); deliver({ id: 1 });

    assert.deepEqual(seen, [{ id: 1 }, { id: 2 }, { id: 1 }]);
});

test('dedupe survives a payload that cannot be JSON-stringified, rather than throwing', () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload), { dedupe: true });
    const circular = {};
    circular.self = circular;

    assert.doesNotThrow(() => deliver(circular));
    assert.equal(seen.length, 1);
});

test('throttleMs delivers the first call immediately and drops the ones inside the window', async () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload), { throttleMs: 40 });

    deliver('a'); deliver('b'); deliver('c');
    assert.deepEqual(seen, ['a'], 'only the first one gets through the window');

    await wait(60);
    deliver('d');
    assert.deepEqual(seen, ['a', 'd']);
});

test('debounceMs collapses a burst into ONE delivery, carrying the last payload', async () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload), { debounceMs: 30 });

    deliver('a'); deliver('b'); deliver('c');
    assert.deepEqual(seen, [], 'nothing is delivered while the burst is still going');

    await wait(60);
    assert.deepEqual(seen, ['c']);
});

test('cancel() drops a pending debounced delivery — an unsubscribed handler must never fire afterwards', async () => {
    const seen = [];
    const { deliver, cancel } = applyDeliveryFilters(payload => seen.push(payload), { debounceMs: 30 });

    deliver('a');
    cancel();
    await wait(60);

    assert.deepEqual(seen, []);
});

test('dedupe runs BEFORE every: a suppressed duplicate must not consume the Nth-call counter', () => {
    const seen = [];
    const { deliver } = applyDeliveryFilters(payload => seen.push(payload), { dedupe: true, every: 2 });

    deliver('a'); deliver('a'); deliver('b');

    assert.deepEqual(seen, ['b'], '"a","a","b" is two REAL calls, so the 2nd real one delivers');
});
