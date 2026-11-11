import test from 'node:test';
import assert from 'node:assert/strict';
import { usageNumbers, priceCost, buildCallRecord, appendRing, filterCalls, summarize, rollupDays, toCsv, priceTable } from '../libraries/core/telemetry.js';
import { registerTelemetryStoreService } from '../services/telemetry-store.js';

test('usage of different providers becomes the same numbers; a provider cost wins over the table', () => {
    assert.deepEqual(usageNumbers({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 50 }, cost: 0.0012 }), { prompt: 1000, completion: 200, cached: 600, reasoning: 50, cost: 0.0012 });
    assert.deepEqual(usageNumbers({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 }), { prompt: 10, completion: 5, cached: 4, reasoning: 0, cost: null });
    const provider = buildCallRecord({ usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.5 }, price: { prompt: 1, completion: 1 }, model: 'm', endpoint: 'https://openrouter.ai/api/v1/chat/completions' });
    assert.equal(provider.cost, 0.5);
    assert.equal(provider.costSource, 'provider');
    assert.equal(provider.host, 'openrouter.ai');
});

test('without a provider cost the table prices the call, cached tokens at their own price; no price stays unknown', () => {
    assert.equal(priceCost({ prompt: 1000, completion: 100, cached: 400 }, { prompt: 0.000001, completion: 0.000002, cacheRead: 0.0000001 }), 600 * 0.000001 + 400 * 0.0000001 + 100 * 0.000002);
    const table = buildCallRecord({ usage: { prompt_tokens: 100, completion_tokens: 10 }, price: { prompt: 0.01, completion: 0.02 } });
    assert.equal(table.costSource, 'table');
    const unknown = buildCallRecord({ usage: { prompt_tokens: 100 } });
    assert.equal(unknown.cost, null);
    assert.equal(unknown.costSource, 'unknown');
    assert.deepEqual(priceTable({ data: [{ id: 'a/b', pricing: { prompt: '0.000001', completion: '0.000002' } }] }), { 'a/b': { prompt: 0.000001, completion: 0.000002, cacheRead: '' } });
});

test('the ring keeps the newest, filters narrow the feed, summaries group, days survive, CSV exports', () => {
    const rows = [1, 2, 3].map(index => buildCallRecord({ at: Date.UTC(2026, 10, 10 + (index > 2 ? 1 : 0)), purpose: index === 1 ? 'resolver' : 'writer', model: 'm', usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 }, durationMs: index * 1000, status: index === 3 ? 'error' : 'ok', chatId: 'c', turn: index }));
    assert.equal(appendRing(rows, [], 2).length, 2);
    assert.equal(filterCalls(rows, { purpose: 'writer' }).length, 2);
    assert.equal(filterCalls(rows, { chatId: 'c', turn: 1 }).length, 1);
    const byRole = summarize(rows, 'purpose');
    const writer = byRole.find(row => row.key === 'writer');
    assert.equal(writer.calls, 2);
    assert.equal(writer.errors, 1);
    assert.equal(Math.round(writer.cost * 100), 2);
    const days = rollupDays({}, rows);
    assert.equal(days['2026-11-10'].calls, 2);
    assert.equal(rollupDays(days, rows.slice(0, 1))['2026-11-10'].calls, 3);
    assert.match(toCsv(rows).split('\n')[0], /^at,kind,caller,purpose/);
});

test('the store keeps a ring and day rollups without IndexedDB', async () => {
    const handlers = new Map();
    const bus = { register: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); } };
    registerTelemetryStoreService(bus, { indexedDB: null, limit: 2 });
    const record = at => buildCallRecord({ at, purpose: 'resolver', usage: { prompt_tokens: 1 } });
    await handlers.get('telemetry.append')({ records: [record(1), record(2), record(3)] });
    assert.equal((await handlers.get('telemetry.list')()).length, 2);
    assert.equal(Object.values(await handlers.get('telemetry.days')())[0].calls, 3);
});
