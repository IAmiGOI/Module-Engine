import test from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '../cores/ui/reactive.js';
import { h } from '../cores/ui/tree.js';
import { render } from '../cores/ui/diff.js';

test('the root mount emits exactly one "mount" patch, resolving signals, with an empty children shell', () => {
    const title = signal('hello');
    const patches = [];
    render(h('div', { title }), patch => patches.push(patch));

    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0], { type: 'mount', path: [], node: { tag: 'div', props: { title: 'hello' }, children: [] } });
});

test('a root prop signal change emits "setProps" at the root path', () => {
    const title = signal('a');
    const patches = [];
    render(h('div', { title }), patch => patches.push(patch));

    title.set('b');

    assert.deepEqual(patches.at(-1), { type: 'setProps', path: [], props: { title: 'b' } });
});

test('a static text child is mounted at its own key path, addressed by slot position when it has no explicit key', () => {
    const patches = [];
    render(h('div', {}, 'hello'), patch => patches.push(patch));

    assert.deepEqual(patches[1], { type: 'insert', path: [{ key: '0' }], node: { text: 'hello' } });
});

test('an element child with its own reactive prop updates ONLY at its own path — no reorder/remount ripple on its siblings or parent', () => {
    const childTitle = signal('a');
    const patches = [];
    render(
        h('div', {},
            h('span', { key: 'left' }, 'static'),
            h('span', { key: 'right', title: childTitle }),
        ),
        patch => patches.push(patch),
    );
    patches.length = 0; // only care about what happens AFTER the initial mount

    childTitle.set('b');

    assert.deepEqual(patches, [{ type: 'setProps', path: [{ key: 'right' }], props: { title: 'b' } }]);
});

test('a child\'s own prop signal change never re-runs the parent\'s children reconciliation — no reorder/insert/remove noise', () => {
    const childTitle = signal('a');
    const patches = [];
    render(h('ul', {}, h('li', { key: 'x', title: childTitle })), patch => patches.push(patch));
    patches.length = 0;

    childTitle.set('b');

    assert.equal(patches.length, 1, 'exactly the one setProps for the changed child — nothing from the parent reconciliation');
    assert.equal(patches[0].type, 'setProps');
});

test('reordering keyed items emits ONE "reorder" patch with the new key order — no per-item prop/replace cascade for items that only moved', () => {
    const items = signal([
        h('li', { key: 'a' }, 'A'),
        h('li', { key: 'b' }, 'B'),
        h('li', { key: 'c' }, 'C'),
    ]);
    const patches = [];
    render(h('ul', {}, items), patch => patches.push(patch));
    patches.length = 0;

    items.set([
        h('li', { key: 'c' }, 'C'),
        h('li', { key: 'a' }, 'A'),
        h('li', { key: 'b' }, 'B'),
    ]); // rotate right by one — same 3 items, no adds/removes, pure reorder

    assert.deepEqual(patches, [{ type: 'reorder', path: [], order: ['c', 'a', 'b'] }]);
});

test('adding a new keyed item emits "insert" for it plus a "reorder" reflecting the final order', () => {
    const items = signal([h('li', { key: 'a' }, 'A')]);
    const patches = [];
    render(h('ul', {}, items), patch => patches.push(patch));
    patches.length = 0;

    items.set([h('li', { key: 'z' }, 'Z'), h('li', { key: 'a' }, 'A')]); // new item inserted at the FRONT

    const insertPatch = patches.find(p => p.type === 'insert');
    assert.deepEqual(insertPatch, { type: 'insert', path: [{ key: 'z' }], node: { tag: 'li', props: {}, children: [] } });
    assert.deepEqual(patches.find(p => p.type === 'reorder'), { type: 'reorder', path: [], order: ['z', 'a'] });
});

test('removing a keyed item emits "remove" for it, and its own scope\'s prop signal no longer affects anything afterward', () => {
    const itemTitle = signal('t1');
    const items = signal([h('li', { key: 'a', title: itemTitle }), h('li', { key: 'b' }, 'B')]);
    const patches = [];
    render(h('ul', {}, items), patch => patches.push(patch));
    patches.length = 0;

    items.set([h('li', { key: 'b' }, 'B')]);
    assert.ok(patches.some(p => p.type === 'remove' && p.path.at(-1).key === 'a'));

    patches.length = 0;
    itemTitle.set('t2'); // the removed item's own signal — its scope must be disposed

    assert.equal(patches.length, 0, 'a disposed child\'s own signal must never emit another patch');
});

test('a fresh render() call with the SAME data as a previous one produces the exact same mount patch — a basic determinism sanity check', () => {
    const build = () => h('div', { class: 'x' }, h('span', { key: 's' }, 'hi'));
    const patchesA = [];
    render(build(), p => patchesA.push(p));
    const patchesB = [];
    render(build(), p => patchesB.push(p));

    assert.deepEqual(patchesA, patchesB);
});

test('dispose() (render()\'s own return value) stops the root AND every nested child scope permanently', () => {
    const rootProp = signal('a');
    const childProp = signal('x');
    const patches = [];
    const dispose = render(h('div', { rootProp }, h('span', { key: 's', childProp })), patch => patches.push(patch));
    patches.length = 0;

    dispose();
    rootProp.set('b');
    childProp.set('y');

    assert.equal(patches.length, 0, 'neither the root\'s nor the nested child\'s signal must emit anything after dispose()');
});

test('a deeply nested grandchild\'s own prop signal updates only its own path — untouched by any ancestor', () => {
    const deep = signal('start');
    const patches = [];
    render(
        h('div', {},
            h('section', { key: 'mid' },
                h('span', { key: 'leaf', deep }),
            ),
        ),
        patch => patches.push(patch),
    );
    patches.length = 0;

    deep.set('changed');

    assert.deepEqual(patches, [{ type: 'setProps', path: [{ key: 'mid' }, { key: 'leaf' }], props: { deep: 'changed' } }]);
});

// Регрессия на живой баг с панели движка: бейдж "0 events seen" не обновлялся
// никогда, хотя соседний список (дети которого приходили из сигнала)
// перерисовывался нормально. Дети пережившей ноды снимались один раз при
// монтировании и больше не перечитывались, поэтому новый СТАТИЧЕСКИЙ текст
// внутри неё был невидим.
test('a survived element re-fed with unchanged props but a NEW static text child still updates that text', () => {
    const rows = signal([h('span', { key: 'badge', class: 'b' }, '0 events seen')]);
    const patches = [];
    render(h('div', {}, rows), patch => patches.push(patch));
    patches.length = 0;

    rows.set([h('span', { key: 'badge', class: 'b' }, '1 event seen')]);

    assert.deepEqual(patches, [
        { type: 'replace', path: [{ key: 'badge' }, { key: '0' }], node: { text: '1 event seen' } },
    ]);
});

test('re-feeding a survived element an IDENTICAL freshly-built subtree emits nothing at all', () => {
    const build = () => h('section', { key: 'card', class: 'c' }, h('span', { key: 'title' }, 'Engine'), 'idle');
    const rows = signal([build()]);
    const patches = [];
    render(h('div', {}, rows), patch => patches.push(patch));
    patches.length = 0;

    rows.set([build()]);

    assert.deepEqual(patches, [], 'same props, same text — nothing changed, so no patch may be emitted');
});
