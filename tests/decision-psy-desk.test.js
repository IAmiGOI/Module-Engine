import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDirector } from '../cores/decision/director.js';
import { createPsyDesk } from '../cores/decision/psy-desk.js';
import { createFileLayer } from '../cores/decision/files-layer.js';
import { PSYCHOLOGIST_DESK_SYSTEM, PSYCHOLOGIST_DESK_PROPOSAL } from '../libraries/core/decision-prompts.js';

const call = (name, args) => ({ id: `${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: { ...args } });
const key = name => String(name ?? '').trim().toLowerCase();

const petition = name => ({
    id: `pet_${name}`, at: 1, turn: 4, character: name, problem: `${name} has no bank yet.`,
    excerpt: `- T4 ${name}: the gate`, promote: null, day: false, prepareNewDay: false, status: 'queued', to: 'director',
});

const EMPTY = name => ({ name, aliases: [], importance: 'main', material: {}, spiritual: {}, decree: {}, psyche: [], history: [], pending: [] });

const MATERIAL = '## 1. Appearance\n- Black hair, one horn.';
const OBJECTION = 'Line "Black hair, one horn." contradicts the card, which says she hides the horn: a person cannot both hide it and show it openly at the start; make the bank say she hides it.';

function harness({ answers = [], psy = [], bank = {}, petitions = [], telegrams = [] } = {}) {
    const state = {
        bank: structuredClone(bank),
        petitions: petitions.map(item => ({ ...item })),
        telegrams: telegrams.map(item => ({ ...item })),
        awaitingDecree: null,
        director: { lastRunAt: 0, lastReason: '' },
        cycles: [], psyche: [], edits: [], held: [], released: [],
    };
    const directorRequests = [];
    const psychRequests = [];
    const events = [];
    const queue = [...answers];
    const psychQueue = [...psy];
    const callModel = async (contract, params) => {
        assert.equal(contract, 'model.generate');
        if (params.systemPrompt) {
            psychRequests.push(params);
            const next = psychQueue.shift();
            if (next === undefined) throw new Error('the fake Psychologist ran out of answers');
            return next;
        }
        directorRequests.push(params);
        const next = queue.shift();
        if (!next) throw new Error('the fake Director ran out of answers');
        return next;
    };
    const find = name => state.bank[key(name)] ?? null;
    const applyEdit = edit => {
        const character = find(edit.character);
        if (!character) return;
        const match = /^(material|spiritual|decree)\s+(\d+)$/.exec(String(edit.section ?? ''));
        if (!match) return;
        const part = match[1], no = Number(match[2]);
        const lines = [...(character[part]?.[no] ?? [])];
        if (edit.old) {
            const at = lines.findIndex(line => line === edit.old);
            if (at >= 0) { if (edit.new) lines[at] = edit.new; else lines.splice(at, 1); }
            else if (edit.new) lines.push(edit.new);
        } else if (edit.new) lines.push(edit.new);
        character[part] = { ...(character[part] ?? {}), [no]: lines };
    };
    const great = {
        load: async () => state.bank,
        sync: async () => state.bank,
        edit: async ({ edits }) => { state.edits.push(...edits); for (const edit of edits) applyEdit(edit); return { ok: true, at: '', changes: edits, created: [] }; },
        writeDecree: async ({ character, sections }) => { const found = find(character); if (found) found.decree = sections; return { ok: true, at: '', decrees: [{ character, changed: true }] }; },
        setPsyche: async ({ character, lines }) => { const found = find(character); if (found) found.psyche = [...lines]; state.psyche.push({ character, lines: [...lines] }); return { ok: true, character, lines: lines.length }; },
        setImportance: async () => ({ ok: true }),
        resolvePending: async () => ({ ok: true }),
    };
    const store = {
        clock: () => ({ minutes: 6 * 1440 + 600, updatedAt: 1 }),
        window: () => ({ entries: [{ kind: 'turn', turn: 6, text: 'TURN 6' }] }),
        cycles: () => state.cycles,
        library: () => ({}),
        chatBrief: () => ({ timeline: 'The story starts at the gate.' }),
        papers: () => ({
            petitions: state.petitions.map(item => ({ ...item })), telegrams: state.telegrams.map(item => ({ ...item })),
            awaitingDecree: state.awaitingDecree, counsellor: {}, director: { ...state.director },
        }),
        markPetitionsRead: async at => { state.petitions = state.petitions.map(item => ({ ...item, status: 'read', readAt: at })); },
        markTelegramsRead: async at => { state.telegrams = state.telegrams.map(item => ({ ...item, status: 'read', readAt: at })); },
        saveAwaitingDecree: async value => { state.awaitingDecree = value; },
        saveDirector: async patch => { state.director = { ...state.director, ...patch }; },
        appendCycle: async cycle => { state.cycles.push(cycle); return cycle; },
    };
    const banks = {
        great,
        ensurePsyche: async () => ({ skipped: true, written: [] }),
        holdPsyche: names => state.held.push(...names),
        releasePsyche: names => state.released.push(...names),
    };
    const settings = {
        decider: { workerId: 'director-worker', maxTokens: 8000, temperature: 0.7, topP: 1, topK: 0, reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0 },
        director: { workerId: '', maxSteps: 10, decreeTimeoutMs: 5000 },
        psychologist: { workerId: '' },
        retry: { maxAttempts: 3, turnBudgetMs: 120000, backgroundBudgetMs: 600000, backups: {} },
    };
    const director = createDirector({
        call: callModel, callTool: async () => ({ ok: true }), store, banks,
        getSettings: () => settings, getWorkers: () => [{ id: 'director-worker', format: 'openai', model: 'flash' }],
        publishEvent: (event, payload) => events.push([event, payload ?? {}]),
        enqueue: job => job(), now: (() => { let value = 1000; return () => (value += 10); })(),
        sleep: async () => {},
    });
    return { director, state, directorRequests, psychRequests, events };
}

test('without write_bank the Psychologist is never called', async () => {
    const world = harness({
        bank: { lena: EMPTY('Lena') },
        petitions: [petition('Lena')],
        answers: [
            { text: '', toolCalls: [call('check_reports', {
                characters: [{ name: 'Lena', named_by: 'the Petition', write_bank: false, decree: 'none', line: '', evidence: 'Nothing changes for her yet.' }],
                comment: 'The report changes nothing yet.',
            })] },
            { text: '', toolCalls: [call('await', { reason: 'Nothing to change.', comment: 'The report is already covered.' })] },
        ],
    });
    const result = await world.director.run({ runId: 'd1' });
    assert.equal(result.type, 'await');
    assert.equal(world.psychRequests.length, 0, 'no Psychologist without write_bank');
    assert.deepEqual(world.state.held, [], 'nobody is held for a non-bank run');
});

test('an objection refuses the write and reaches the Director; the same line passes on the second call', async () => {
    const world = harness({
        bank: { emilia: EMPTY('Emilia') },
        petitions: [petition('Emilia')],
        answers: [
            { text: '', toolCalls: [call('check_reports', {
                characters: [{ name: 'Emilia', named_by: 'the Petition', write_bank: true, decree: 'none', line: '', evidence: 'Her material and spiritual files are empty.' }],
                comment: 'The world starts empty for Emilia, so her bank is written now.',
            })] },
            { text: '', toolCalls: [call('create', { path: 'Characters/Emilia/material.md', text: MATERIAL, comment: 'Her first bank line, from the card.' })] },
            { text: '', toolCalls: [call('create', { path: 'Characters/Emilia/material.md', text: MATERIAL, comment: 'The Psychologist objected; I keep the line because the card hides the horn behind her hair.' })] },
            { text: '', toolCalls: [call('edit', {
                edits: [{ path: 'Characters/Emilia/spiritual.md', old: '', new: '- Keeps her word.' }],
                comment: 'Her values, from the card.',
            })] },
            { text: '', toolCalls: [call('await', { reason: 'The bank is written.', comment: 'Both files are in place.' })] },
        ],
        psy: [OBJECTION, 'ok', 'She hides the horn before she trusts anyone.\nFear moves slowly under her calm.'],
    });
    const result = await world.director.run({ runId: 'd1' });
    assert.equal(result.type, 'await');
    assert.equal(world.psychRequests.length, 3, 'objection, one ok for spiritual, one psyche at the end');

    const creates = result.cycle.toolCalls.filter(item => item.name === 'create');
    const edits = result.cycle.toolCalls.filter(item => item.name === 'edit');
    assert.equal(creates.length, 2);
    assert.equal(creates[0].result.ok, false, 'the objected create is not applied');
    assert.match(creates[0].result.error, /black hair, one horn/i);
    assert.equal(creates[1].result.ok, true, 'the same line passes on the second call');
    assert.equal(edits.length, 1);
    assert.equal(edits[0].result.ok, true, 'the checked edit is applied');

    // Возражение пришло Директору репликой Психолога, а не только отказом инструмента.
    const afterObjection = world.directorRequests[2].messages.map(message => String(message.content ?? ''));
    assert.ok(afterObjection.some(line => line.startsWith('PSYCHOLOGIST:') && /black hair, one horn/i.test(line)));
    // Первый вызов не дошёл до записи: правки появились только со второго.
    assert.equal(world.state.edits.length, 2, 'material and spiritual edits only');
    assert.deepEqual(world.state.bank.emilia.material[1], ['Black hair, one horn.']);
    assert.ok(Object.values(world.state.bank.emilia.spiritual).flat().includes('Keeps her word.'));
    assert.deepEqual(world.state.bank.emilia.psyche, ['She hides the horn before she trusts anyone.', 'Fear moves slowly under her calm.']);
    assert.deepEqual(world.state.psyche.map(item => item.character), ['Emilia'], 'psychologist wrote psyche.md at the end of the session');
    assert.deepEqual(world.state.held, ['Emilia']);
    assert.deepEqual(world.state.released, ['Emilia']);
});

test('an objection on edit refuses the whole call before anything is written', async () => {
    let writes = 0;
    const state = { emilia: EMPTY('Emilia') };
    const files = createFileLayer({
        banks: {
            great: {
                sync: async () => state,
                load: async () => state,
                edit: async () => { writes += 1; return { ok: true, changes: [] }; },
            },
        },
        beforeWrite: async ({ path }) => ({ ok: false, error: `${path}: one line is untrue for this person`, speaker: 'PSYCHOLOGIST' }),
    });
    const result = await files.edit({ edits: [{ path: 'Characters/Emilia/material.md', old: '', new: '- Tall.' }] }, { by: 'director' });
    assert.equal(result.ok, false);
    assert.match(result.error, /one line is untrue/);
    assert.equal(result.speaker, 'PSYCHOLOGIST');
    assert.equal(writes, 0, 'the objected call writes nothing');
});

test('the desk keeps one round per line: the same proposal is not checked twice', async () => {
    const calls = [];
    const desk = createPsyDesk({
        call: async (contract, params) => { assert.equal(contract, 'model.generate'); calls.push(params); return OBJECTION; },
        getSettings: () => ({ decider: { workerId: 'w' }, director: { workerId: '' }, psychologist: { workerId: '' } }),
        getWorkers: () => [{ id: 'w', format: 'openai' }],
    });
    desk.activate({ names: ['Emilia'] });
    const proposal = { path: 'Characters/Emilia/material.md', part: 'material', name: 'Emilia', before: '', after: MATERIAL };
    const first = await desk.check(proposal);
    assert.equal(first.ok, false);
    assert.equal(first.speaker, 'PSYCHOLOGIST');
    const second = await desk.check(proposal);
    assert.equal(second.ok, true);
    assert.equal(calls.length, 1, 'the same line gets no second round');
});

test('the user\'s character never gets a Psychologist, neither at the desk nor for psyche.md', async () => {
    const calls = [];
    const desk = createPsyDesk({
        call: async (contract, params) => { assert.equal(contract, 'model.generate'); calls.push(params); return 'ok'; },
        getSettings: () => ({ decider: { workerId: 'w' }, director: { workerId: '' }, psychologist: { workerId: '' } }),
        getWorkers: () => [{ id: 'w', format: 'openai' }],
        great: { setPsyche: async () => { throw new Error('the user\'s psyche must not be written'); } },
    });
    desk.activate({ names: ['Sasha'], users: ['Sasha'] });
    const checked = await desk.check({ path: 'Characters/Sasha/material.md', part: 'material', name: 'Sasha', before: '', after: MATERIAL });
    assert.equal(checked.ok, true);
    const finished = await desk.finish({
        state: { sasha: { name: 'Sasha', importance: 'main', sourceKey: 'persona:user', material: { 1: ['Tall.'] }, spiritual: { 1: ['Free.'] }, decree: {}, psyche: [] } },
    });
    assert.deepEqual(finished.written, []);
    assert.equal(calls.length, 0);
});

test('the Psychologist-at-the-desk prompts are PROMPTS.md section 46 word for word', () => {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    let at = doc.indexOf('## 46. Психолог-сосед');
    const blocks = [];
    for (let index = 0; index < 2; index += 1) {
        const fence = doc.indexOf('```text', at);
        const body = doc.indexOf('\n', fence) + 1;
        const end = doc.indexOf('```', body);
        blocks.push(doc.slice(body, end).trimEnd());
        at = end + 3;
    }
    assert.deepEqual(blocks, [PSYCHOLOGIST_DESK_SYSTEM, PSYCHOLOGIST_DESK_PROPOSAL]);
});
