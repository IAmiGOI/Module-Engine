import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverToPrompt } from '../libraries/shared/prompt-contribution.js';

const fakeCall = ({ takes, fail } = {}) => {
    const calls = [];
    const call = async (contract, params) => {
        calls.push([contract, params]);
        if (fail) throw new Error('gate denied');
        return contract === 'promptManager.takesOver' ? { ok: true, value: takes } : { ok: true, value: true };
    };
    return { call, calls };
};
const contribution = { id: 'notebook', content: 'NOTES' };

test('when the Prompt Manager takes over the module contributes and does not touch the chat', async () => {
    const { call, calls } = fakeCall({ takes: true });
    let legacy = 0;
    assert.equal(await deliverToPrompt({ call, contribution, legacy: () => { legacy++; } }), 'contributed');
    assert.equal(legacy, 0);
    assert.deepEqual(calls.map(c => c[0]), ['promptManager.takesOver', 'promptManager.contribute']);
});

test('when the Prompt Manager does not take over the old insertion into the chat runs', async () => {
    const { call } = fakeCall({ takes: false });
    let legacy = 0;
    assert.equal(await deliverToPrompt({ call, contribution, legacy: () => { legacy++; } }), 'legacy');
    assert.equal(legacy, 1);
});

test('empty content still contributes — the module\'s place stays in the preset tree even with nothing to say yet (owner: "модуль должен публиковать своё место даже если он пустой")', async () => {
    const { call, calls } = fakeCall({ takes: true });
    assert.equal(await deliverToPrompt({ call, contribution: { id: 'notebook', content: '  ' } }), 'contributed');
    assert.deepEqual(calls.at(-1), ['promptManager.contribute', { id: 'notebook', content: '  ' }]);
});

test('a broken or missing Prompt Manager never breaks the module: it falls back to the old insertion', async () => {
    const { call } = fakeCall({ fail: true });
    let legacy = 0;
    assert.equal(await deliverToPrompt({ call, contribution, legacy: () => { legacy++; } }), 'legacy');
    assert.equal(legacy, 1);
});
