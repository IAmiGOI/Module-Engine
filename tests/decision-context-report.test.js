import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextReport, RESOLVER_CONTEXT_LIMIT } from '../cores/decision/context-report.js';

test('every turn the resolver context is measured by sections; the chat keeps labels and tokens, not the text', async () => {
    const memory = new Map();
    const events = [];
    const call = async (contract, params) => {
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return true; }
        if (contract === 'storage.chatMemory.get') return memory.get(params.key) ?? params.fallback;
        return null;
    };
    const report = createContextReport({ call, publishEvent: (name, payload) => events.push([name, payload]) });
    const recorded = report.record({ sections: [{ id: 'system', label: 'Resolver instructions', text: 'x'.repeat(400) }, { id: 'history', label: 'Recent history', text: 'y'.repeat(4000) }] }, { turn: 3 });
    assert.equal(recorded.limit, RESOLVER_CONTEXT_LIMIT);
    assert.ok(recorded.total > 0);
    assert.equal(events[0][0], 'decision.context.report');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(memory.get('contextReport').sections[1].text, undefined, 'the text stays out of the chat file');
    assert.equal((await report.get()).sections[1].text.length, 4000, 'the page keeps the text to show it');
    report.reset();
    assert.equal((await report.get()).sections.length, 2, 'after a reload the stored labels and tokens remain');
});
