import { request } from '../../libraries/shared/request.js';
import { buildProviderRequest, resolveStreamDelta } from '../../libraries/core/provider-request.js';
import { translateWriterFrame, writerSourceFormat, writerErrorMessage, writerErrorBody, writerJsonBody } from '../../libraries/core/writer-response.js';
import { rewritePrompt, rewriteReasons } from '../../libraries/core/decision-writer-check.js';
import { estimateTokens } from '../../libraries/core/token-estimate.js';

/**
 * Прозаик через своё подключение ME: строим openai-запрос, держим поток у
 * себя, проверяем накопленный текст классификатором и отдаём ST только
 * готовый ответ. При нарушении поток обрывается и писатель пишет заново;
 * пользователь перезапусков не видит (вариант Б).
 */

const STALL_MS = 120000;
const TIMEOUT_MS = 120000;
const OPENAI = 'openai';
const EMPTY_CHECK = { ok: false, answers: {}, violated: [], error: 'No classifier check is configured.' };

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function samplerFor(settings, payload) {
    const writer = settings.writer ?? {};
    const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
    const own = writer.applySampler === true;
    return {
        temperature: own ? writer.temperature : (number(payload?.temperature) ?? writer.temperature),
        topP: own ? writer.topP : (number(payload?.top_p) ?? writer.topP),
        topK: own ? writer.topK : (number(payload?.top_k) ?? writer.topK),
        maxTokens: own ? writer.maxTokens : (number(payload?.max_tokens) ?? writer.maxTokens),
    };
}

function linkSignal(external, controller) {
    if (!external?.addEventListener) return () => {};
    const abort = () => controller.abort();
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', abort);
    return () => external.removeEventListener('abort', abort);
}

