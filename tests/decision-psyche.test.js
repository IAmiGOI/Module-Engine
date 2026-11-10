import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PSYCHOLOGIST_SYSTEM, PSYCHOLOGIST_TASK } from '../libraries/core/decision-prompts.js';
import { createGreatBankLayer } from '../cores/decision/bank-great-layer.js';
import { createFileLayer } from '../cores/decision/files-layer.js';
import { needsPsyche } from '../libraries/core/decision-great-bank.js';
import { renderPsycheForResolver } from '../libraries/core/decision-bank-projections.js';
import { packSnapshot, unpackSnapshot } from '../libraries/core/snapshot-pool.js';

const PSYCHE = 'She is holding a decision back.\nThe fear has deep roots and moves slowly.';

function harness() {
    const memory = new Map();
    const calls = [];
    const call = async (method, params = {}) => {
        if (method === 'storage.chatMemory.get') return memory.get(`${params.namespace}:${params.key}`) ?? params.fallback;
        if (method === 'storage.chatMemory.set') { memory.set(`${params.namespace}:${params.key}`, params.value); return params.value; }
        if (method === 'model.generate') { calls.push(params); return PSYCHE; }
        return null;
    };
    const store = { chatBrief: () => ({ timeline: 'The story starts after the siege.' }) };
    const getSettings = () => ({ director: { workerId: 'director-worker' }, psychologist: { workerId: '' } });
    const layer = createGreatBankLayer({ call, store, banks: { records: () => [] }, publishEvent: () => {}, getSettings });
    return { layer, calls };
}

const ready = (extra = {}) => ({
    name: 'Emilia', importance: 'main', sectionsReady: true,
    material: { 1: ['Black hair, one horn.'] },
    spiritual: { 1: ['Keeps her word.'] },
    ...extra,
});

test('psyche is written for a main/side character once their material and spiritual are ready — never for the user', async () => {
    assert.equal(needsPsyche(ready()), true);
    assert.equal(needsPsyche(ready({ importance: 'temporary' })), false);
    assert.equal(needsPsyche(ready({ sourceKey: 'persona:user' })), false);
    assert.equal(needsPsyche(ready({ psyche: ['already written'] })), false);
    assert.equal(needsPsyche(ready({ spiritual: { 1: [] } })), false, 'spiritual.md must be written too');
    assert.equal(needsPsyche(ready({ sectionsReady: false })), false);

    const { layer, calls } = harness();
    await layer.great.replace({ emilia: ready() });
    const first = await layer.ensurePsyche();
    assert.deepEqual(first.written, ['Emilia']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoningMode, 'disabled');
    assert.equal(calls[0].temperature, 0);
    assert.match(calls[0].prompt, /Black hair, one horn\./);
    assert.match(calls[0].prompt, /after the siege/);
    assert.deepEqual((await layer.great.load()).emilia.psyche, ['She is holding a decision back.', 'The fear has deep roots and moves slowly.']);

    const again = await layer.ensurePsyche();
    assert.deepEqual(again, { skipped: true, written: [] });
    assert.equal(calls.length, 1, 'the file is written once');
});

test('the user\'s character never gets a psyche, and the Resolver gets the psyches of the scene only', async () => {
    const { layer, calls } = harness();
    await layer.great.replace({ sasha: ready({ name: 'Sasha', sourceKey: 'persona:user' }) });
    assert.deepEqual(await layer.ensurePsyche(), { skipped: true, written: [] });
    assert.equal(calls.length, 0);

    const out = renderPsycheForResolver([
        { character: { ...ready({ name: 'Emilia' }), psyche: ['Holds on to an old debt.'] } },
        { character: { ...ready({ name: 'Sasha', sourceKey: 'persona:user' }), psyche: ['user psyche'] } },
        { character: { ...ready({ name: 'Otto' }), psyche: ['elsewhere'] } },
    ], { names: ['Emilia', 'Sasha'] });
    assert.match(out, /HOW THEIR MIND MOVES/);
    assert.match(out, /Holds on to an old debt/);
    assert.doesNotMatch(out, /user psyche|elsewhere/);
});

test('the Resolver block comes from decreeFor, and the Director may read psyche.md but not edit or create it', async () => {
    const { layer } = harness();
    await layer.great.replace({
        emilia: ready({ decree: { 1: ['Protect the town.'] }, psyche: ['She is holding a decision back.', 'The fear has deep roots and moves slowly.'] }),
    });
    const block = await layer.decreeFor(['Emilia']);
    assert.match(block, /HOW THEIR MIND MOVES/);
    assert.match(block, /deep roots and moves slowly/);

    const files = createFileLayer({ banks: { great: layer.great } });
    const read = await files.read('Characters/Emilia/psyche.md');
    assert.equal(read.ok, true);
    assert.match(read.text, /holding a decision back/);

    const edit = await files.edit({ edits: [{ path: 'Characters/Emilia/psyche.md', old: 'holding a decision back', new: 'nothing holds her' }], comment: 'Try it.' });
    assert.equal(edit.files[0].ok, false);
    assert.match(edit.files[0].error, /written by the Psychologist/);
    const create = await files.create({ path: 'Characters/Emilia/psyche.md', text: 'New psyche.', comment: 'Try it.' });
    assert.equal(create.ok, false);
    assert.match(create.error, /written by the Psychologist/);
});

test('the psychologist prompts are PROMPTS.md section 45 word for word', () => {
    const doc = readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');
    let at = doc.indexOf('## 45. Психолог');
    const blocks = [];
    for (let index = 0; index < 2; index += 1) {
        const fence = doc.indexOf('```text', at);
        const body = doc.indexOf('\n', fence) + 1;
        const end = doc.indexOf('```', body);
        blocks.push(doc.slice(body, end).trimEnd());
        at = end + 3;
    }
    assert.deepEqual(blocks, [PSYCHOLOGIST_SYSTEM, PSYCHOLOGIST_TASK]);
});

test('psyche.md rides in the snapshot pool as part of the character record', () => {
    const pool = {};
    const snapshot = { greatBank: { emilia: { name: 'Emilia', material: { 1: ['Black hair.'] }, psyche: ['She is holding a decision back.'] } } };
    const packed = packSnapshot(pool, snapshot);
    assert.ok(packed.greatBank.emilia.psyche.$ref, 'psyche is packed by reference like the other parts');
    assert.deepEqual(unpackSnapshot(pool, packed), snapshot);
});
