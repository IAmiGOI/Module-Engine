import test from 'node:test';
import assert from 'node:assert/strict';
import { createContributionRegistry, placeContribution, resetContribution, hasInjectNode } from '../cores/prompt-manager/contributions.js';

const tree = () => [{ type: 'item', block: 'main', enabled: true }, { type: 'item', block: 'chatHistory', enabled: true }, { type: 'item', block: 'post', enabled: true }];
const contribution = defaultPlacement => ({ id: 'graph', name: 'Memory', defaultPlacement });

test('a contribution needs an id and the registry hands the assembler only role and content', () => {
    const registry = createContributionRegistry();
    assert.throws(() => registry.set({ content: 'x' }), /"id" is required/);
    registry.set({ id: 'a', role: 'assistant', content: 'hello', stable: true });
    assert.deepEqual(registry.asContext(), { a: { role: 'assistant', content: 'hello' } });
});

test('a new contribution is placed before the history by default and only once', () => {
    const t = tree();
    assert.equal(placeContribution(t, contribution('before-history')), true);
    assert.deepEqual(t.map(n => n.block ?? n.contribution), ['main', 'graph', 'chatHistory', 'post']);
    assert.equal(placeContribution(t, contribution('before-history')), false);
});

test('the default placement can be after the history, at the top, at the bottom or at a depth', () => {
    const at = placement => { const t = tree(); placeContribution(t, contribution(placement)); return t.map(n => n.block ?? n.contribution).join(','); };
    assert.equal(at('after-history'), 'main,chatHistory,graph,post');
    assert.equal(at('top'), 'graph,main,chatHistory,post');
    assert.equal(at('bottom'), 'main,chatHistory,post,graph');
    const t = tree();
    placeContribution(t, contribution({ mode: 'depth', depth: 3 }));
    assert.deepEqual(t.at(-1).placement, { mode: 'depth', depth: 3, order: 100 });
});

test('the position chosen by the user is kept and the reset button puts the node back to the default', () => {
    const t = tree();
    placeContribution(t, contribution('before-history'));
    const [moved] = t.splice(1, 1);
    t.push(moved); // пользователь унёс вклад в конец
    assert.equal(t.at(-1).contribution, 'graph');
    assert.equal(placeContribution(t, contribution('before-history')), false, 'a known node is never moved by itself');
    resetContribution(t, contribution('before-history'));
    assert.deepEqual(t.map(n => n.block ?? n.contribution), ['main', 'graph', 'chatHistory', 'post']);
});

test('a node inside a group counts as placed', () => {
    const t = [{ type: 'group', children: [{ type: 'inject', contribution: 'graph' }] }];
    assert.equal(hasInjectNode(t, 'graph'), true);
});
