import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerRows, appendLedger, renderLedger, isClosedTelegram, normalizeLedger } from '../libraries/core/decision-ledger.js';
import { createAfterTurnHandler } from '../cores/decision/handlers-after-turn.js';

const form = {
    characters: [
        { name: 'Lena', decreeWants: 'get out before dawn', does: 'opens the east door', conflict: { level: 'minor', why: 'she owes the guard' } },
        { name: 'Marek', idle: true, busy: 'watching the street' },
        { name: 'Ram', decreeWants: 'stay', does: 'blocks the way', conflict: { level: 'strong', why: 'her sister asked her to' } },
    ],
    beats: [],
    stop: 'They are at the door.',
};

test('the ledger is one row per acting character: what they wanted, the conflict, and the outcome from the page', () => {
    const rows = buildLedgerRows({ turn: 7, at: 100, form, outcome: [{ character: 'Lena', result: 'She gets the door open.' }, { character: 'Ram', result: 'She steps aside.' }], writerText: 'Lena forced the door; Ram let her pass.' });
    assert.equal(rows.length, 2, 'idle characters stay out of the ledger');
    assert.deepEqual(rows.map(row => row.character), ['Lena', 'Ram']);
    assert.equal(rows[0].wanted, 'get out before dawn');
    assert.equal(rows[0].did, 'opens the east door');
    assert.deepEqual(rows[0].conflict, { level: 'minor', why: 'she owes the guard' });
    assert.equal(rows[0].result, 'She gets the door open.');
    assert.match(rows[0].page, /Lena forced the door/);
});

test('the ledger grows by appending and is cut to its limit; a word-for-word render is stable', () => {
    const rows = buildLedgerRows({ turn: 1, at: 1, form, outcome: [] });
    let ledger = appendLedger([], rows, { limit: 3 });
    ledger = appendLedger(ledger, rows, { limit: 3 });
    assert.equal(ledger.length, 3, 'the oldest rows fall away');
    const text = renderLedger(ledger);
    assert.match(text, /LEDGER/);
    assert.match(text, /T1 Lena: get out before dawn \[minor: she owes the guard\]/);
    assert.match(text, /T1 Ram: stay \[strong: her sister asked her to\]/);
});

test('bad stored ledger rows are dropped, not trusted', () => {
    const clean = normalizeLedger([{ character: '' }, null, { character: 'Lena', wanted: 'x', conflict: { level: 'weird' } }]);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].conflict.level, 'none');
});

test('a telegram is only honoured for the closed list of reasons', () => {
    for (const line of ['Lena is dead.', 'An irreversible loss: the gate is gone.', 'You betrayed Ram.', 'Emilia leaves the story for good.']) {
        assert.equal(isClosedTelegram(line), true, line);
    }
    for (const line of ['The weather turns.', 'Someone is coming up the stairs.', '']) assert.equal(isClosedTelegram(line), false, line);
});

function harness() {
    const ledger = [];
    const papers = { prayers: [], telegrams: [], awaitingDecree: null };
    const events = [];
    const edits = [];
    const known = [];
    const store = {
        appendLedger: async rows => { ledger.push(...rows); return ledger; },
        addPrayer: async entry => { papers.prayers.push(entry); return papers; },
        addTelegram: async entry => { papers.telegrams.push(entry); return papers; },
        saveAwaitingDecree: async value => { papers.awaitingDecree = value; return papers; },
    };
    const banks = {
        edit: async (params, options) => {
            edits.push({ params, options });
            return { ok: true, changes: params.edits.map(edit => (/^knowledge/i.test(String(edit.section))
                ? { kind: 'knowledge', character: edit.character, old: '', new: edit.new }
                : { kind: 'section', character: edit.character, part: 'material', section: 4, pending: false, old: '', new: edit.new })) };
        },
    };
    const knowledge = { handlers: { character_knowledge: async args => { known.push(args); return { ok: true, id: 'k1' }; } } };
    const state = { turnCounter: 7, lastForm: form, lastWriterText: 'Lena forced the door; Ram let her pass.' };
    const handler = createAfterTurnHandler({ store, banks, knowledge, state, publishEvent: (event, payload) => events.push([event, payload]) });
    return { handler, ledger, papers, events, edits, known };
}

