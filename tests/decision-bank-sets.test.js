import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankSets } from '../cores/decision/bank-sets.js';

function world({ books = ['ReZero World'], cycles = [], records = [], answer = null } = {}) {
    const settings = new Map();
    const applied = [];
    const asked = [];
    const call = async (contract, params = {}) => {
        if (contract === 'lorebook.entries') return books.map((book, uid) => ({ book, uid }));
        if (contract === 'storage.settings.get') return settings.has(params.key) ? settings.get(params.key) : params.fallback;
        if (contract === 'storage.settings.set') { settings.set(params.key, JSON.parse(JSON.stringify(params.value))); return true; }
        return undefined;
    };
    const sets = createBankSets({
        call,
        banks: { records: () => records, applySet: async set => { applied.push(set.id); return Object.keys(set.banks).length; } },
        store: { cycles: () => cycles, chatBrief: () => ({ text: 'TIMELINE\nArc 1, day one: Subaru has just arrived.' }) },
        bootstrap: { state: () => ({ status: 'done', startedAt: 1000 }) },
        askUser: async question => { asked.push(question); return answer?.(question) ?? { skipped: true }; },
        publishEvent: () => {},
    });
    return { sets, settings, applied, asked };
}

const ready = name => ({ sourceKey: `lorebook:ReZero World:${name}`, name, sourceKind: 'lorebook entry', status: 'ready', text: `***${name}***`, sourceHash: 'h' });

test('the bootstrap banks are saved per lorebook, only before the first turn', async () => {
    const first = world({ records: [ready('Emilia'), { ...ready('Elsa'), status: 'error' }] });
    assert.equal(await first.sets.snapshot(), true);
    const saved = first.settings.get('bankSets')['books:ReZero World'];
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0].banks), ['lorebook:ReZero World:Emilia'], 'only ready banks');
    assert.match(saved[0].timeline, /Arc 1/);

    const later = world({ records: [ready('Emilia')], cycles: [{ event: 'turn' }] });
    assert.equal(await later.sets.snapshot(), false, 'after the first turn the start version is frozen');
});

test('a new chat with the same books is asked, and the chosen set is applied; "Build new banks" applies nothing', async () => {
    const source = world({ records: [ready('Emilia'), ready('Puck')] });
    await source.sets.snapshot();
    const saved = source.settings.get('bankSets');

    const reuse = world({ answer: question => ({ answer: question.options[0], skipped: false }) });
    reuse.settings.set('bankSets', saved);
    assert.equal(await reuse.sets.offer(), 2);
    assert.equal(reuse.asked.length, 1);
    assert.match(reuse.asked[0].options[0], /2 banks from .* Arc 1, day one/);
    assert.deepEqual(reuse.applied, ['chat_1000']);

    const fresh = world({ answer: () => ({ answer: 'Build new banks', skipped: false }) });
    fresh.settings.set('bankSets', saved);
    assert.equal(await fresh.sets.offer(), 0);
    assert.deepEqual(fresh.applied, []);

    const otherBook = world({ books: ['Another World'], answer: question => ({ answer: question.options[0] }) });
    otherBook.settings.set('bankSets', saved);
    assert.equal(await otherBook.sets.offer(), 0);
    assert.equal(otherBook.asked.length, 0, 'a different lorebook is not offered the set');
});
