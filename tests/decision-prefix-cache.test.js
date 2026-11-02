import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';
import { buildTurnDigest, groupTurns } from '../libraries/core/decision-turn-digest.js';
import { DIRECTOR_SYSTEM } from '../libraries/core/decision-prompts.js';

/** Синтетика части 9: 200 ходов, записи по 300–800 токенов, хвост и два полных хода. */
const TURNS = 200;
const words = (count, word) => Array.from({ length: count }, () => word).join(' ');
const banksText = `CHARACTER BANKS\n\n${words(1200, 'bank')}`;
const lorebookText = `THE LOREBOOK\n\n${words(1200, 'lore')}`;
const summaries = [{ startIndex: 1, endIndex: 9, text: words(500, 'summary') }];

function cycle(number) {
    const comment = words(18, 'comment');
    return {
        id: `cyc_${number}`, runId: `run_${number}`, at: number * 1000, event: 'turn', turn: number, clockMinutes: number * 10,
        messages: [
            { role: 'user', content: `The user acts on turn ${number}. ${words(20, 'action')}` },
            { role: 'assistant', content: `The director thinks about turn ${number}. ${words(30, 'reason')}` },
            { role: 'tool', content: `tool result ${words(20, 'result')}` },
        ],
        toolCalls: [
            { name: 'assess', args: { character: 'Aria', comment: `The chance matters. ${comment}` }, result: { ok: true, probability: 0.4, degree: 'barely' }, comment: `The chance matters. ${comment}` },
            { name: 'character_note', args: { character: 'Rem', op: 'add', text: `note ${number}`, comment: `The writer must know. ${comment}` }, result: { ok: true }, comment: `The writer must know. ${comment}` },
            { name: 'memory', args: { op: 'search', character: 'Rem', query: 'wound', comment: `I check the bank. ${comment}` }, result: { ok: true, records: [{ text: words(40, 'record') }] }, comment: `I check the bank. ${comment}` },
            { name: 'library', args: { character: 'Rem', comment: `I read the shelf. ${comment}` }, result: { ok: true, characters: [{ name: 'Rem', level: 2 }] }, comment: `I read the shelf. ${comment}` },
            { name: 'set_character_plan', args: { character: 'Rem', summary: `Wait for the night. ${comment}`, comment: `Her plan continues. ${comment}` }, result: { ok: true }, comment: `Her plan continues. ${comment}` },
        ],
        thinking: `thinking ${number} ${words(60, 'thought')}`,
        form: { resolution: `Resolution ${number}.`, characters: [], scene: { minutes: 5, place: 'the east corridor' }, meta: { place: 'the east corridor' } },
        push: `This turn took 5 minutes.\nPlace: the east corridor.\nResolution: Resolution ${number}.\nThe user's action: it works.\nRem will wait. ${words(35, 'push')}`,
    };
}

const cycles = Array.from({ length: TURNS }, (_, index) => cycle(index + 1));
const turns = groupTurns(cycles);
const digests = turns.slice(0, -2).map((turn, index) => buildTurnDigest(turn, { index }));

function history(k) {
    const chat = [];
    for (let index = 0; index < 10; index += 1) {
        chat.push({ mes: `user ${k - index} ${words(10, 'story')}`, is_user: true });
        chat.push({ mes: `character ${k - index} ${words(15, 'prose')}` });
    }
    return chat;
}

function after(k) {
    return buildDeciderContext({
        banksText, lorebookText, digests: digests.slice(0, Math.max(0, k - 2)), turns: turns.slice(Math.max(0, k - 2), k),
        plan: { direction: `plan ${k}` }, arcs: [{ status: 'open', title: `The escape ${k}` }],
        notes: { rem: [{ character: 'Rem', title: 'wound', text: `${words(80, 'note')} ${k}` }] },
        roster: ['Aria', 'Rem'], libraryText: `CHARACTER LIBRARY ${k} ${words(120, 'library')}`,
        bankText: `MEMORY BANK INDEX ${k}`, researchText: `RESEARCH ${k}`,
        summaries: summaries.map(record => ({ ...record, text: `${record.text} ${k}` })), chat: history(k), task: `A new turn. ${k}`,
    });
}

function before(k) {
    const runs = cycles.slice(0, k).map(record => `Turn #${record.turn}\nDecision: resolution ${record.turn}\nReasoning: ${words(50, 'reasoning')}`);
    const thoughts = cycles.slice(Math.max(0, k - 3), k).map(record => ({ role: 'system', content: `YOUR THINKING FROM CYCLE ${record.at}:\n\n${record.thinking}` }));
    const story = history(k).flatMap(entry => (entry.is_user ? [{ role: 'user', content: entry.mes }] : [{ role: 'assistant', content: entry.mes }]));
    const state = [
        `LONG-TERM SUMMARIES\n\n${words(500, 'summary')} ${k}`, `YOUR PLAN\n\nplan ${k}`, `ARCS\n\nThe escape ${k}`,
        `CHARACTER NOTES\n\n${words(400, 'note')} ${k}`, banksText, `CHARACTER LIBRARY ${k} ${words(120, 'library')}`,
        `MEMORY BANK INDEX ${k}`, `RESEARCH ${k}`, `ACTIVE ROSTER\n\n- Aria\n- Rem`, `PAST DIRECTOR RUNS\n\n${runs.join('\n\n')}`,
    ];
    return { messages: [
        { role: 'system', content: DIRECTOR_SYSTEM }, { role: 'system', content: lorebookText },
        ...state.map(content => ({ role: 'system', content })), ...thoughts, ...story, { role: 'user', content: `A new turn. ${k}` },
    ] };
}

function measure(make) {
    let shared = 0; let total = 0; let reRead = 0;
    let previous = make(1);
    for (let k = 2; k <= TURNS; k += 1) {
        const next = make(k);
        const comparison = compareRequests(previous.messages, next.messages);
        shared += comparison.sharedTokens;
        total += comparison.totalTokens;
        reRead += comparison.totalTokens - comparison.sharedTokens;
        previous = next;
    }
    return { ratio: shared / total, reReadPerTurn: reRead / (TURNS - 1) };
}

test('the compressed prefix caches the immutable head and everything already appended, unlike the old order', () => {
    const beforeScheme = measure(before);
    const afterScheme = measure(after);
    assert.ok(afterScheme.ratio > 0.85, `the new shared prefix is ${afterScheme.ratio}`);
    assert.ok(beforeScheme.ratio < 0.3, `the old shared prefix is ${beforeScheme.ratio}`);
    assert.ok(afterScheme.reReadPerTurn < beforeScheme.reReadPerTurn / 2, `${afterScheme.reReadPerTurn} < ${beforeScheme.reReadPerTurn} / 2`);
});

test('a typical compressed turn is 300–800 tokens and 198 of them stay under the arc threshold', () => {
    const sizes = digests.map(record => record.tokens);
    const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    const total = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(average >= 300 && average <= 800, `the average digest is ${average}`);
    assert.ok(total < 100000, `198 digests take ${total} tokens`);
});
