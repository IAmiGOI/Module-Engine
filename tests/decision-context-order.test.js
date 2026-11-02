import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';
import { groupTurns } from '../libraries/core/decision-turn-digest.js';

const cycle = number => ({
    event: 'turn', turn: number, at: number,
    messages: [{ role: 'user', content: `user ${number}` }],
    toolCalls: [], form: { resolution: `resolution ${number}` }, push: `push ${number}`,
});

function context({ chat, plan = 'the same plan', notes = {}, task = 'A new turn has started.' }) {
    return buildDeciderContext({
        banksText: 'ALL-CHARACTER-BANKS',
        lorebookText: 'THE LOREBOOK',
        digests: [{ text: 'TURN 1 (compressed) — the keep is behind them.' }],
        turns: groupTurns([cycle(2)]),
        plan: { direction: plan, stages: [], currentStage: 0 },
        notes,
        chat,
        task,
    });
}

test('two adjacent turns with unchanged banks, lorebook and turns share the whole immutable prefix, up to the history', () => {
    const previous = context({ chat: [{ mes: 'older', is_user: true }] });
    const next = context({ chat: [{ mes: 'newer', is_user: true }] });
    const comparison = compareRequests(previous.messages, next.messages);
    assert.equal(comparison.sharedMessages, 6, 'system, banks, lorebook, compressed, the full turn and the plan all match');
    assert.equal(comparison.culprit.index, 6, 'the first difference is the history, not the mutable state');
});

test('a changed plan or notes does not touch the prefix before it', () => {
    const base = context({ chat: [{ mes: 'same', is_user: true }] });
    const changedPlan = context({ chat: [{ mes: 'same', is_user: true }], plan: 'a different plan' });
    const planComparison = compareRequests(base.messages, changedPlan.messages);
    assert.equal(planComparison.culprit.index, 5, 'the plan is the first mutable part after the full turn');
    assert.match(base.messages[5].content, /the same plan/);
    assert.match(changedPlan.messages[5].content, /a different plan/);

    const changedNotes = context({ chat: [{ mes: 'same', is_user: true }], notes: { aria: [{ title: 'Goal', text: 'Find the exit.' }] } });
    const notesComparison = compareRequests(base.messages, changedNotes.messages);
    assert.equal(notesComparison.culprit.index, 6, 'notes come after the plan and arcs; the history moves once they exist');
});

test('the custom user block still sits two cycles from the end of the history, after the mutable state', () => {
    const chat = [];
    for (let index = 0; index < 5; index += 1) chat.push({ mes: `user ${index}`, is_user: true }, { mes: `assistant ${index}` });
    const built = buildDeciderContext({
        banksText: 'BANKS', lorebookText: 'LORE', digests: [{ text: 'TURN 1 (compressed)' }],
        turns: groupTurns([cycle(2)]), directorBlock: 'DIRECTOR BLOCK', chat,
    });
    const index = built.messages.findIndex(message => message.content === 'DIRECTOR BLOCK');
    assert.ok(index > 3, 'the block is not in the immutable prefix');
    assert.equal(built.messages.slice(index + 1, -1).length, 4, 'the block keeps its two-cycle depth');
});
