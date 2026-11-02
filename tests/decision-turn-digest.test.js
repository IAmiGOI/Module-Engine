import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleRecord } from '../libraries/core/decision-log.js';
import {
    buildTurnDigest, groupTurns, renderCompressedDigests, renderFullTurns,
} from '../libraries/core/decision-turn-digest.js';

function call(name, args, result, extra = {}) {
    return { name, args, result, comment: args.comment, error: null, ...extra };
}

const active = createCycleRecord({
    id: 'c1', runId: 'run_1', at: 1000, event: 'turn', turn: 2, clockMinutes: 120,
    messages: [
        { role: 'user', content: 'Where is the exit?' },
        { role: 'assistant', content: 'I look around.' },
    ],
    toolCalls: [
        call('update_roster', { add: [{ name: 'Puck' }], remove: ['Rom'], comment: 'The roster changed.' }, { ok: true }),
        call('assess', { character: 'Aria', action: 'open the door', difficulty: 'hard', experience: 'skilled', comment: 'I need the chance first.' }, { ok: true, probability: 0.35, degree: 'barely', words: 'barely, with visible effort' }),
        call('character_note', { character: 'Rem', op: 'add', title: 'Wound', text: 'wound on the shoulder', comment: 'The writer must know.' }, { ok: true, count: 1 }),
        call('memory', { op: 'search', character: 'Rem', query: 'wound', comment: 'Check what I know.' }, { ok: true, records: [{ text: 'SECRET-READ-RESULT' }] }),
        call('memory', { op: 'write', character: 'Rem', text: 'She is wounded.', important: true, comment: 'Keep it forever.' }, { ok: true, id: 'm1' }),
        call('library', { character: 'Rem', comment: 'Read the shelf.' }, { ok: true, characters: [{ name: 'SECRET-LIBRARY-RESULT' }] }),
    ],
    thinking: 'SECRET-THINKING',
    form: {
        resolution: 'She slips out.', characters: [], scene: { minutes: 5, place: 'the east corridor' },
        meta: { place: 'the east corridor' }, push: 'This turn took 5 minutes.\nPlace: the east corridor.',
    },
    push: 'This turn took 5 minutes.\nPlace: the east corridor.',
    warnings: ['the door was locked'],
});

const message = createCycleRecord({
    id: 'c2', runId: 'run_1', at: 2000, event: 'message', turn: 2, clockMinutes: 120,
    message: { text: 'Make it darker.', at: 2000 },
    messages: [{ role: 'assistant', content: 'Understood.' }],
});

const passive = createCycleRecord({
    id: 'c3', runId: 'run_1', at: 3000, event: 'time', turn: 2, clockMinutes: 120,
    toolCalls: [call('set_character_plan', { character: 'Felt', summary: 'Wait for the night.', comment: 'The plan continues.' }, { ok: true, plan: { id: 'p1' } })],
    wake: { type: 'researcher', task: 'Find the canon', report: `${'Report line. '.repeat(60)}` },
});

const turn = groupTurns([active, message, passive])[0];

test('a turn digest carries the push, call comments, change lines, owner messages and warnings', () => {
    const digest = buildTurnDigest(turn, { index: 0 });
    assert.equal(digest.key, 'c1');
    assert.equal(digest.turn, 2);
    assert.deepEqual(digest.runIds, ['run_1']);
    assert.match(digest.text, /^TURN 2 \(compressed\) — RP time: 120 min — place: the east corridor/);
    assert.match(digest.text, /This turn took 5 minutes/);
    assert.match(digest.text, /update_roster: \+ Puck, − Rom/);
    assert.match(digest.text, /assess Aria: 0\.35 → barely/);
    assert.match(digest.text, /character_note Rem: \+ "wound on the shoulder"/);
    assert.match(digest.text, /memory write \(important\): She is wounded\./);
    assert.match(digest.text, /set_character_plan Felt: "Wait for the night\."/);
    assert.match(digest.text, /User: Make it darker\./);
    assert.match(digest.text, /Director: Understood\./);
    assert.match(digest.text, /Researcher task: Find the canon/);
    assert.match(digest.text, /the full report is in the archive/);
    assert.match(digest.text, /Warning: the door was locked/);
    assert.match(digest.text, /I need the chance first\./);
    assert.match(digest.text, /Read the shelf\./);
});

test('a turn digest never carries read results or thinking', () => {
    const digest = buildTurnDigest(turn, { index: 0 });
    assert.doesNotMatch(digest.text, /SECRET-THINKING/);
    assert.doesNotMatch(digest.text, /SECRET-READ-RESULT/);
    assert.doesNotMatch(digest.text, /SECRET-LIBRARY-RESULT/);
});

test('the full turn keeps the read results, thinking, form and every cycle', () => {
    const full = renderFullTurns(groupTurns([active, message, passive]));
    assert.match(full, /TURN 2 \(full\)/);
    assert.match(full, /SECRET-THINKING/);
    assert.match(full, /SECRET-READ-RESULT/);
    assert.match(full, /-- cycle: time/);
    assert.match(full, /thinking:/);
    assert.match(full, /form:/);
});

test('the compressed prefix renders stored records in order and is byte-identical on a re-render', () => {
    const records = [buildTurnDigest(turn, { index: 0 }), { text: 'turn 1: message edited by the user' }];
    const first = renderCompressedDigests(records);
    const second = renderCompressedDigests(records.map(record => ({ ...record })));
    assert.equal(first, second);
    assert.match(first, /^EARLIER TURNS \(compressed\):/);
    assert.ok(first.indexOf('TURN 2 (compressed)') < first.indexOf('message edited by the user'));
});
