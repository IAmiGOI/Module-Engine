import test from 'node:test';
import assert from 'node:assert/strict';
import {
    dayOf, dayChanged, shouldReview, unreviewedRows, markReviewed, strongStreaks,
    normalizePromotion, makePetition, appendPetitions, normalizePetitions,
    normalizePrayers, appendPrayers, ensureDayPetitions, decreeNames, renderQueues,
    appendConversation, normalizeConversation, renderConversation, queueSummary,
} from '../libraries/core/decision-counsellor.js';

test('the RP day is a whole number of 1440-minute days; midnight is the boundary', () => {
    assert.equal(dayOf(0), 0);
    assert.equal(dayOf(1439), 0);
    assert.equal(dayOf(1440), 1);
    assert.equal(dayChanged(0, 1), true);
    assert.equal(dayChanged(1, 1), false);
    assert.equal(dayChanged(null, 1), false, 'the first sight of the clock is not a day end');
    assert.equal(dayChanged(1, null), false);
});

test('the Counsellor wakes every N turns and at the end of an RP day; the day wins', () => {
    assert.equal(shouldReview({ turn: 2, lastTurn: 0, everyTurns: 3 }), null);
    assert.equal(shouldReview({ turn: 3, lastTurn: 0, everyTurns: 3 }), 'review');
    assert.equal(shouldReview({ turn: 4, lastTurn: 3, everyTurns: 3 }), null);
    assert.equal(shouldReview({ turn: 6, lastTurn: 3, everyTurns: 3 }), 'review');
    assert.equal(shouldReview({ turn: 0, lastTurn: 0, everyTurns: 3, dayEnded: true }), 'day');
    assert.equal(shouldReview({ turn: 0, lastTurn: 0, everyTurns: 0 }), null, 'a bad interval falls back to 3');
});

test('rows the Counsellor has read are marked once and leave the review scope', () => {
    const ledger = [{ character: 'Lena', turn: 1 }, { character: 'Ram', turn: 1 }];
    assert.equal(unreviewedRows(ledger).length, 2);
    const first = markReviewed(ledger, { at: 100 });
    assert.equal(first.count, 2);
    assert.equal(first.ledger.every(row => row.reviewedAt === 100), true);
    assert.equal(unreviewedRows(first.ledger).length, 0);
    assert.equal(markReviewed(first.ledger, { at: 200 }).count, 0);
});

test('a strong conflict two turns in a row names the character', () => {
    const rows = [
        { character: 'Lena', turn: 1, conflict: { level: 'strong' } },
        { character: 'Lena', turn: 2, conflict: { level: 'strong' } },
        { character: 'Ram', turn: 1, conflict: { level: 'strong' } },
        { character: 'Ram', turn: 2, conflict: { level: 'minor' } },
    ];
    assert.deepEqual(strongStreaks(rows), ['Lena']);
});

test('promotion needs a known level and a reason; words from the table are accepted', () => {
    assert.deepEqual(normalizePromotion({ level: 'Main Cast', reason: 'The user keeps seeking her out.' }), { level: 'main', reason: 'The user keeps seeking her out.' });
    assert.deepEqual(normalizePromotion({ level: 'npc/mass', reason: 'Named once.' }), { level: 'mass', reason: 'Named once.' });
    assert.equal(normalizePromotion({ level: 'main' }), null, 'no reason, no promotion');
    assert.equal(normalizePromotion({ level: 'king', reason: 'x' }), null);
    assert.equal(normalizePromotion('main'), null);
});

test('a petition carries the problem and the excerpt; a day petition is marked for the new day', () => {
    const petition = makePetition({ character: 'Lena', problem: 'She cannot go on in the keep.', excerpt: '- T7 Lena: get out before dawn', turn: 7, at: 10 });
    assert.equal(petition.character, 'Lena');
    assert.equal(petition.status, 'queued');
    assert.equal(petition.to, 'director');
    assert.equal(petition.prepareNewDay, false);
    const day = makePetition({ character: 'Lena', problem: 'The day is over.', day: true, at: 20 });
    assert.equal(day.day, true);
    assert.equal(day.prepareNewDay, true);
    assert.equal(makePetition({ character: 'Lena' }), null, 'a petition without a problem is not kept');
    assert.equal(makePetition({ problem: 'x' }), null);
});