test('after the turn records the outcome, the physical changes and the knowledge, one call for all of it', async () => {
    const world = harness();
    const result = await world.handler({
        comment: 'The page is written.',
        outcome: [{ character: 'Lena', result: 'She gets the door open.' }, { character: 'Ram', result: 'She steps aside.' }],
        bankEdits: [
            { character: 'Lena', section: 'clothing', old: '', new: 'A torn sleeve.' },
            { character: 'Lena', section: 'knowledge', old: '', new: 'The east door has a broken lock.' },
        ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 2);
    assert.equal(world.edits[0].options.by, 'resolver', 'the resolver rights follow the resolver');
    assert.deepEqual(world.known.map(item => [item.character, item.fact]), [['Lena', 'The east door has a broken lock.']], 'knowledge goes through its own system');
    assert.equal(world.ledger.length, 2);
    assert.equal(world.ledger[0].result, 'She gets the door open.');
});

test('a prayer is kept and shown in the log; a telegram outside the closed list is kept but does not block the turn', async () => {
    const world = harness();
    const result = await world.handler({ comment: 'The page is written.', prayer: 'She used the gate to lift a cart, which no rule covers.', telegram: 'Someone is coming up the stairs.' });
    assert.equal(result.prayer, true);
    assert.equal(result.blocked, false, 'not a closed-list reason');
    assert.equal(world.papers.telegrams.length, 1);
    assert.equal(world.papers.awaitingDecree, null);
    assert.ok(world.events.some(([event]) => event === 'decision.prayer'));
    assert.ok(world.events.some(([event]) => event === 'decision.telegram'));
});

test('a telegram from the closed list sets the flag that the next turn waits for a Decree', async () => {
    const world = harness();
    const result = await world.handler({ comment: 'The page is written.', telegram: 'Lena is dead.' });
    assert.equal(result.blocked, true);
    assert.equal(world.papers.awaitingDecree.why, 'Lena is dead.');
    assert.equal(world.papers.awaitingDecree.turn, 7);
});

test('a closing call with nothing but a comment changes nothing and says so', async () => {
    const world = harness();
    const result = await world.handler({ comment: 'Nothing changed this turn.' });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 0);
    assert.equal(result.changes, 0);
    assert.equal(world.papers.prayers.length, 0);
});

test('the director log shows the ledger rows, the prayer and the telegram of the closing call', async () => {
    const { buildCycleEntry } = await import('../libraries/core/decision-feed.js');
    const entry = buildCycleEntry({
        id: 'after', runId: 'run_1_after', event: 'after_turn',
        toolCalls: [{ name: 'after_turn', args: { outcome: [{ character: 'Lena', result: 'She gets the door open.' }], prayer: 'A cart was lifted.', telegram: 'Lena is dead.' }, result: { ok: true, blocked: true }, comment: 'The page is written.' }],
    });
    const kinds = entry.rows.map(row => row.kind);
    assert.ok(kinds.includes('ledger'));
    assert.ok(kinds.includes('prayer'));
    assert.ok(kinds.includes('telegram'));
    assert.equal(entry.rows.find(row => row.kind === 'telegram').blocked, true);
    assert.match(entry.rows.find(row => row.kind === 'ledger').text, /Lena: She gets the door open\./);
});

test('after the turn the Resolver edits files like the Director: material.md, knowledge.md; decree.md stays the Director\'s', async () => {
    const { createAfterTurnHandler } = await import('../cores/decision/handlers-after-turn.js');
    const state = { lena: { name: 'Lena', aliases: [], material: { 5: ['Wool dress'] }, spiritual: {}, decree: { 3: ['Today: find the key.'] }, history: [] } };
    const bankEdits = [];
    const decreeWrites = [];
    const learned = [];
    const banks = { great: {
        sync: async () => state, load: async () => state,
        edit: async (params, options) => { bankEdits.push({ ...params, by: options.by }); return { ok: true, changes: params.edits }; },
        writeDecree: async params => { decreeWrites.push(params); return { ok: true }; },
    } };
    const knowledge = { load: async () => ({ lena: { name: 'Lena', items: [] } }), handlers: { character_knowledge: async args => { learned.push(args); return { ok: true }; } } };
    const handler = createAfterTurnHandler({ store: {}, banks, knowledge, state: { turnCounter: 3 } });
    const answer = await handler({
        comment: 'The page left her soaked and wiser.',
        edits: [
            { path: 'Characters/Lena/material.md', old: '- Wool dress', new: '- Wool dress, soaked through' },
            { path: 'Characters/Lena/knowledge.md', old: '', new: '- The guard has a key on his belt.' },
            { path: 'Characters/Lena/decree.md', old: '- Today: find the key.', new: '- Today: steal the key.' },
        ],
    });
    assert.equal(answer.ok, true);
    assert.deepEqual(bankEdits[0].edits, [{ character: 'Lena', section: 'material 5', old: 'Wool dress', new: 'Wool dress, soaked through' }]);
    assert.equal(bankEdits[0].by, 'resolver');
    assert.deepEqual(learned.map(item => [item.op, item.fact]), [['add', 'The guard has a key on his belt.']]);
    assert.equal(decreeWrites.length, 0, 'the Resolver never writes the Decree');
});
