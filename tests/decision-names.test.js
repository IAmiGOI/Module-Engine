import test from 'node:test';
import assert from 'node:assert/strict';
import { listNames, issueName, nameKey, formatFullName, CULTURES, GENDERS, SETTINGS } from '../libraries/core/decision-names.js';

test('every gender, culture and setting has at least 80 unique names', () => {
    for (const culture of CULTURES) {
        for (const setting of SETTINGS) {
            for (const gender of GENDERS) {
                const names = listNames({ culture, setting, gender });
                assert.ok(names.length >= 80, `${culture}/${setting}/${gender} has ${names.length}`);
                assert.equal(new Set(names.map(item => item.name)).size, names.length, `${culture}/${setting}/${gender} names are unique`);
                assert.ok(names.every(item => item.surname), `${culture}/${setting}/${gender} has surnames`);
            }
        }
    }
});

test('Chinese and Japanese full names put the surname first; European names put it last', () => {
    assert.equal(formatFullName({ name: 'Wei', surname: 'Wang', order: 'surname-first' }), 'Wang Wei');
    assert.equal(formatFullName({ name: 'Anna', surname: 'Müller', order: 'given-first' }), 'Anna Müller');
});

test('an issued name is not issued again, and the same key is stable', () => {
    const first = issueName({ issued: [], gender: 'female', culture: 'germany', setting: 'modern', rng: () => 0 });
    assert.equal(first.ok, true);
    const key = nameKey({ culture: 'germany', setting: 'modern', gender: 'female', name: first.name, surname: first.surname });
    assert.equal(first.key, key);
    const second = issueName({ issued: [key], gender: 'female', culture: 'germany', setting: 'modern', rng: () => 0 });
    assert.equal(second.ok, true);
    assert.notEqual(second.key, key);
});

test('when every name for a cell is issued, the answer is an honest refusal — no repeats', () => {
    const all = listNames({ culture: 'poland', setting: 'fictional', gender: 'male' });
    const issued = all.map(item => nameKey({ culture: 'poland', setting: 'fictional', gender: 'male', ...item }));
    const result = issueName({ issued, gender: 'male', culture: 'poland', setting: 'fictional' });
    assert.equal(result.ok, false);
    assert.match(result.error, /No unused/);
});

test('unknown gender, culture or setting yields no names instead of an invented one', () => {
    assert.deepEqual(listNames({ culture: 'atlantis', setting: 'modern', gender: 'male' }), []);
    assert.deepEqual(listNames({ culture: 'germany', setting: 'space', gender: 'male' }), []);
    assert.deepEqual(listNames({ culture: 'germany', setting: 'modern', gender: 'other' }), []);
    assert.equal(issueName({ gender: 'male', culture: 'atlantis', setting: 'modern' }).ok, false);
});
