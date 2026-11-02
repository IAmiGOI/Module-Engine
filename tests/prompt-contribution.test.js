import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverToPrompt } from '../libraries/shared/prompt-contribution.js';

test('with the Prompt Manager gone, every contribution takes the old chat insertion path and says so', async () => {
    let legacy = 0;
    const result = await deliverToPrompt({ call: async () => ({ ok: false }), contribution: { id: 'notebook', content: 'NOTES' }, legacy: () => { legacy++; } });
    assert.equal(result, 'legacy');
    assert.equal(legacy, 1);
});

test('a missing legacy insertion is not an error — the helper never throws', async () => {
    assert.equal(await deliverToPrompt({}), 'legacy');
    assert.equal(await deliverToPrompt(), 'legacy');
});