export function createWriterProxy({ host, getSettings, getWorkers }) {
    function network(params, options) {
        return request(host.network, 'http.request', { params, ...options });
    }

    function targetWorker() {
        const settings = getSettings();
        const id = String(settings.writer?.workerId ?? '').trim();
        if (!id || id === 'st-main') return { worker: null, id };
        const worker = getWorkers().find(item => item.id === id) ?? null;
        return { worker, id };
    }

    function makeRequest(worker, settings, payload, messages, stream) {
        const generateRequest = { messages, ...samplerFor(settings, payload), reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0 };
        return buildProviderRequest(worker, generateRequest, { stream });
    }

    function announce(publishEvent, payload) {
        if (typeof publishEvent === 'function') publishEvent('decision.writer.check', { at: Date.now(), ...payload });
    }

    async function respond({ payload, messages, signal, check, push = '', userMessage = '', resolution = '', user = '', runId = '', publishEvent = null }) {
        const settings = getSettings();
        const { worker, id } = targetWorker();
        if (!id || id === 'st-main') return null;
        if (!worker) {
            return { respondWith: jsonResponse(writerErrorBody(`Writer connection "${id}" is not available — choose an existing connection in the Director / Writer card.`), 400) };
        }
        if (worker.format !== OPENAI) {
            return { respondWith: jsonResponse(writerErrorBody(`Writer connection "${id}" must be an "openai" connection; it is "${worker.format}".`), 400) };
        }
        const stream = payload?.stream === true;
        const targetFormat = writerSourceFormat(payload?.chat_completion_source);
        const context = {
            id, worker, settings, payload, messages, signal, check: check ?? null,
            push, userMessage, resolution, user, runId, publishEvent, targetFormat, stream,
            requestFor: nextMessages => makeRequest(worker, settings, payload, nextMessages, stream),
        };
        return stream
            ? { respondWith: streamResponse(context) }
            : { respondWith: await checkedJson(context) };
    }

    async function checkText(context, reply, attempt, phase) {
        if (!context.check) {
            announce(context.publishEvent, { runId: context.runId, attempt, phase, skipped: true, error: EMPTY_CHECK.error });
            return EMPTY_CHECK;
        }
        const result = await context.check.check({
            reply, push: context.push, userMessage: context.userMessage, resolution: context.resolution, signal: context.signal,
        });
        announce(context.publishEvent, {
            runId: context.runId, attempt, phase, probabilities: result.answers ?? {}, violated: result.violated ?? [],
            skipped: !result.ok, error: result.ok ? '' : (result.error || 'The classifier gave no answer.'), aborted: Boolean(result.violated?.length),
        });
        return result;
    }

    async function nextAttempt(context, attempt, violated) {
        const id = violated[0];
        const quote = await context.check.quote({
            reply: context.lastText, push: context.push, userMessage: context.userMessage,
            resolution: context.resolution, id, signal: context.signal,
        }).catch(() => '');
        const reasons = rewriteReasons({ ids: violated, quote, user: context.user, resolution: context.resolution });
        const prompt = rewritePrompt({ reasons, attempt });
        announce(context.publishEvent, { runId: context.runId, attempt, phase: 'rewrite', quote, reasons, violated });
        return [...context.messages, { role: 'system', content: prompt }];
    }

    async function checkedJson(context) {
        if (context.signal?.aborted) return jsonResponse(writerErrorBody('The request was stopped.'), 499);
        const limit = Number(context.settings.classifier?.rewriteLimit) || 2;
        let messages = context.messages;
        let current = '';
        for (let attempt = 1; attempt <= limit + 1; attempt += 1) {
            const result = await jsonOnce(context, messages);
            if (!result.ok) return jsonResponse(writerErrorBody(result.error), result.status || 502);
            current = result.text;
            context.lastText = current;
            const verdict = await checkText(context, current, attempt, 'final');
            if (!verdict.ok || !verdict.violated?.length) return jsonResponse(writerJsonBody(current), 200);
            if (attempt > limit) {
                announce(context.publishEvent, { runId: context.runId, attempt, phase: 'delivered', exhausted: true, violated: verdict.violated });
                return jsonResponse(writerJsonBody(current), 200);
            }
            messages = await nextAttempt(context, attempt, verdict.violated);
        }
        return jsonResponse(writerJsonBody(current), 200);
    }

    async function jsonOnce(context, messages) {
        const result = await network({ ...context.requestFor(messages), stream: false, signal: context.signal }, { timeoutMs: TIMEOUT_MS });
        if (!result.ok) return { ok: false, error: `Writer connection "${context.id}" request failed: ${result.error.message}` };
        const value = result.value;
        if (!value.ok) return { ok: false, error: writerErrorMessage(context.id, value.status, value.text), status: value.status || 502 };
        const body = writerJsonBody(value.text);
        return { ok: true, text: String(body?.choices?.[0]?.message?.content ?? '') };
    }

    function streamResponse(context) {
        const encoder = new TextEncoder();
        let controller = null;
        let closed = false;
        const body = new ReadableStream({ start(value) { controller = value; } });
        const push = text => {
            if (closed || !controller) return;
            try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
        };
        const finish = () => {
            if (closed || !controller) return;
            closed = true;
            try { controller.close(); } catch { /* already closed */ }
        };
        const fail = message => {
            push(`data: ${JSON.stringify(writerErrorBody(message))}\n\n`);
            finish();
        };
        const emit = text => {
            const frame = JSON.stringify({ choices: [{ delta: { content: String(text ?? '') } }] });
            const translated = translateWriterFrame(frame, context.targetFormat);
            if (translated !== null) push(`data: ${translated}\n\n`);
            push('data: [DONE]\n\n');
            finish();
        };

        (async () => {
            if (context.signal?.aborted) { finish(); return; }
            const limit = Number(context.settings.classifier?.rewriteLimit) || 2;
            let messages = context.messages;
            for (let attempt = 1; attempt <= limit + 1; attempt += 1) {
                const collected = await collectStream(context, messages, attempt);
                if (collected.aborted) { finish(); return; }
                if (!collected.ok) { fail(collected.error); return; }
                context.lastText = collected.text;
                const verdict = collected.verdict ?? await checkText(context, collected.text, attempt, 'final');
                if (!verdict.ok || !verdict.violated?.length) { emit(collected.text); return; }
                if (attempt > limit) {
                    announce(context.publishEvent, { runId: context.runId, attempt, phase: 'delivered', exhausted: true, violated: verdict.violated });
                    emit(collected.text);
                    return;
                }
                messages = await nextAttempt(context, attempt, verdict.violated);
            }
        })().catch(error => {
            if (context.signal?.aborted) finish();
            else fail(`Writer connection "${context.id}" request failed: ${error?.message ?? error}`);
        });

        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }

    async function collectStream(context, messages, attempt) {
        const abortController = new AbortController();
        const unlink = linkSignal(context.signal, abortController);
        const stepTokens = Math.max(20, Number(context.settings.classifier?.checkTokens) || 150);
        let text = '';
        let nextCheck = stepTokens;
        let verdict = null;
        let abortedByCheck = false;
        let pending = Promise.resolve();
        const runCheck = async snapshot => {
            if (abortedByCheck || context.signal?.aborted) return;
            const result = await checkText(context, snapshot, attempt, 'stream');
            if (result.ok && result.violated?.length) {
                verdict = result;
                abortedByCheck = true;
                abortController.abort();
            }
        };
        try {
            const result = await network({
                ...context.requestFor(messages), stream: true, signal: abortController.signal, stallMs: STALL_MS,
                onChunk: frame => {
                    const delta = resolveStreamDelta('openai', frame);
                    if (!delta.delta) return;
                    text += delta.delta;
                    const tokens = estimateTokens(text);
                    if (tokens >= nextCheck) {
                        nextCheck = tokens + stepTokens;
                        const snapshot = text;
                        pending = pending.then(() => runCheck(snapshot));
                    }
                },
            });
            await pending;
            if (context.signal?.aborted) return { aborted: true };
            if (abortedByCheck) return { ok: true, text, verdict };
            if (!result.ok) return { ok: false, error: `Writer connection "${context.id}" request failed: ${result.error.message}` };
            const value = result.value;
            if (!value.ok) return { ok: false, error: writerErrorMessage(context.id, value.status, value.text) };
            if (!text && String(value.text ?? '').trim()) text = String(value.text).trim();
            if (!text) return { ok: false, error: `Writer connection "${context.id}" returned an empty reply.` };
            const finalVerdict = await checkText(context, text, attempt, 'final');
            return { ok: true, text, verdict: finalVerdict };
        } catch (error) {
            if (context.signal?.aborted) return { aborted: true };
            if (abortedByCheck || error?.name === 'AbortError') return { ok: true, text, verdict };
            return { ok: false, error: `Writer connection "${context.id}" request failed: ${error?.message ?? error}` };
        } finally {
            unlink();
        }
    }

    return { respond };
}
