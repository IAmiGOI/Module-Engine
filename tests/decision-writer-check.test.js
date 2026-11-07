import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { createWriterProxy } from '../cores/decision/writer-proxy.js';
import { createWriterChecker } from '../cores/decision/writer-check.js';

const frame = content => ({ data: JSON.stringify({ choices: [{ delta: { content } }] }) });
const settings = () => ({
    writer: { workerId: 'writer', applySampler: true, temperature: 0.7, topP: 1, topK: 0, maxTokens: 500 },
    classifier: { connectionId: 'test', threshold: 0.85, checkTokens: 5, rewriteLimit: 2 },
});
const workers = [{ id: 'writer', format: 'openai', model: 'writer/model' }];

function build({ provider, classifier, connections = [{ id: 'test', apiKey: 'test-key' }] }) {
    const engine = createEngine();
    const events = [];
    const providerCalls = [];
    const classifierCalls = [];
    engine.buses.network.register('http.request', async params => {
        providerCalls.push(params);
        return provider(params);
    });
    engine.buses.cores.register('classifier.connections.get', () => connections);
    engine.buses.cores.register('classifier.decide', async params => {
        classifierCalls.push(params);
        return classifier(params);
    });
    const host = engine.registerCaller('core.decision', 'cores', { tier: 'official', networkAccess: true });
    const call = async (contract, params) => {
        const result = await request(host.own, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    };
    const proxy = createWriterProxy({ host, getSettings: settings, getWorkers: () => workers });
    const checker = createWriterChecker({ call, getSettings: settings, banks: null });
    async function send({ payload = { stream: true, chat_completion_source: 'openai' }, messages = [{ role: 'system', content: 'Writer system' }, { role: 'system', content: 'INSCRIPTION — what happens this turn:\nShe waits.' }], signal } = {}) {
        const answer = await proxy.respond({
            payload, messages, signal, check: checker, push: 'She waits.', userMessage: 'Hello?', resolution: 'She waits.', user: 'Sasha',
            runId: 'run_1', publishEvent: (event, data) => events.push([event, data]),
        });
        return { response: answer?.respondWith, events, providerCalls, classifierCalls };
    }
    return { send, events, providerCalls, classifierCalls };
}

const clean = () => ({ answers: { user_agency: 0.1, past_resolution: 0.1 }, failed: [] });
const dirty = () => ({ answers: { user_agency: 0.95, past_resolution: 0.1 }, failed: [] });

test('a clean reply is delivered whole: one SSE frame and no rewrite request', async () => {
    const harness = build({
        classifier: clean,
        provider: params => {
            params.onChunk(frame('Clean prose.'));
            params.onChunk({ data: '[DONE]' });
            return { status: 200, ok: true, text: '' };
        },
    });
    const { response, providerCalls } = await harness.send();
    const text = await response.text();
    assert.match(text, /Clean prose\./);
    assert.equal((text.match(/Clean prose/g) ?? []).length, 1);
    assert.equal(providerCalls.length, 1, 'no rewrite request was made');
    assert.match(text, /data: \[DONE\]/);
});

test('a violation mid-stream aborts the writer and the user sees only the rewritten reply', async () => {
    const harness = build({
        classifier: params => {
            const reply = String(params.calls?.[0]?.state?.reply ?? '');
            if (params.calls?.[0]?.questions?.quote_0 !== undefined) return { answers: { quote_0: 0.9 }, failed: [] };
            return reply.includes('BAD') ? dirty() : clean();
        },
        provider: params => {
            const body = JSON.parse(String(params.body ?? '{}'));
            const rewritten = JSON.stringify(body.messages ?? []).includes('REWRITE (attempt 1)');
            params.onChunk(frame(rewritten ? 'GOOD rewrite.' : 'BAD first attempt.'));
            params.onChunk({ data: '[DONE]' });
            return { status: 200, ok: true, text: '' };
        },
    });
    const { response, providerCalls, events } = await harness.send();
    const text = await response.text();
    assert.match(text, /GOOD rewrite\./);
    assert.doesNotMatch(text, /BAD first attempt/);
    assert.equal(providerCalls.length, 2, 'the first provider request was discarded and a second one made');
    const second = JSON.parse(String(providerCalls[1].body));
    assert.match(JSON.stringify(second.messages), /REWRITE \(attempt 1\)/);
    assert.ok(events.some(([event, data]) => event === 'decision.writer.check' && data.aborted === true));
});

test('after two rewrites a third violation is delivered with an exhausted mark', async () => {
    const harness = build({
        classifier: params => (params.calls?.[0]?.questions?.quote_0 !== undefined ? { answers: { quote_0: 0.9 }, failed: [] } : dirty()),
        provider: params => {
            params.onChunk(frame('BAD reply.'));
            params.onChunk({ data: '[DONE]' });
            return { status: 200, ok: true, text: '' };
        },
    });
    const { response, providerCalls, events } = await harness.send();
    const text = await response.text();
    assert.match(text, /BAD reply\./);
    assert.equal(providerCalls.length, 3, 'original + two rewrites');
    assert.ok(events.some(([event, data]) => event === 'decision.writer.check' && data.exhausted === true));
});

test('a classifier failure delivers the original reply without a check', async () => {
    const harness = build({
        classifier: () => { throw new Error('classifier down'); },
        provider: params => {
            params.onChunk(frame('Original reply.'));
            params.onChunk({ data: '[DONE]' });
            return { status: 200, ok: true, text: '' };
        },
    });
    const { response, events } = await harness.send();
    assert.match(await response.text(), /Original reply\./);
    assert.ok(events.some(([event, data]) => event === 'decision.writer.check' && data.skipped === true));
});

test('a non-stream reply is checked and returned as JSON', async () => {
    const harness = build({
        classifier: clean,
        provider: () => ({ status: 200, ok: true, text: JSON.stringify({ choices: [{ message: { content: 'JSON prose.' } }] }) }),
    });
    const { response } = await harness.send({ payload: { stream: false, chat_completion_source: 'openai' } });
    const body = JSON.parse(await response.text());
    assert.equal(body.choices[0].message.content, 'JSON prose.');
});

test('Stop closes the stream and aborts the provider request', async () => {
    let aborted = false;
    const harness = build({
        classifier: clean,
        provider: params => new Promise(resolve => {
            params.signal?.addEventListener('abort', () => {
                aborted = true;
                resolve({ status: 499, ok: false, text: JSON.stringify({ error: { message: 'aborted' } }) });
            });
        }),
    });
    const controller = new AbortController();
    const pending = harness.send({ signal: controller.signal });
    while (!harness.providerCalls.length) await new Promise(done => setTimeout(done, 1));
    controller.abort();
    const { response } = await pending;
    await response.text();
    assert.equal(aborted, true);
});

test('the ST connection path is untouched: no writer proxy response and no classifier call', async () => {
    const harness = build({ classifier: clean, provider: () => ({ status: 200, ok: true, text: '' }) });
    const engine = createEngine();
    const host = engine.registerCaller('core.decision', 'cores', { tier: 'official', networkAccess: true });
    const proxy = createWriterProxy({ host, getSettings: () => ({ ...settings(), writer: { ...settings().writer, workerId: '' } }), getWorkers: () => workers });
    const answer = await proxy.respond({ payload: { stream: true }, messages: [] });
    assert.equal(answer, null);
    assert.equal(harness.classifierCalls.length, 0);
});

test('no classifier connection: the writer is not held back — frames go to ST live and the window says the check was skipped', async () => {
    const harness = build({
        connections: [],
        provider: params => {
            params.onChunk(frame('Part one. '));
            params.onChunk(frame('Part two.'));
            params.onChunk({ data: '[DONE]' });
            return { status: 200, ok: true, text: '' };
        },
        classifier: () => { throw new Error('the classifier must not be asked'); },
    });
    const { response, events, classifierCalls } = await harness.send();
    const text = await response.text();
    assert.match(text, /"content":"Part one\. "/);
    assert.match(text, /"content":"Part two\."/);
    assert.equal(classifierCalls.length, 0);
    assert.ok(events.some(([name, data]) => name === 'decision.writer.check' && data.skipped && /without a check/.test(data.error)));
});
