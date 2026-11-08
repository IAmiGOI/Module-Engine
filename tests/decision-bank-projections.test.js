import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext, buildWriterContext, NEAR_BANKS_DEPTH } from '../libraries/core/decision-context.js';
import { createBoundary, BOUNDARY_BANKS_FORMAT } from '../libraries/core/decision-window.js';

const turns = count => Array.from({ length: count }, (_, index) => ({ kind: 'turn', turn: index + 1, text: `TURN ${index + 1} (compressed)\nUser: step ${index + 1}.` }));

function director(extra = {}) {
    return buildDeciderContext({
        plan: { direction: 'keep going', stages: [], currentStage: 0 },
        roster: ['Aria'],
        activeBanksText: 'FAR-COMPACT',
        nearBanksText: 'NEAR-FULL',
        windowEntries: turns(24),
        task: 'A new turn has started.',
        ...extra,
    });
}

const at = (context, needle) => context.messages.findIndex(message => String(message.content).includes(needle));

test('the far compact projection is in the protected part, exactly where the active banks were', () => {
    const built = director();
    assert.ok(at(built, 'FAR-COMPACT') > 0);
    assert.ok(at(built, 'FAR-COMPACT') < at(built, 'TURN 1 (compressed)'), 'the far projection is before the window');
});

test('the near full projection sits at @20 from the end, so edits are seen at once', () => {
    const built = director();
    const index = at(built, 'NEAR-FULL');
    // @20 — двадцать сообщений идут ЗА блоком: окно и изменяемый хвост остаются ближе к заданию.
    assert.equal(built.messages.length - 1 - index, NEAR_BANKS_DEPTH, 'twenty messages follow it');
    assert.match(built.messages.at(-2).content, /^YOUR PLAN/, 'the plan stays second from the end');
    assert.equal(built.messages.at(-1).role, 'user');
});

test('the near projection changes after an edit without touching the protected prefix', () => {
    const before = director({ nearBanksText: 'NEAR-FULL old' });
    const after = director({ nearBanksText: 'NEAR-FULL new' });
    assert.equal(before.messages[2].content, after.messages[2].content, 'the far projection is untouched');
    const firstDifference = before.messages.findIndex((message, index) => message.content !== after.messages[index]?.content);
    assert.equal(firstDifference, at(before, 'NEAR-FULL old'));
});

test('the writer gets active banks in the cacheable prefix and the Decrees right before the push', () => {
    const built = buildWriterContext({
        chat: [{ mes: 'Go.', is_user: true }], decision: 'PUSH-TEXT', banksText: 'WRITER-BANKS', decreeText: 'DECREES-TEXT',
    });
    const history = built.messages.findIndex(message => message.role === 'user');
    assert.ok(at(built, 'WRITER-BANKS') < history, 'banks stay in the cached prefix');
    assert.ok(at(built, 'DECREES-TEXT') > history, 'Decrees are after the history');
    assert.equal(built.messages.at(-1).role, 'system');
    assert.match(built.messages.at(-1).content, /PUSH-TEXT/);
    assert.ok(at(built, 'DECREES-TEXT') < built.messages.length - 1, 'Decrees come just before the push');
});

test('without Decrees the writer block is absent, not empty', () => {
    const built = buildWriterContext({ chat: [{ mes: 'Go.', is_user: true }], decision: 'PUSH-TEXT' });
    assert.equal(built.messages.some(message => /^DECREES/.test(String(message.content))), false);
});

test('the window boundary records its banks format, so a boundary of the old format is re-taken once', () => {
    const fresh = createBoundary({ roster: ['Aria'], activeBanksText: 'FAR', banks: BOUNDARY_BANKS_FORMAT, at: 1 });
    assert.equal(fresh.banks, 'great-bank');
    assert.equal(fresh.activeBanksText, 'FAR');
    const legacy = createBoundary({ roster: ['Aria'], activeBanksText: 'OLD CARDS' });
    assert.equal(legacy.banks, '', 'a boundary taken before the Great Bank carries no format');
});

test('in a short context the near projection still comes after the system prompt', () => {
    const built = buildDeciderContext({ nearBanksText: 'NEAR-FULL', plan: { direction: 'p' }, task: 'Go.' });
    assert.equal(built.messages[0].role, 'system');
    assert.match(built.messages[0].content, /You are the Resolver/);
    assert.ok(at(built, 'NEAR-FULL') >= 1);
    assert.equal(built.messages.at(-1).role, 'user');
});
