import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerHealth, classifyFailure } from '../libraries/core/worker-health.js';

const httpError = status => Object.assign(new Error(`HTTP ${status}`), { status });

test('network failures, timeouts, stalls, 5xx, 408 and 429 count as the worker being unavailable', () => {
    for (const error of [new TypeError('Failed to fetch'), new Error('request(): "x" timed out after 5ms.'), new Error('http.request: stream stalled — no data for 10ms.'), httpError(503), httpError(408), httpError(429)]) {
        assert.equal(classifyFailure(error), 'unavailable', error.message);
    }
});

test('401, 403 and 404 are a rejected request, not an unavailable worker', () => {
    for (const status of [401, 403, 404]) assert.equal(classifyFailure(httpError(status)), 'rejected');
});

test('our own cancellation and a malformed reply say nothing about availability and are ignored', () => {
    assert.equal(classifyFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'ignored');
    assert.equal(classifyFailure(new Error('reply was not a JSON object')), 'ignored');
});

test('a worker nobody has heard from yet is unknown and keeps the full weight', () => {
    const health = createWorkerHealth();

    assert.equal(health.stateOf('w'), 'unknown');
    assert.equal(health.weightOf('w'), 1);
});

test('three unavailable failures in a row take a worker down to weight 0, and one success brings it back', () => {
    const health = createWorkerHealth();
    for (let index = 0; index < 3; index += 1) health.recordFailure('w', httpError(502));

    assert.equal(health.stateOf('w'), 'down');
    assert.equal(health.weightOf('w'), 0);

    health.recordSuccess('w');
    assert.notEqual(health.stateOf('w'), 'down');
    assert.ok(health.weightOf('w') > 0);
});

test('a worker that fails every few requests gets a lower weight than one that never fails', () => {
    const health = createWorkerHealth();
    for (let index = 0; index < 12; index += 1) {
        health.recordSuccess('steady');
        if (index % 3 === 0) health.recordFailure('flaky', httpError(500)); else health.recordSuccess('flaky');
    }

    assert.ok(health.weightOf('flaky') < health.weightOf('steady'));
    assert.equal(health.stateOf('flaky'), 'degraded');
    assert.equal(health.stateOf('steady'), 'up');
});

test('old failures fade: a day later the same history weighs almost nothing', () => {
    let clock = 0;
    const health = createWorkerHealth({ now: () => clock });
    health.recordFailure('w', httpError(500));
    health.recordFailure('w', httpError(500));
    const before = health.snapshot('w').reliability;

    clock += 24 * 60 * 60 * 1000;
    health.recordSuccess('w');

    assert.ok(health.snapshot('w').reliability > 0.6, `reliability recovered from ${before}`);
});

test('the snapshot keeps separate totals, the last error and a smoothed latency', () => {
    const health = createWorkerHealth({ now: () => 1000 });
    health.recordSuccess('w', { latencyMs: 100 });
    health.recordSuccess('w', { latencyMs: 200 });
    health.recordFailure('w', httpError(429));
    health.recordFailure('w', httpError(401));
    health.recordFailure('w', new Error('bad JSON'));

    const snapshot = health.snapshot('w');
    assert.deepEqual(snapshot.totals, { success: 2, unavailable: 1, rejected: 1 });
    assert.equal(snapshot.latencyMs, 130);
    assert.equal(snapshot.lastError.kind, 'rejected');
});

test('exported statistics survive a round trip, as they must across a page reload', () => {
    const health = createWorkerHealth({ now: () => 5 });
    health.recordFailure('w', httpError(500), { probe: true });
    const restored = createWorkerHealth({ now: () => 5 });

    restored.importState(JSON.parse(JSON.stringify(health.exportState())));

    assert.deepEqual(restored.snapshot('w'), health.snapshot('w'));
});
