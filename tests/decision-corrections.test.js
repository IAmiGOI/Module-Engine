import test from 'node:test';
import assert from 'node:assert/strict';
import { createGreatBank } from '../cores/decision/bank-great.js';
import { createPatchInbox } from '../cores/decision/patch-inbox.js';
import { packSnapshot, unpackSnapshot, correctSnapshotPart } from '../libraries/core/snapshot-pool.js';

const elil = () => ({ name: 'Elil', sourceKey: 'card:Elil.png', importance: 'main', psyche: ['She asks permission for water.'], decree: { 5: ['When spoken to, she answers at once.'] } });

function bankWith(character = elil()) {
    const memory = new Map([['greatBank', { elil: character }]]);
    const corrections = [];
    const call = async (contract, params = {}) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
        if (contract === 'chatHistory.annotations') return {};
        return undefined;
    };
    const store = { clock: () => ({ minutes: 0 }), correctSnapshots: async list => { corrections.push(...list); return list.length; } };
    const great = createGreatBank({ call, store, banks: { records: () => [] } });
    return { great, corrections, memory };
}

test('a snapshot that held the old version of a part takes the correction; one from earlier in the story keeps its own', () => {
    const pool = {};
    const regen = packSnapshot(pool, { greatBank: { elil: { name: 'Elil', psyche: ['old'] } } });
    const earlier = packSnapshot(pool, { greatBank: { elil: { name: 'Elil', psyche: ['before the story turned'] } } });
    const fixed = correctSnapshotPart(pool, regen, { key: 'elil', part: 'psyche', from: ['old'], to: ['new'] });
    assert.equal(fixed.changed, true);
    assert.deepEqual(unpackSnapshot(pool, fixed.snapshot).greatBank.elil.psyche, ['new']);
    assert.equal(correctSnapshotPart(pool, earlier, { key: 'elil', part: 'psyche', from: ['old'], to: ['new'] }).changed, false);
});

test('a correction replaces psyche.md or named sections, keeps the old lines in history and reaches the snapshots', async () => {
    const { great, corrections } = bankWith();
    const psyche = await great.correct({ character: 'Elil', part: 'psyche', lines: ['She waits to be told.'] });
    assert.equal(psyche.ok, true);
    const decree = await great.correct({ character: 'Elil', part: 'decree', sections: { 5: ['When she is unsure, she stays where she is.'] } });
    assert.equal(decree.ok, true);
    const state = await great.load();
    assert.deepEqual(state.elil.psyche, ['She waits to be told.']);
    assert.deepEqual(state.elil.decree[5], ['When she is unsure, she stays where she is.']);
    assert.ok(state.elil.history.some(item => item.part === 'psyche' && /asks permission/.test(item.old)));
    assert.deepEqual(corrections.map(item => item.part), ['psyche', 'decree']);
    assert.deepEqual(corrections[0].from, ['She asks permission for water.']);
});

test('the user\'s edit of a bank in The Court reaches the snapshots; the Director\'s own edit stays a story event', async () => {
    const { great, corrections } = bankWith({ ...elil(), material: { 1: ['A thin catgirl.'] } });
    await great.edit({ edits: [{ character: 'Elil', section: 'material 1', old: 'A thin catgirl.', new: 'A thin, starved catgirl.' }] }, { by: 'user' });
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0].part, 'material');
    await great.edit({ edits: [{ character: 'Elil', section: 'material 1', old: 'A thin, starved catgirl.', new: 'A catgirl.' }] }, { by: 'director' });
    assert.equal(corrections.length, 1, 'no correction for the Director');
});

test('the patch inbox applies edits for its own chat, answers with a report and leaves a patch for another chat alone', async () => {
    const replies = [];
    let removed = 0;
    let patch = { chatId: 'Elil - 1', edits: [{ character: 'Elil', part: 'psyche', lines: ['She waits.'] }, { character: 'Elil', rewrite: 'psyche' }] };
    const applied = [];
    const callService = async (contract, params) => {
        if (contract === 'stPatchInbox.read') return patch;
        if (contract === 'stChat.chatId') return { open: true, id: 'Elil - 1' };
        if (contract === 'stPatchInbox.remove') { removed += 1; patch = null; return true; }
        if (contract === 'stPatchInbox.reply') { replies.push(params.result); return true; }
        return null;
    };
    const banks = {
        great: { correct: async item => { applied.push(item); return { ok: true, character: item.character, part: item.part }; } },
        rewritePsyche: async name => { applied.push({ rewrite: name }); return { ok: true, name }; },
    };
    const inbox = createPatchInbox({ callService, banks });
    const result = await inbox.take();
    assert.equal(result.ok, true);
    assert.equal(applied.length, 2);
    assert.equal(applied[0].by, 'outside');
    assert.deepEqual(applied[1], { rewrite: 'Elil' });
    assert.equal(removed, 1);
    assert.equal(replies[0].results.length, 2);
    patch = { chatId: 'Other chat', edits: [{ character: 'X', part: 'psyche', lines: ['y'] }] };
    assert.equal((await inbox.take()).skipped, true);
    assert.equal(removed, 1, 'a patch for another chat stays in the inbox');
});
