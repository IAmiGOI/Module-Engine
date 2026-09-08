import test from 'node:test';
import assert from 'node:assert/strict';
import { similarity, pickWeighted, selectTrack, shouldSwitch } from '../libraries/core/track-selection.js';

// Детерминированные векторы: скалярное произведение нормированных векторов —
// честная косинусная близость. `vec(a)` — единичный вектор оси a; комбинируя
// оси, получаем любые нужные близости.
const vec = (...axes) => {
    const v = new Array(4).fill(0);
    for (const axis of axes) v[axis] += 1;
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    return v.map(x => x / norm);
};

test('similarity() is honest cosine — identical vectors are 1.0, orthogonal are 0', () => {
    assert.ok(Math.abs(similarity(vec(0), vec(0)) - 1) < 1e-9);
    assert.equal(similarity(vec(0), vec(1)), 0);
});

test('similarity() is 0 (not a throw) for garbage: empty, length mismatch, null, zero vector', () => {
    assert.equal(similarity([], vec(0)), 0);
    assert.equal(similarity([1, 0, 0], vec(0)), 0, '3-axis vector vs 4-axis vector — length mismatch');
    assert.equal(similarity(null, vec(0)), 0);
    assert.equal(similarity([0, 0, 0, 0], vec(0)), 0);
});

test('pickWeighted() single candidate wins outright; empty list gives null', () => {
    const a = { id: 'a' };
    assert.equal(pickWeighted([a]), a);
    assert.equal(pickWeighted([]), null);
});

test('pickWeighted() with randomFn pinned to 0 picks the FIRST candidate — order matters', () => {
    const a = { id: 'a', playCount: 0 };
    const b = { id: 'b', playCount: 1 };
    assert.equal(pickWeighted([a, b], () => 0), a);
});

test('pickWeighted() never-played track is twice as likely as one played once — exact weights (1/1 vs 1/2)', () => {
    const a = { id: 'a', playCount: 0 };
    const b = { id: 'b', playCount: 1 };
    // weight a = 1, weight b = 1/2, total 1.5; roll = randomFn*1.5:
    // [0,1) → a, [1,1.5) → b. Пинним randomFn, проверяем обе зоны.
    assert.equal(pickWeighted([a, b], () => 0.1).id, 'a');  // roll 0.15
    assert.equal(pickWeighted([a, b], () => 0.9).id, 'b');  // roll 1.35
});

test('selectTrack() drops tracks without a vector instead of playing "whatever"', () => {
    const result = selectTrack({ tracks: [{ id: 'novector', playCount: 0 }], sceneVector: vec(0) });
    assert.equal(result, null);
});

test('selectTrack() null when everything is below the minSimilarity floor', () => {
    const result = selectTrack({ tracks: [{ id: 'a', vector: vec(1) }, { id: 'b', vector: vec(2) }], sceneVector: vec(0) });
    assert.equal(result, null);
});

test('selectTrack() picks the genuinely closest track', () => {
    const scene = vec(0);
    const result = selectTrack({
        tracks: [{ id: 'far', vector: vec(1), playCount: 0 }, { id: 'near', vector: vec(0), playCount: 9 }],
        sceneVector: scene,
    });
    assert.equal(result.track.id, 'near');
    assert.ok(Math.abs(result.similarity - 1) < 1e-9);
});

test('selectTrack() close cluster falls back to weighted playCount rotation, not strict order', () => {
    const scene = vec(0);
    // Близкий кластер: оба ~1.0 (разница < closeMargin), far выбывает по порогу
    // (cos(0,1-осей)=0). a сыгран много, b — ни разу: b должен перевешивать.
    const tracks = [
        { id: 'a', vector: vec(0), playCount: 20 },
        { id: 'b', vector: vec(0, 0), playCount: 0 }, // тот же вектор — кластер
        { id: 'far', vector: vec(3), playCount: 0 },
    ];
    assert.equal(selectTrack({ tracks, sceneVector: scene, randomFn: () => 0.0 }).track.id, 'a');
    assert.equal(selectTrack({ tracks, sceneVector: scene, randomFn: () => 0.99 }).track.id, 'b');
});

test('selectTrack() respects custom thresholds (call-site tuning without editing the library)', () => {
    const result = selectTrack({
        tracks: [{ id: 'weak', vector: vec(0, 1), playCount: 0 }], // cos = 1/√2 ≈ 0.707
        sceneVector: vec(0),
        minSimilarity: 0.8,
    });
    assert.equal(result, null);
});

test('shouldSwitch() without a playing track always yes; within hysteresis noise — no', () => {
    assert.equal(shouldSwitch({ candidateSimilarity: 0.6 }), true);
    assert.equal(shouldSwitch({ currentSimilarity: 0.6, candidateSimilarity: 0.62 }), false, 'noise must not jerk the music');
    assert.equal(shouldSwitch({ currentSimilarity: 0.6, candidateSimilarity: 0.7 }), true);
});

test('shouldSwitch() exactly-at-hysteresis candidate DOES switch (>=, not >)', () => {
    assert.equal(shouldSwitch({ currentSimilarity: 0.6, candidateSimilarity: 0.65 }), true);
});
