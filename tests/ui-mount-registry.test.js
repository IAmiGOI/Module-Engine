import test from 'node:test';
import assert from 'node:assert/strict';
import { createUiMountRegistry } from '../libraries/shared/ui-mount-registry.js';
import { h } from '../cores/ui/tree.js';
import { signal } from '../cores/ui/reactive.js';

function makeStubFinalUi() {
    const patches = [];
    return { apply: patch => patches.push(patch), settled: () => Promise.resolve(), patches };
}

test('mount() renders into a fresh Final UI for that key, tracked by getFinalUi()', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);

    const finalUi = registry.mount('a', h('div', {}, 'hi'));

    assert.equal(registry.getFinalUi('a'), finalUi);
    assert.equal(finalUi.patches[0].type, 'mount');
    assert.equal(registry.isMounted('a'), true);
});

test('mounting the SAME key again disposes the old tree first — no leaked reactivity', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);
    const title = signal('old');
    const firstFinalUi = registry.mount('a', h('div', { title }));
    registry.mount('a', h('div', {}, 'new'));
    firstFinalUi.patches.length = 0;

    title.set('changed');

    assert.equal(firstFinalUi.patches.length, 0, 'the disposed first tree\'s own effect must never fire again');
});

test('two DIFFERENT keys mounted at the same time are fully independent — separate Final UI instances', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);

    const a = registry.mount('a', h('div', {}, 'a'));
    const b = registry.mount('b', h('div', {}, 'b'));

    assert.notEqual(a, b);
    assert.equal(registry.isMounted('a'), true);
    assert.equal(registry.isMounted('b'), true);
});

test('unmount() tears down just that one key, leaving the others mounted', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);
    registry.mount('a', h('div', {}));
    registry.mount('b', h('div', {}));

    registry.unmount('a');

    assert.equal(registry.isMounted('a'), false);
    assert.equal(registry.isMounted('b'), true);
});

test('unmountAll() tears down every mounted key', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);
    registry.mount('a', h('div', {}));
    registry.mount('b', h('div', {}));

    registry.unmountAll();

    assert.equal(registry.isMounted('a'), false);
    assert.equal(registry.isMounted('b'), false);
});

test('unmounting a never-mounted key is a harmless no-op', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);
    assert.doesNotThrow(() => registry.unmount('nothing-here'));
});

test('keys() lists exactly the currently-mounted keys, reflecting mount/unmount as they happen', () => {
    const registry = createUiMountRegistry(makeStubFinalUi);
    registry.mount('a', h('div', {}));
    registry.mount('b', h('div', {}));

    assert.deepEqual(registry.keys().sort(), ['a', 'b']);

    registry.unmount('a');
    assert.deepEqual(registry.keys(), ['b']);
});
