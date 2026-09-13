import test from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '../cores/ui/reactive.js';
import { ColorPicker } from '../libraries/shared/widgets.js';

test('ColorPicker() renders a native <input type="color"> swatch plus a text field, both bound to the SAME signal', () => {
    const color = signal('#112233');
    const node = ColorPicker(color);

    const [swatch, text] = node.children;
    assert.equal(swatch.tag, 'input');
    assert.equal(swatch.props.type, 'color');
    assert.equal(text.tag, 'input');
    assert.equal(text.props.type, 'text');
    assert.equal(text.props.value, color, 'the text field binds the RAW signal, same as TextInput — diff.js resolves it');
});

test('ColorPicker()\'s swatch input defensively falls back to a neutral hex when the signal holds no color yet, instead of handing the browser an invalid value', () => {
    const color = signal(null);
    const node = ColorPicker(color);
    const [swatch] = node.children;

    assert.equal(swatch.props.value(), '#888888');
});

test('ColorPicker() writes back to the signal from EITHER input, and calls onChange with the new value both times', () => {
    const color = signal('#112233');
    const changes = [];
    const node = ColorPicker(color, { onChange: value => changes.push(value) });
    const [swatch, text] = node.children;

    swatch.props['on:input']({ target: { value: '#ff0000' } });
    assert.equal(color(), '#ff0000');

    text.props['on:input']({ target: { value: '#00ff00' } });
    assert.equal(color(), '#00ff00');

    assert.deepEqual(changes, ['#ff0000', '#00ff00']);
});

test('ColorPicker() works with no onChange at all — it is optional, same convention as Toggle()/Select()', () => {
    const color = signal('#112233');
    const node = ColorPicker(color);

    assert.doesNotThrow(() => node.children[0].props['on:input']({ target: { value: '#ffffff' } }));
    assert.equal(color(), '#ffffff');
});
