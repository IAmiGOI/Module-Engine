import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addRecord, recordsFor, bankTokens, searchRecords, ordinaryRecords, canCompress,
    buildCompressionPrompt, replaceOrdinaryWithSummary, bankIndex,
} from '../libraries/core/decision-bank.js';

const now = () => 1000;
const rid = () => 'x';

test('records are appended per character, with plan id, importance and a token count', () => {
    const first = addRecord({}, { character: 'Lena', planId: 'p1', text: 'She found the key.', now, rid });
    assert.equal(first.ok, true);
    const bank = addRecord(first.bank, { character: 'Lena', text: 'The guard rotates at dawn.', important: true, now, rid }).bank;
    assert.equal(recordsFor(bank, 'lena').length, 2);
    assert.equal(recordsFor(bank, 'lena')[0].planId, 'p1');
    assert.equal(recordsFor(bank, 'lena')[1].important, true);
    assert.ok(bankTokens(bank, 'Lena') > 0);
});

test('ordinary records exclude important ones from compression forever', () => {
    const bank = addRecord(addRecord({}, { character: 'Lena', text: 'ordinary', now, rid }).bank, { character: 'Lena', text: 'promise', important: true, now, rid }).bank;
    assert.deepEqual(ordinaryRecords(bank, 'Lena').map(record => record.text), ['ordinary']);
    assert.equal(canCompress(bank, 'Lena', 1), true);
    assert.equal(canCompress({ lena: [{ important: true, text: 'only this', tokens: 999 }] }, 'Lena', 1), false);
});

test('compression replaces only ordinary records and keeps important ones untouched', () => {
    const bank = addRecord(addRecord({}, { character: 'Lena', text: 'ordinary', now, rid }).bank, { character: 'Lena', text: 'promise', important: true, now, rid }).bank;
    const replaced = replaceOrdinaryWithSummary(bank, { character: 'Lena', summary: 'compressed', covers: ['mem_x'], now, rid });
    assert.equal(replaced.ok, true);
    assert.deepEqual(recordsFor(replaced.bank, 'Lena').map(record => record.text).sort(), ['compressed', 'promise']);
    assert.equal(recordsFor(replaced.bank, 'Lena').find(record => record.text === 'promise').important, true);
    assert.equal(recordsFor(replaced.bank, 'Lena').find(record => record.text === 'compressed').compressed, true);
});

test('the compression prompt carries the ordinary texts and the index stays a compact index', () => {
    const prompt = buildCompressionPrompt([{ text: 'one' }, { text: 'two' }]);
    assert.match(prompt, /- one/);
    assert.match(prompt, /- two/);
    const bank = addRecord({}, { character: 'Lena', text: 'She found the key.', now, rid }).bank;
    assert.match(bankIndex(bank), /lena: 1 record/);
});

test('search is plain text search, not a model call', () => {
    const bank = addRecord(addRecord({}, { character: 'Lena', text: 'She found the key.', now, rid }).bank, { character: 'Lena', text: 'The guard rotates at dawn.', now, rid }).bank;
    assert.deepEqual(searchRecords(bank, { character: 'Lena', query: 'guard' }).map(record => record.text), ['The guard rotates at dawn.']);
    assert.equal(searchRecords(bank, { character: 'Lena', query: 'nothing' }).length, 0);
});
