import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolList } from '../libraries/core/decision-tools.js';
import { createHandlers } from '../cores/decision/handlers.js';

function makeBanks() {
    const calls = [];
    return {
        calls,
        edit: async (params, options) => {
            calls.push({ params, options });
            return {
                ok: true, at: '2026-03-07 04:15',
                changes: [
                    { kind: 'section', character: 'Aria', part: 'material', section: 4, pending: false, old: '', new: 'A key.' },
                    { kind: 'section', character: 'Aria', part: 'spiritual', section: 1, pending: options?.by === 'resolver', old: '', new: 'Hates being owned.' },
                    { kind: 'knowledge', character: 'Aria', old: '', new: 'The gate is open.' },
                ],
                created: [],
            };
        },
        great: { setImportance: async args => ({ ok: true, character: args.character, importance: args.importance }) },
        persona: () => ({ name: 'Sasha' }),
        records: () => [],
    };
}

function makeKnowledge() {
    const added = [];
    return {
        added,
        handlers: {
            character_knowledge: async args => { added.push(args); return { ok: true, id: 'k1' }; },
        },
    };
}

function build(overrides = {}) {
    const state = { assessments: new Map(), assessmentCounter: 0, turnCounter: 1, runId: 'r1', role: 'director', ...(overrides.state ?? {}) };
    const banks = overrides.banks ?? makeBanks();
    const knowledge = overrides.knowledge ?? makeKnowledge();
    const handlers = createHandlers({
        store: { library: () => ({}), plan: () => ({ direction: 'd' }), roster: () => ({ active: [] }), clock: () => ({ minutes: 0 }) },
        call: async () => null, publishEvent: () => {}, getSettings: () => ({}),
        state, resolvePlace: async () => '', lastTimeMark: async () => '', banks, knowledge,
    });
    return { handlers, state, banks, knowledge };
}

test('bank_edit and set_bank_importance are tools the director is given', () => {
    const names = buildToolList().map(tool => tool.name);
    assert.ok(names.includes('bank_edit'));
    assert.ok(names.includes('set_bank_importance'));
});

test('bank_edit runs the engine for the whole call: several characters, section edits and knowledge', async () => {
    const { handlers, banks, knowledge } = build();
    const result = await handlers.bank_edit({
        comment: 'The turn changed these.',
        edits: [
            { character: 'Aria', section: 'carried', old: '', new: 'A key.' },
            { character: 'Rem', section: 'values', old: '', new: 'Her sister.' },
            { character: 'Aria', section: 'knowledge', old: '', new: 'The gate is open.' },
        ],
    });
    assert.equal(banks.calls.length, 1, 'one call, not one per edit');
    assert.equal(banks.calls[0].params.edits.length, 3);
    assert.equal(result.ok, true);
    assert.equal(result.at, '2026-03-07 04:15');
    assert.equal(result.changes.length, 2, 'section edits come back as the changed lines');
    assert.deepEqual(knowledge.added.map(item => [item.character, item.fact]), [['Aria', 'The gate is open.']], 'Knowledge goes through the existing system');
    assert.equal(result.knowledge[0].ok, true);
});

test('the resolver edit is marked as a proposal; the director edit is not', async () => {
    const resolver = build({ state: { role: 'resolver' } });
    const fromResolver = await resolver.handlers.bank_edit({ comment: 'What the turn showed.', edits: [{ character: 'Aria', section: 'values', old: '', new: 'Hates being owned.' }] });
    assert.match(fromResolver.pending, /kept as a proposal for the Director/);
    assert.equal(resolver.banks.calls[0].options.by, 'resolver');
    const director = build();
    const fromDirector = await director.handlers.bank_edit({ comment: 'What the turn showed.', edits: [{ character: 'Aria', section: 'values', old: '', new: 'Hates being owned.' }] });
    assert.equal(fromDirector.pending, undefined);
    assert.equal(director.banks.calls[0].options.by, 'director');
});

test('set_bank_importance goes to the engine', async () => {
    const { handlers } = build();
    const result = await handlers.set_bank_importance({ character: 'Aria', importance: 'main', comment: 'She matters most.' });
    assert.deepEqual(result, { ok: true, character: 'Aria', importance: 'main' });
});
