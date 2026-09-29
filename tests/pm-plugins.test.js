import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginRegistry } from '../libraries/core/pm-plugins.js';
import { evaluateCondition } from '../libraries/core/pm-conditions.js';

test('a plugin needs an id and must provide something', () => {
    const registry = createPluginRegistry();
    assert.throws(() => registry.register({ provides: {} }), /"id" is required/);
    assert.throws(() => registry.register({ id: 'x' }), /provides nothing/);
});

test('a plugin condition works inside the condition evaluator', () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'mood', provides: { conditions: { mood: leaf => leaf.mood === 'angry' } } });
    assert.equal(evaluateCondition({ type: 'mood', mood: 'angry' }, { plugins: registry.conditions() }), true);
    assert.deepEqual(registry.conditionTypes(), ['mood']);
});

test('a plugin that throws is switched off alone, the error is kept and the others keep working', () => {
    const disabled = [];
    const registry = createPluginRegistry({ onDisable: info => disabled.push(info) });
    registry.register({ id: 'bad', provides: { transform: () => { throw new Error('boom'); } } });
    registry.register({ id: 'good', provides: { transform: messages => messages.map(m => ({ ...m, content: m.content.toUpperCase() })) } });
    const out = registry.transform([{ role: 'user', content: 'hi' }], {});
    assert.equal(out[0].content, 'HI');
    assert.deepEqual(disabled, [{ id: 'bad', error: 'boom' }]);
    const list = registry.list();
    assert.equal(list.find(p => p.id === 'bad').enabled, false);
    assert.equal(list.find(p => p.id === 'bad').error, 'boom');
    assert.equal(list.find(p => p.id === 'good').enabled, true);
});

test('macros of a plugin resolve and a failing macro gives an empty text and switches its plugin off', () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'm', provides: { macros: { weather: () => 'rain', broken: () => { throw new Error('x'); } } } });
    const macros = registry.macros();
    assert.equal(macros.weather(), 'rain');
    assert.equal(macros.broken(), '');
    assert.equal(registry.list()[0].enabled, false);
    assert.equal(macros.weather(), '', 'a switched-off plugin gives nothing');
});

test('plugins are swapped on the fly: unregister removes them and re-registering takes the new version at once', () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'p', provides: { macros: { v: () => '1' } } });
    assert.equal(registry.macros().v(), '1');
    registry.register({ id: 'p', provides: { macros: { v: () => '2' } } });
    assert.equal(registry.macros().v(), '2');
    registry.unregister('p');
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.macros().v, undefined);
});

test('a switched-off plugin can be switched on again and its error is cleared', () => {
    const registry = createPluginRegistry();
    registry.register({ id: 'p', provides: { conditions: { c: () => { throw new Error('x'); } } } });
    registry.conditions().c({}, {});
    assert.equal(registry.list()[0].enabled, false);
    assert.equal(registry.setEnabled('p', true), true);
    assert.equal(registry.list()[0].error, null);
    assert.equal(registry.setEnabled('none', true), false);
});
