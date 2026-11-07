import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyFailure, retryWaitMs, readRetryAfterMs, retryConfig, retryLine,
    isEmptyAnswer, RetryExhaustedError,
} from '../libraries/core/retry-policy.js';
import { createRetryRunner } from '../cores/decision/retry.js';
import { clampDecisionSettings, DEFAULT_RETRY } from '../libraries/core/decision-settings.js';

const http = (status, text = '') => Object.assign(new Error(`HTTP ${status}`), { status, text });

function runner({ settings = {}, nowStep = 10 } = {}) {
    const events = [];
    let clock = 0;
    const full = clampDecisionSettings({ retry: { ...DEFAULT_RETRY, ...settings } });
    const retry = createRetryRunner({
        publishEvent: (event, payload) => events.push([event, payload]),
        getSettings: () => full,
        sleep: async ms => { clock += ms; },
        now: () => { const value = clock; clock += nowStep; return value; },
    });
    return { retry, events, at: () => clock, advance: ms => { clock += ms; } };
}

test('network, 5xx, 429, timeout and a dropped stream are retried; 401 is not', () => {
    assert.equal(classifyFailure(http(500)).retry, true);
    assert.equal(classifyFailure(http(429)).retry, true);
    assert.equal(classifyFailure(new Error('socket hang up')).retry, true);
    assert.equal(classifyFailure(new Error('the stream ended early')).retry, true);
    assert.equal(classifyFailure(new Error('timed out after 120 s')).retry, true);
    assert.equal(classifyFailure(http(401)).retry, false);
    assert.equal(classifyFailure(new Error('the request was stopped'), { signal: { aborted: true } }).retry, false);
    assert.equal(classifyFailure(Object.assign(new Error('thinking limit'), { code: 'thinking-cut' })).retry, false);
});

test('the pause grows 1 / 3 / 8 s and Retry-After wins', () => {
    assert.deepEqual([1, 2, 3, 4].map(n => retryWaitMs(n)), [1000, 3000, 8000, 8000]);
    assert.equal(retryWaitMs(1, 5000), 5000);
    assert.equal(retryWaitMs(1, 999999), 20000, 'a hostile Retry-After is capped');
    assert.equal(readRetryAfterMs('{"Retry-After": 4}'), 4000);
    assert.equal(readRetryAfterMs({ status: 429, text: 'retry-after: 2' }), 2000);
});

test('budgets and backups are per role; blocking roles are shorter', () => {
    const settings = clampDecisionSettings({
        retry: { maxAttempts: 4, turnBudgetMs: 5000, backgroundBudgetMs: 60000, backups: { resolver: 'b', writer: 'w' } },
    });
    assert.equal(retryConfig(settings, 'resolver').budgetMs, 5000);
    assert.equal(retryConfig(settings, 'director').budgetMs, 60000);
    assert.equal(retryConfig(settings, 'resolver').backupWorkerId, 'b');
    assert.equal(retryConfig(settings, 'counsellor').backupWorkerId, '');
    assert.match(retryLine({ role: 'writer', attempt: 2, maxAttempts: 3, reason: 'HTTP 500' }), /writer: retry 2\/3 — HTTP 500/);
    assert.equal(isEmptyAnswer({ text: ' ', toolCalls: [] }), true);
    assert.equal(isEmptyAnswer({ text: '', toolCalls: [{ name: 'await' }] }), false);
});

test('a server failure is retried, then the answer goes through', async () => {
    const world = runner();
    let calls = 0;
    const answer = await world.retry.run({
        role: 'resolver',
        budget: 'turn',
        request: async () => {
            calls += 1;
            if (calls === 1) throw http(500);
            return { text: 'ok', toolCalls: [] };
        },
    });
    assert.equal(answer.text, 'ok');
    assert.equal(calls, 2);
    assert.equal(world.events[0][0], 'decision.retry');
    assert.match(world.events[0][1].line, /resolver: retry 1\/3/);
});

test('an empty answer is retried once with a bigger limit and lower reasoning', async () => {
    const world = runner();
    const seen = [];
    const answer = await world.retry.run({
        role: 'director',
        budget: 'background',
        request: async options => {
            seen.push(options);
            return options.attempt === 1 ? { text: '', toolCalls: [] } : { text: 'decree', toolCalls: [] };
        },
    });
    assert.equal(answer.text, 'decree');
    assert.deepEqual(seen.map(item => [item.boost, item.lowerReasoning]), [[1, false], [2, true]]);
});

