import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirector } from '../cores/decision/director.js';
import {
    directorReason, lastReports, renderReports, lastDecreeThoughts, buildDirectorContext,
    mainWithoutDecree, namedCharacters, importanceItems, pendingDecisions,
} from '../libraries/core/decision-director.js';
import {
    DIRECTOR_DECREE_SYSTEM, DIRECTOR_THINK_DECREE, REPORTS_HEADER, LAST_DECREES_HEADER, TOUCHED_BANKS_HEADER,
    DIRECTOR_RP_HEADER,
} from '../libraries/core/decision-prompts.js';

const call = (name, args) => ({ id: `${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: { ...args } });
const bankState = {
    lena: { name: 'Lena', importance: 'main', material: { 1: ['Tall, grey-eyed.'] }, spiritual: { 4: ['Get out.'] }, decree: {}, history: [], pending: [] },
    ram: { name: 'Ram', importance: 'side', material: {}, spiritual: {}, decree: { 1: ['Family first.'] }, history: [], pending: [] },
};
const petition = name => ({
    id: `pet_${name}`, at: 1, turn: 4, character: name, problem: `${name} cannot go on.`,
    excerpt: `- T4 ${name}: the gate`, promote: null, day: false, prepareNewDay: false, status: 'queued', to: 'director',
});

function harness({ answers = [], petitions = [], telegrams = [], cycles = [], awaiting = null } = {}) {
    const requests = [];
    const events = [];
    const state = {
        petitions: petitions.map(item => ({ ...item })),
        telegrams: telegrams.map(item => ({ ...item })),
        awaitingDecree: awaiting,
        director: { lastRunAt: 0, lastReason: '' },
        cycles: [...cycles],
        decrees: [], importance: [], pending: [],
    };
    const queue = [...answers];
    const callModel = async (contract, params) => {
        assert.equal(contract, 'model.generate');
        requests.push(params);
        const next = queue.shift();
        if (!next) throw new Error('the fake model ran out of answers');
        return next;
    };
    const store = {
        clock: () => ({ minutes: 6 * 1440 + 600, updatedAt: 1 }),
        window: () => ({ entries: [{ kind: 'turn', turn: 6, text: 'TURN 6' }] }),
        cycles: () => state.cycles,
        library: () => ({ lena: { name: 'Lena', level: 1 }, ram: { name: 'Ram', level: 3 } }),
        papers: () => ({
            petitions: state.petitions.map(item => ({ ...item })),
            telegrams: state.telegrams.map(item => ({ ...item })),
            awaitingDecree: state.awaitingDecree,
            counsellor: {}, director: { ...state.director },
        }),
        markPetitionsRead: async at => { state.petitions = state.petitions.map(item => ({ ...item, status: 'read', readAt: at })); },
        markTelegramsRead: async at => { state.telegrams = state.telegrams.map(item => ({ ...item, status: 'read', readAt: at })); },
        saveAwaitingDecree: async value => { state.awaitingDecree = value; },
        saveDirector: async patch => { state.director = { ...state.director, ...patch }; },
        appendCycle: async cycle => { state.cycles.push(cycle); return cycle; },
        saveDecree: async () => {},
    };
    const banks = {
        great: {
            load: async () => bankState,
            setDecree: async args => { state.decrees.push(args); return { ok: true, at: '[Day 7, 10:00]', decrees: args.decrees.map(item => ({ character: item.character, changed: true })) }; },
            setImportance: async args => { state.importance.push(args); return { ok: true, character: args.character, importance: args.importance }; },
            resolvePending: async args => { state.pending.push(args); return { ok: true, accepted: args.accept }; },
            edit: async () => ({ ok: true, at: '', changes: [], created: [] }),
        },
    };
    const full = {
        decider: { workerId: 'resolver', maxTokens: 8000, temperature: 0.7, topP: 1, topK: 0, reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0 },
        director: { workerId: '', maxSteps: 10, decreeTimeoutMs: 5000 },
        retry: { maxAttempts: 3, turnBudgetMs: 120000, backgroundBudgetMs: 600000, backups: {} },
    };
    const director = createDirector({
        call: callModel, callTool: async () => ({ ok: true }), store, banks,
        getSettings: () => full, getWorkers: () => [{ id: 'resolver', format: 'openai', model: 'flash' }],
        publishEvent: (event, payload) => events.push([event, payload ?? {}]),
        enqueue: job => job(), now: (() => { let value = 1000; return () => (value += 10); })(),
        sleep: async () => {},
    });
    return { director, state, requests, events, settings: full };
}

test('the wake reasons are Petition, Telegram, Main Cast without a Decree, promotion and the end of the day', () => {
    const petitions = [
        petition('Lena'),
        { ...petition('Ram'), promote: { level: 'main', reason: 'She matters now.' } },
        { ...petition('Echo'), prepareNewDay: true, day: true },
    ];
    const reason = directorReason({ petitions, telegrams: [{ text: 'Lena is dying.', at: 2, status: 'queued' }], banks: bankState });
    assert.ok(reason);
    assert.match(reason.wake.label, /prepares the new day/);
    assert.deepEqual(reason.reasons.map(item => item.type), ['petition', 'telegram', 'cast', 'promotion', 'day']);
    assert.ok(reason.characters.includes('Lena'));
    assert.ok(reason.characters.includes('Ram'));
    assert.equal(directorReason({ petitions: [], telegrams: [], banks: { lena: { ...bankState.lena, importance: 'side' } } }), null);
    assert.deepEqual(mainWithoutDecree(bankState), ['Lena']);
    assert.deepEqual(namedCharacters('Lena is dying.', bankState), ['Lena']);
});

test('the reports are the last five Petitions and Telegrams, with the Ledger excerpt', () => {
    const reports = lastReports({
        petitions: Array.from({ length: 6 }, (_, index) => ({ ...petition('Lena'), id: `p${index}`, at: index })),
        telegrams: [{ text: 'Ram is dead.', at: 10, status: 'queued', blocked: true }],
    });
    assert.equal(reports.length, 5);
    assert.equal(reports.at(-1).kind, 'telegram');
    assert.match(renderReports(reports), /\[Telegram\] \(blocks the next turn\) Ram is dead\./);
    assert.match(renderReports(lastReports({ petitions: [petition('Lena')] })), /\[Petition\] Lena\nLena cannot go on\.\nLedger:\n- T4 Lena/);
});

test('the Director sees its own reasoning, the touched banks, the reports and RP time — never the chat', () => {
    const cycles = [
        { event: 'turn', thinking: 'I decided the turn.' },
        { event: 'decree', thinking: 'Lena needs a new reason to stay.', form: {} },
    ];
    const thoughts = lastDecreeThoughts(cycles);
    assert.deepEqual(thoughts, ['Lena needs a new reason to stay.']);
    const built = buildDirectorContext({
        banks: bankState, library: { lena: { name: 'Lena', level: 1 } },
        characters: ['Lena'], reports: lastReports({ petitions: [petition('Lena')] }), thoughts,
        rpTime: 'Day 7, 10:00', reason: '1 petition',
    });
    const text = built.prompt;
    assert.match(text, new RegExp(DIRECTOR_DECREE_SYSTEM.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(text.includes(TOUCHED_BANKS_HEADER));
    assert.match(text, /Tall, grey-eyed/);
    assert.ok(text.includes(LAST_DECREES_HEADER));
    assert.match(text, /new reason to stay/);
    assert.ok(text.includes(REPORTS_HEADER));
    assert.match(text, /Lena cannot go on/);
    assert.ok(text.includes(DIRECTOR_RP_HEADER));
    assert.match(text, /Day 7, 10:00/);
    assert.equal(text.includes('User:'), false, 'no chat history');
    assert.ok(text.includes(DIRECTOR_THINK_DECREE), 'the CoT is verbatim');
});

test('a wake issues a Decree in one call, then rest: the queue is read and the Telegram no longer holds the turn', async () => {
    const world = harness({
        petitions: [petition('Lena')],
        telegrams: [{ text: 'Lena is dying.', at: 2, status: 'queued', blocked: true }],
        awaiting: { why: 'Lena is dying.' },
        answers: [{
            text: '', toolCalls: [call('decree', {
                decrees: [{
                    character: 'Lena', valuesAndFacts: 'Freedom above all.', selfView: 'A prisoner.',
                    goals: { long: 'Leave.', today: 'Find the key.' }, mood: 'slightly agitated, neutral warm, strongly tired',
                    resolving: 'She bargains before she runs.',
                }],
                importance: [{ character: 'Ram', importance: 'main' }],
                pending: [{ character: 'Lena', index: 0, accept: true }],
                comment: 'The report changed Lena and Ram now matters.',
            })],
        }],
    });
    const result = await world.director.run({ runId: 'd1' });
    assert.equal(result.ok, true);
    assert.equal(result.issued, true);
    assert.deepEqual(result.characters, ['Lena']);
    assert.equal(world.state.decrees.length, 1);
    assert.equal(world.state.importance[0].importance, 'main');
    assert.equal(world.state.pending[0].accept, true);
    assert.equal(world.state.petitions[0].status, 'read');
    assert.equal(world.state.telegrams[0].status, 'read');
    assert.equal(world.state.awaitingDecree, null);
    const cycle = world.state.cycles.at(-1);
    assert.equal(cycle.event, 'decree');
    assert.match(cycle.wake.label, /prepares the new day|Telegram|Petitions/);
    assert.match(cycle.wake.detail, /Decree: Lena/);
    assert.equal(world.events.some(([event]) => event === 'decision.director.finished'), true);
    const sent = world.requests[0].messages.map(message => message.content).join('\n\n');
    assert.match(sent, /REPORTS — the last five things/);
    assert.equal(sent.includes('User:'), false);
});

test('a Telegram holds the turn until a Decree, and a missed Decree leaves a warning and lets the turn go on', async () => {
    const world = harness({
        telegrams: [{ text: 'Lena is dying.', at: 2, status: 'queued', blocked: true }],
        awaiting: { why: 'Lena is dying.' },
        // Director answers without a Decree: the Telegram stays open, so the wait reports a timeout.
        answers: [{ text: '', toolCalls: [call('await', { reason: 'The old Decree still holds.', comment: 'Nothing to change.' })] }],
    });
    const waited = await world.director.waitForDecree({ timeoutMs: 1000 });
    assert.equal(waited.waited, true);
    assert.equal(waited.ok, false);
    assert.equal(world.state.awaitingDecree, null, 'the next turn is not held forever');
    const warning = world.state.cycles.find(cycle => cycle.event === 'warning');
    assert.ok(warning);
    assert.match(warning.wake.label, /waited for a Decree/);
    assert.match(warning.wake.detail, /old Decree/);
});

test('director settings and the Decree lists are clamped into safe shapes', () => {
    assert.deepEqual(importanceItems([{ character: 'Lena', level: 'Main Cast' }]), [{ character: 'Lena', importance: 'main' }]);
    assert.deepEqual(importanceItems([{ character: 'Lena', importance: 'king' }]), []);
    assert.deepEqual(pendingDecisions([{ character: 'Lena', index: -3, accept: false }, {}]), [{ character: 'Lena', index: 0, accept: false }]);
});
