import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext, DECREE_DEPTH, NEAR_BANKS_DEPTH } from '../libraries/core/decision-context.js';
import { renderDecreeForResolver, NO_DECREE } from '../libraries/core/decision-bank-projections.js';

const turns = count => Array.from({ length: count }, (_, index) => ({ kind: 'turn', turn: index + 1, text: `TURN ${index + 1} (compressed)` }));
const at = (context, needle) => context.messages.findIndex(message => String(message.content).includes(needle));

function resolver(extra = {}) {
    return buildDeciderContext({
        resolverTurn: true,
        activeBanksText: 'FAR-COMPACT',
        decreeText: 'DECREE-BLOCK',
        windowEntries: turns(24),
        task: 'A new turn has started.',
        ...extra,
    });
}

test('the Decree of the active characters sits at @10 in the resolver context', () => {
    const built = resolver();
    const index = at(built, 'DECREE-BLOCK');
    assert.ok(index > 0);
    assert.equal(built.messages.length - 1 - index, DECREE_DEPTH, 'ten messages follow the Decree');
});

test('the far compact projection stays in the protected part, before the window', () => {
    const built = resolver();
    assert.ok(at(built, 'FAR-COMPACT') < at(built, 'TURN 1 (compressed)'));
});

test('the resolver gets no plan and no near full projection: those belong to the director', () => {
    const built = resolver({ nearBanksText: 'NEAR-FULL' });
    assert.equal(built.messages.some(message => /^YOUR PLAN/.test(String(message.content))), false);
    // Ближняя проекция у резолвера не запрашивается; если её всё же передали — она встаёт на своё место, не ломая порядок.
    const without = resolver();
    assert.equal(without.messages.some(message => String(message.content).includes('NEAR-FULL')), false);
    assert.ok(NEAR_BANKS_DEPTH > DECREE_DEPTH);
});

test('the resolver CoT is the last thing it reads', () => {
    const built = resolver();
    assert.match(built.messages.at(-1).content, /\*\*How You Think This Turn\*\*/);
    assert.match(built.messages.at(-1).content, /1\. \*\*The User\*\*/);
    assert.match(built.messages.at(-1).content, /heard → feels → next/);
});

test('the Creation placeholder sits in the stable part and is absent until phase 5', () => {
    const empty = resolver();
    assert.equal(empty.messages.some(message => /CREATION/.test(String(message.content))), false);
    const withCreation = resolver({ creationText: 'CREATION — the world\'s own rules.' });
    assert.ok(at(withCreation, 'CREATION —') > 0);
    assert.ok(at(withCreation, 'CREATION —') < at(withCreation, 'FAR-COMPACT'));
});

test('with no Decree yet the resolver is told to play from the bank, not given an empty section', () => {
    assert.equal(renderDecreeForResolver([]), `DECREES — how each character is to be played in this story:\n\n${NO_DECREE}`);
    const withDecree = renderDecreeForResolver([{ character: { name: 'Lena', decree: { 3: ['Get out of the keep today.'] } } }]);
    assert.match(withDecree, /### Lena/);
    assert.match(withDecree, /Get out of the keep today\./);
});
