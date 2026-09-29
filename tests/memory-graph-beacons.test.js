import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBeacons, shouldRefreshSticky, meanSetSimilarity, recentQueryText, labelMentioned } from '../cores/memory-graph/beacons.js';

/** Вектор «про тему i» из `dims` измерений с небольшим общим фоном — похоже на сжатые сходства E5. */
const topic = (i, dims = 40) => Array.from({ length: dims }, (_, k) => (k === i ? 1 : 0.15));
const node = (id, topicIndex, extra = {}) => ({ id, label: id, embedding: topic(topicIndex), protectedNode: false, ...extra });

// 30 защищённых центров из «большого WI» (темы 0–29) и несколько обычных нод про конкретные вещи (темы 30–35).
const centers = Array.from({ length: 30 }, (_, i) => node(`center-${i}`, i, { protectedNode: true }));
const facts = [node('Kira', 30), node('Old mine', 31), node('Varekh throne', 32), node('Tavern', 33)];
const pool = [...centers, ...facts];

test('dozens of protected region centers no longer take every beacon slot — the beacons follow what the scene is about', () => {
    const aboutMine = selectBeacons(pool, topic(31), { count: 5 }).map(beacon => beacon.id);
    const aboutTavern = selectBeacons(pool, topic(33), { count: 5 }).map(beacon => beacon.id);

    assert.equal(aboutMine[0], 'Old mine');
    assert.equal(aboutTavern[0], 'Tavern');
    assert.notDeepEqual(aboutMine, aboutTavern);
});

test('a protected node gets only a small bonus and loses to a clearly more relevant ordinary node', () => {
    const picked = selectBeacons([node('hub', 0, { protectedNode: true }), node('fact', 1), node('x', 2), node('y', 3), node('z', 4)], topic(1), { count: 1 });
    assert.equal(picked[0].id, 'fact');
});

test('a node whose name appears in the recent messages is picked even when its embedding is not the closest', () => {
    const picked = selectBeacons(pool, topic(31), { count: 2, queryText: 'Kira glances at the old map.' }).map(beacon => beacon.id);
    assert.ok(picked.includes('Kira'));
    assert.equal(selectBeacons(pool, topic(31), { count: 2, queryText: 'Kira...' }).find(beacon => beacon.id === 'Kira').reason, 'name');
});

test('only nodes that stand out from the rest become beacons, so an unrelated scene does not drag in five random nodes', () => {
    const picked = selectBeacons(pool, topic(31), { count: 5 });
    assert.ok(picked.length < 5, `got ${picked.length}`);
    assert.ok(picked.every(beacon => beacon.score >= 0.5));
});

test('two near-identical nodes do not take two beacon slots', () => {
    const twin = { ...node('Old mine (copy)', 31) };
    const picked = selectBeacons([...pool, twin], topic(31), { count: 5 }).map(beacon => beacon.id);
    assert.ok(!(picked.includes('Old mine') && picked.includes('Old mine (copy)')));
});

test('names match as whole words, in any script, and names shorter than three letters never match', () => {
    assert.equal(labelMentioned('Kira', 'Then kira left.'), true);
    assert.equal(labelMentioned('Kira', 'Kiran left.'), false);
    assert.equal(labelMentioned('Кира', 'Потом Кира ушла.'), true);
    assert.equal(labelMentioned('Al', 'Al is here'), false);
});

const byId = Object.fromEntries(pool.map(item => [item.id, item]));

test('the pinned block is kept while the scene stays the same, and replaced once a fresh set fits the scene clearly better', () => {
    const sticky = { beaconIds: ['Tavern'], turn: 10 };
    assert.equal(shouldRefreshSticky({ sticky, freshIds: ['Tavern'], nodesById: byId, contextEmbedding: topic(33), turn: 11 }), false);
    assert.equal(shouldRefreshSticky({ sticky, freshIds: ['Old mine'], nodesById: byId, contextEmbedding: topic(31), turn: 11 }), true);
});

test('the old ratio rule could never replace a pinned block; the new rule does when the mean similarity rises by the margin', () => {
    const sticky = { beaconIds: ['Tavern'], turn: 10 };
    const stickyMean = meanSetSimilarity(['Tavern'], byId, topic(31));
    const freshMean = meanSetSimilarity(['Old mine'], byId, topic(31));
    assert.ok(freshMean - stickyMean > 0.04, 'a real topic change is far above every stability margin');
    assert.equal(shouldRefreshSticky({ sticky, freshIds: ['Old mine'], nodesById: byId, contextEmbedding: topic(31), stability: 'sticky', turn: 11 }), true);
});

test('a pinned block is refreshed when it is too old, when the clock went back after a reload, or when one of its nodes is gone', () => {
    const base = { freshIds: ['Tavern', 'Kira'], nodesById: byId, contextEmbedding: topic(33) };
    assert.equal(shouldRefreshSticky({ ...base, sticky: { beaconIds: ['Tavern'], turn: 0 }, turn: 12, maxAgeTurns: 12 }), true);
    assert.equal(shouldRefreshSticky({ ...base, sticky: { beaconIds: ['Tavern'], turn: 50 }, turn: 3 }), true);
    assert.equal(shouldRefreshSticky({ ...base, sticky: { beaconIds: ['gone'], turn: 1 }, turn: 2 }), true);
});

test('the retrieval query is the last few messages, not only the newest line', () => {
    const chat = [{ mes: 'one' }, { mes: '<b>The mine</b> collapses.' }, { mes: 'sys', is_system: true }, { mes: 'ok, we go there' }];
    assert.equal(recentQueryText(chat, 2), 'The mine collapses.\nok, we go there');
});