test('the petition queue only grows, drops garbage and is cut to its limit', () => {
    const one = makePetition({ character: 'Lena', problem: 'a', at: 1 });
    const two = makePetition({ character: 'Ram', problem: 'b', at: 2 });
    const queue = appendPetitions([one, null, { character: '' }], [two], { limit: 2 });
    assert.deepEqual(queue.map(item => item.character), ['Lena', 'Ram']);
    assert.equal(appendPetitions(queue, [makePetition({ character: 'Echo', problem: 'c', at: 3 })], { limit: 2 }).length, 2);
    assert.equal(normalizePetitions([{ character: 'Lena' }]).length, 0);
});

test('prayers are one queue for the resolver and the Counsellor, with a status', () => {
    const queue = appendPrayers([{ at: 1, turn: 1, text: 'The gate rule bent.' }], [{ at: 2, turn: 2, text: 'God should know.', source: 'counsellor' }]);
    assert.equal(queue.length, 2);
    assert.equal(queue[0].source, 'resolver');
    assert.equal(queue[0].status, 'queued');
    assert.equal(queue[1].source, 'counsellor');
    assert.equal(normalizePrayers([{ text: '' }]).length, 0);
});

test('at the end of the day every character with a Decree gets a petition, even the quiet ones', () => {
    const rows = [
        { turn: 9, character: 'Lena', wanted: 'get out', conflict: { level: 'strong', why: 'the gate' }, result: 'she stays' },
    ];
    const result = ensureDayPetitions({ entries: [], characters: ['Lena', 'Ram'], rows, turn: 9, at: 50, petitioned: ['lena'] });
    assert.deepEqual(result.added.map(item => item.character), ['Ram']);
    assert.equal(result.added[0].prepareNewDay, true);
    assert.match(result.added[0].excerpt, /no Ledger rows for Ram/);
    const second = ensureDayPetitions({ entries: result.petitions, characters: ['Lena', 'Ram'], rows, turn: 9, at: 50, petitioned: [] });
    assert.equal(second.added.length, 1, 'Lena was petitioned by the model, Ram by the engine');
});

test('only characters with a filled Decree field are counted', () => {
    const state = {
        lena: { name: 'Lena', decree: { 1: ['Freedom above all.'], 3: [] } },
        ram: { name: 'Ram', decree: { 1: [], 2: ['   '] } },
        echo: { name: 'Echo' },
    };
    assert.deepEqual(decreeNames(state), ['Lena']);
});

test('queues render with status, promotion and the new-day mark', () => {
    const text = renderQueues({
        petitions: [makePetition({ character: 'Lena', problem: 'No way out.', day: true, promote: { level: 'main', reason: 'She matters now.' }, at: 1 })],
        prayers: [{ text: 'The gate bent.', at: 2 }],
    });
    assert.match(text, /PETITIONS \(to the Director\)/);
    assert.match(text, /Lena \(queued\): No way out\. \[promote → main: She matters now\.\] \[prepare the new day\]/);
    assert.match(text, /PRAYERS \(to God\)/);
    assert.match(text, /\(queued\) The gate bent\./);
    assert.match(renderQueues({}), /- none/);
});

test('the talk with the user is short, keeps roles and survives garbage', () => {
    let messages = [];
    for (let index = 0; index < 15; index += 1) {
        messages = appendConversation(messages, { role: index % 2 ? 'counsellor' : 'user', text: `line ${index}`, at: index });
    }
    assert.equal(messages.length, 12);
    assert.equal(messages.at(-1).text, 'line 14');
    assert.equal(appendConversation(messages, { text: '' }).length, 12, 'an empty line is not kept');
    assert.deepEqual(normalizeConversation([{ role: 'other', text: 'x' }]), [{ role: 'user', text: 'x', at: 0 }]);
    assert.match(renderConversation(messages), /^Counsellor: line 3/);
});

test('the queue summary counts only what still waits', () => {
    const summary = queueSummary({
        petitions: [makePetition({ character: 'Lena', problem: 'x', at: 1 })],
        prayers: [{ text: 'a', status: 'delivered' }, { text: 'b' }],
    });
    assert.deepEqual(summary.petitions, [{ character: 'Lena', status: 'queued', day: false }]);
    assert.deepEqual(summary.prayers, [{ text: 'b', status: 'queued' }]);
});
