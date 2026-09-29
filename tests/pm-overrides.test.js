import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveParams, setOverride, DEFAULT_OVERRIDES } from '../libraries/core/pm-overrides.js';

const base = { temperature: 0.85, top_p: 0.95, openai_max_tokens: 4000 };
const overrides = { enabled: true, byModel: { gpt: { temperature: 0.5 } }, byCharacter: { Lena: { temperature: 0.7, top_p: 0.9 } }, byChat: { c1: { temperature: 1.1 } } };

test('overrides are off by default and the preset values pass through', () => {
    assert.deepEqual(resolveParams(base, undefined, { char: 'Lena' }), { params: base, sources: [] });
    assert.deepEqual(resolveParams(base, { ...overrides, enabled: false }, { char: 'Lena' }).sources, []);
    assert.equal(DEFAULT_OVERRIDES.enabled, false);
});

test('the chat beats the character and the character beats the model', () => {
    assert.equal(resolveParams(base, overrides, { model: 'gpt' }).params.temperature, 0.5);
    assert.equal(resolveParams(base, overrides, { model: 'gpt', char: 'Lena' }).params.temperature, 0.7);
    const all = resolveParams(base, overrides, { model: 'gpt', char: 'Lena', chatId: 'c1' });
    assert.equal(all.params.temperature, 1.1);
    assert.equal(all.params.top_p, 0.9, 'a value only the character sets stays');
    assert.deepEqual(all.sources, ['model', 'character', 'chat']);
});

test('empty override values do not overwrite the preset', () => {
    assert.equal(resolveParams(base, { enabled: true, byChat: { c: { temperature: '', top_p: null } } }, { chatId: 'c' }).params.temperature, 0.85);
});

test('a layer is written and erased without touching the others', () => {
    let next = setOverride(undefined, 'character', 'Lena', { temperature: 0.4 });
    next = setOverride(next, 'chat', 'c1', { top_k: 10 });
    assert.deepEqual(next.byCharacter, { Lena: { temperature: 0.4 } });
    next = setOverride(next, 'character', 'Lena', {});
    assert.deepEqual(next.byCharacter, {});
    assert.deepEqual(next.byChat, { c1: { top_k: 10 } });
    assert.throws(() => setOverride(next, 'planet', 'x', { a: 1 }), /unknown scope/);
});
