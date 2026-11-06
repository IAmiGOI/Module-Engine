import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';
import { buildCycleDigest } from '../libraries/core/decision-window.js';

/** Синтетика части 10: окно только дописывается, защищённая часть не меняется. */
const TURNS = 200;
const words = (count, word) => Array.from({ length: count }, () => word).join(' ');
const banksText = `CHARACTER BANKS\n\n${words(1200, 'bank')}`;
const lorebookText = `THE LOREBOOK\n\n${words(1200, 'lore')}`;
const libraryText = `CHARACTER LIBRARY\n\n- Aria (level 1)\n- Rem (level 3)`;
const plansText = `CHARACTER PLANS\n\n${words(300, 'plan')}`;
const activeBanksText = `ACTIVE BANKS\n\n${words(600, 'active')}`;
const frozenWindows = [{ text: `PREVIOUS WINDOWS\n\n${words(400, 'frozen')}` }];

function cycle(number) {
    const comment = words(18, 'comment');
    return {
        id: `cyc_${number}`, runId: `run_${number}`, at: number * 1000, event: 'turn', turn: number, clockMinutes: number * 10,
        toolCalls: [
            { name: 'assess', args: { character: 'Aria', comment: `The chance matters. ${comment}` }, result: { ok: true, probability: 0.4, degree: 'barely' }, comment: `The chance matters. ${comment}` },
            { name: 'character_note', args: { character: 'Rem', op: 'add', text: `note ${number}`, comment: `The writer must know. ${comment}` }, result: { ok: true }, comment: `The writer must know. ${comment}` },
            { name: 'memory', args: { op: 'search', character: 'Rem', query: 'wound', comment: `I check the bank. ${comment}` }, result: { ok: true, records: [{ text: words(40, 'record') }] }, comment: `I check the bank. ${comment}` },
        ],
        form: { resolution: `Resolution ${number}.`, characters: [], scene: { minutes: 5, place: 'the east corridor' }, meta: { place: 'the east corridor' } },
        push: `This turn took 5 minutes.\nPlace: the east corridor.\nResolution: Resolution ${number}.\nRem will wait. ${words(50, 'push')}`,
    };
}

const windowEntries = Array.from({ length: TURNS }, (_, index) => buildCycleDigest(cycle(index + 1), {
    turn: index + 1, userText: `The user acts on turn ${index + 1}. ${words(30, 'action')}`, writerText: `The writer answers turn ${index + 1}. ${words(30, 'prose')}`,
}));

function context(k) {
    return buildDeciderContext({
        banksText, lorebookText, libraryText, plansText, roster: ['Aria', 'Rem'], activeBanksText, frozenWindows,
        windowEntries: windowEntries.slice(0, k),
        knowledgeText: `WHAT CHARACTERS KNOW ${k}`, notes: { rem: [{ character: 'Rem', title: 'wound', text: `${words(80, 'note')} ${k}` }] },
        plan: { direction: `plan ${k}` }, arcs: [{ status: 'open', title: 'The escape' }], task: `A new turn. ${k}`,
    });
}

function measure() {
    let shared = 0; let total = 0; let reRead = 0;
    let previous = context(1);
    for (let k = 2; k <= TURNS; k += 1) {
        const next = context(k);
        const comparison = compareRequests(previous.messages, next.messages);
        shared += comparison.sharedTokens;
        total += comparison.totalTokens;
        reRead += comparison.totalTokens - comparison.sharedTokens;
        previous = next;
    }
    return { ratio: shared / total, reReadPerTurn: reRead / (TURNS - 1) };
}

test('the floating window caches the protected part and everything already appended', () => {
    const measured = measure();
    assert.ok(measured.ratio > 0.85, `the shared prefix is ${measured.ratio}`);
    assert.ok(measured.reReadPerTurn < 8000, `re-read per turn is ${measured.reReadPerTurn}`);
});

test('a compressed window cycle is 200–800 (no push once the writer reply is in) tokens', () => {
    const sizes = windowEntries.slice(0, 50).map(record => record.tokens);
    const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    assert.ok(average >= 200 && average <= 800, `the average window cycle is ${average}`);
});