test('two empty answers in a row switch to the role backup connection', async () => {
    const world = runner({ settings: { backups: { resolver: 'backup' } } });
    const workers = [];
    const answer = await world.retry.run({
        role: 'resolver',
        budget: 'turn',
        request: async options => {
            workers.push(options.backupWorkerId);
            if (options.backupWorkerId) return { text: 'from backup', toolCalls: [] };
            return { text: '', toolCalls: [] };
        },
    });
    assert.equal(answer.text, 'from backup');
    assert.deepEqual(workers, ['', '', 'backup']);
    assert.ok(world.events.some(([, payload]) => payload.kind === 'backup'));
});

test('no backup and two empty answers end in a clear exhausted error', async () => {
    const world = runner();
    await assert.rejects(
        () => world.retry.run({ role: 'counsellor', budget: 'background', request: async () => ({ text: '', toolCalls: [] }) }),
        error => error instanceof RetryExhaustedError && error.retryKind === 'empty' && error.attempts === 2,
    );
});

test('the turn budget stops a long retry instead of hanging the turn', async () => {
    const world = runner({ settings: { turnBudgetMs: 1000, maxAttempts: 3 } });
    let calls = 0;
    await assert.rejects(
        () => world.retry.run({ role: 'resolver', budget: 'turn', request: async () => { calls += 1; throw http(500); } }),
        error => error instanceof RetryExhaustedError && error.retryKind === 'budget',
    );
    assert.equal(calls, 1);
});

test('the writer uses the same policy: 429 then a reply, empty then a reply, two empties then the backup', async () => {
    const { createWriterRetry } = await import('../cores/decision/writer-retry.js');
    const events = [];
    const settings = clampDecisionSettings({ retry: { backups: { writer: 'backup' } } });
    const writer = createWriterRetry({
        getSettings: () => settings, publishEvent: (event, payload) => events.push([event, payload]), sleep: async () => {},
    });
    let calls = 0;
    const first = await writer.run({
        request: async () => { calls += 1; if (calls === 1) throw http(429, '{"error":"slow down","retry-after":1}'); return { text: 'reply' }; },
    });
    assert.equal(first.text, 'reply');
    assert.equal(calls, 2);
    assert.match(events[0][1].line, /writer: retry 1\/3/);

    const options = [];
    const second = await writer.run({
        request: async opts => { options.push(opts); return opts.attempt === 1 ? { text: '' } : { text: 'reply again' }; },
    });
    assert.equal(second.text, 'reply again');
    assert.deepEqual(options.map(item => item.boost), [1, 2]);

    const workers = [];
    const third = await writer.run({
        request: async opts => { workers.push(opts.backupWorkerId); return opts.backupWorkerId ? { text: 'from backup' } : { text: '' }; },
    });
    assert.equal(third.text, 'from backup');
    assert.deepEqual(workers, ['', '', 'backup']);
});

test('broken tool JSON is repaired by the engine before the model is asked again', async () => {
    const { repairToolArguments } = await import('../libraries/core/provider-tools.js');
    assert.deepEqual(repairToolArguments('{"comment":"A reason."}'), { ok: true, value: { comment: 'A reason.' } });
    assert.deepEqual(repairToolArguments("```json\n{'comment':'A reason.'}\n```"), { ok: true, value: { comment: 'A reason.' } });
    assert.deepEqual(repairToolArguments('{"comment":"A reason.",}'), { ok: true, value: { comment: 'A reason.' } });
    const broken = repairToolArguments('{not json at all');
    assert.equal(broken.ok, false);
    assert.match(broken.error, /not valid JSON/);
});

test('an answer cut off by the limit is retried with a larger output limit too', async () => {
    const world = runner();
    const seen = [];
    const answer = await world.retry.run({
        role: 'resolver', budget: 'turn',
        request: async options => {
            seen.push(options);
            return options.attempt === 1
                ? { text: 'half an ans', toolCalls: [], finishReason: 'length' }
                : { text: 'the whole answer', toolCalls: [] };
        },
    });
    assert.equal(answer.text, 'the whole answer');
    assert.deepEqual(seen.map(item => item.boost), [1, 2]);
    assert.ok(world.events.some(([, payload]) => payload.kind === 'cut'));
});
