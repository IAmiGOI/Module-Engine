import test from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../cores/ui/tree.js';

test('h() produces a plain { tag, props, children } node', () => {
    const node = h('button', { class: 'x' }, 'Click me');
    assert.deepEqual(node, { tag: 'button', props: { class: 'x' }, children: ['Click me'] });
});

test('h() defaults props to an empty object when omitted', () => {
    const node = h('div');
    assert.deepEqual(node.props, {});
});

test('h() filters out null/undefined/false children — the show()-style "nothing to render" case', () => {
    const node = h('div', {}, 'a', null, undefined, false, 'b');
    assert.deepEqual(node.children, ['a', 'b']);
});

test('h() flattens nested arrays of children — the list()-style "many rows at once" case', () => {
    const node = h('ul', {}, [h('li', {}, '1'), h('li', {}, '2')], h('li', {}, '3'));
    assert.equal(node.children.length, 3);
});
