import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';

const turn = (number, text = `TURN ${number} (compressed)`) => ({ kind: 'turn', turn: number, at: number, text });

function context({
    windowEntries = [turn(1)], plan = { direction: 'the same plan', stages: [], currentStage: 0 },
    notes = {}, knowledgeText = '', roster = ['Aria'], activeBanksText = 'ACTIVE-BANKS', task = 'A new turn has started.',
} = {}) {
    return buildDeciderContext({
        banksText: 'ALL-CHARACTER-BANKS',
        lorebookText: 'THE LOREBOOK',
        arcs: [{ status: 'open', title: 'The escape' }],
        libraryText: 'CHARACTER LIBRARY',
        frozenWindows: [{ text: 'PREVIOUS WINDOW SUMMARY' }],
        plansText: 'LONG PLANS',
        roster,
        activeBanksText,
        windowEntries,
        knowledgeText,
        notes,
        plan,
        task,
    });
}

const indexOf = (context, needle) => context.messages.findIndex(message => String(message.content).includes(needle));

test('blocks 0–8 stay byte-identical between turns; only the window is appended', () => {
    const previous = context({ windowEntries: [turn(1)] });
    const next = context({ windowEntries: [turn(1), turn(2)] });
    const comparison = compareRequests(previous.messages, next.messages);
    assert.deepEqual(previous.messages.slice(1, 10).map(message => message.content), ['ALL-CHARACTER-BANKS', 'THE LOREBOOK', 'ARCS:\n\n- [open] The escape', 'CHARACTER LIBRARY', 'PREVIOUS WINDOWS (summaries):', 'PREVIOUS WINDOW SUMMARY', 'LONG PLANS', 'ACTIVE ROSTER (everyone who can affect the scene right now; the turn lists only those who act):\n\n- Aria', 'ACTIVE-BANKS']);
    assert.equal(comparison.culprit.index, 11, 'the first difference is the new window entry');
});

test('the director plan is always the second message from the end, and the task is the last', () => {
    const built = context({ plan: { direction: 'leave the keep', stages: ['find the key'], currentStage: 0 } });
    assert.equal(built.messages.at(-1).role, 'user');
    assert.match(built.messages.at(-1).content, /A new turn has started/);
    assert.equal(built.messages.at(-2).role, 'system');
    assert.match(built.messages.at(-2).content, /^YOUR PLAN/);
    assert.match(built.messages.at(-2).content, /leave the keep/);
});

test('knowledge and notes change after the window, never inside the protected part', () => {
    const base = context();
    const changed = context({ knowledgeText: 'WHAT CHARACTERS KNOW', notes: { aria: [{ title: 'Goal', text: 'Find the exit.' }] } });
    const comparison = compareRequests(base.messages, changed.messages);
    assert.equal(comparison.culprit.index, indexOf(base, 'TURN 1') + 1, 'the window is before the mutable changes');
    assert.equal(indexOf(changed, 'WHAT CHARACTERS KNOW'), indexOf(changed, 'TURN 1') + 1);
    assert.equal(indexOf(changed, 'CHARACTER NOTES'), indexOf(changed, 'WHAT CHARACTERS KNOW') + 1);
});

test('a roster change never touches the all-character banks, only the active list and its duplicate banks', () => {
    const before = context({ roster: ['Aria'], activeBanksText: 'BANKS Aria' });
    const after = context({ roster: ['Aria', 'Rem'], activeBanksText: 'BANKS Aria Rem' });
    assert.equal(before.messages[1].content, after.messages[1].content, 'block 2 is unchanged');
    const comparison = compareRequests(before.messages, after.messages);
    assert.equal(comparison.culprit.index, indexOf(before, 'ACTIVE ROSTER'), 'the first change is the active roster');
});

test('the custom user block sits before the last two window cycles', () => {
    const entries = [1, 2, 3, 4, 5].map(number => turn(number));
    const built = buildDeciderContext({ windowEntries: entries, directorBlock: 'DIRECTOR BLOCK', plan: { direction: 'p' } });
    const blockIndex = indexOf(built, 'DIRECTOR BLOCK');
    assert.ok(blockIndex > 1);
    assert.equal(built.messages.slice(blockIndex + 1, -2).length, 2, 'two window cycles follow the block');
});

test('the lorebook has no changes block: the frozen head is the whole book', () => {
    const built = buildDeciderContext({ lorebookText: 'THE LOREBOOK frozen', plan: { direction: 'p' } });
    assert.equal(built.messages.some(message => /LOREBOOK CHANGES/.test(message.content)), false);
});
