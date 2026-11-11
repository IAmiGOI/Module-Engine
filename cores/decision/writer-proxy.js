import { request } from '../../libraries/shared/request.js';
import { buildProviderRequest, resolveStreamDelta, isNanoGpt } from '../../libraries/core/provider-request.js';
import { translateWriterFrame, writerSourceFormat, writerErrorMessage, writerErrorBody, writerJsonBody } from '../../libraries/core/writer-response.js';
import { rewritePrompt, rewriteReasons } from '../../libraries/core/decision-writer-check.js';
import { estimateTokens } from '../../libraries/core/token-estimate.js';
import { createWriterRetry, writerFailure } from './writer-retry.js';
import { buildLiveStreamResponse, STALL_MS } from './writer-live.js';

/**
 * Прозаик через своё подключение ME: строим openai-запрос, держим поток у
 * себя, проверяем накопленный текст классификатором и отдаём ST только
 * готовый ответ. При нарушении поток обрывается и писатель пишет заново;
 * пользователь перезапусков не видит (вариант Б).
 */

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
        frequencyPenalty: own ? writer.frequencyPenalty : (number(payload?.frequency_penalty) ?? writer.frequencyPenalty),
    };
}

function linkSignal(external, controller) {
    if (!external?.addEventListener) return () => {};
    const abort = () => controller.abort();
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', abort);
    return () => external.removeEventListener('abort', abort);
}

const NANO_MODELS_URL = 'https://nano-gpt.com/api/v1/models?detailed=true';
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Самый низкий уровень размышлений, который модель принимает; null — модель не размышляет или список недоступен. */
export function lowestEffort(efforts) {
    const list = Array.isArray(efforts) ? efforts.map(value => String(value).toLowerCase()) : [];
    return EFFORT_ORDER.find(level => list.includes(level)) ?? null;
}

export function createWriterProxy({ host, getSettings, getWorkers }) {
    function network(params, options) {
        return request(host.network, 'http.request', { params, ...options });
    }

    // Писатель не размышляет. NanoGPT выключает это только у части моделей (GLM 5.3 — нет, минимум "low"), поэтому уровень берётся из их списка моделей: публичный, без ключа, один раз за сессию.
    let nanoEfforts = null;
    async function disabledEffortFor(worker) {
        if (!isNanoGpt(worker?.endpoint)) return null;
        if (!nanoEfforts) {
            nanoEfforts = network({ url: NANO_MODELS_URL, method: 'GET' }, { timeoutMs: 8000 }).then(result => {
                const value = result?.ok ? result.value : null;
                if (!value?.ok) return null;
                const map = new Map();
                for (const model of JSON.parse(String(value.text ?? '{}'))?.data ?? []) map.set(String(model.id).toLowerCase(), model.reasoning_efforts ?? null);
                return map;
            }).catch(() => null);
        }
        const map = await nanoEfforts;
        if (!map) { nanoEfforts = null; return null; }
        return lowestEffort(map.get(String(worker.model ?? '').toLowerCase()));
    }

    function targetWorker() {
        const settings = getSettings();
        const id = String(settings.writer?.workerId ?? '').trim();
        if (!id || id === 'st-main') return { worker: null, id };
        const worker = getWorkers().find(item => item.id === id) ?? null;
        return { worker, id };
    }

    function makeRequest(worker, settings, payload, messages, stream, disabledEffort = null, boost = 1) {
        const generateRequest = { messages, ...samplerFor(settings, payload), reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0, disabledEffort };
        if (boost > 1 && Number.isFinite(Number(generateRequest.maxTokens))) {
            generateRequest.maxTokens = Math.min(32768, Math.round(Number(generateRequest.maxTokens) * boost));
        }
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
        const disabledEffort = await disabledEffortFor(worker);
        const targetFormat = writerSourceFormat(payload?.chat_completion_source);
        const retry = createWriterRetry({ getSettings, publishEvent: (event, data) => publishEvent?.(event, data) });
        const workerForId = idValue => getWorkers().find(item => item.id === idValue) ?? worker;
        // Телеметрия Писателя: он ходит в сеть сам, мимо ядра моделей, поэтому запись — отсюда, тем же событием.
        const startedAt = Date.now();
        const onTelemetry = ({ status = 'ok', usage = null, error = '', attempts = 1 } = {}) => {
            try {
                publishEvent?.('model.generate.telemetry', {
                    caller: 'core.decision', purpose: 'writer', workerId: worker.id, model: worker.model, endpoint: worker.endpoint,
                    usage, durationMs: Date.now() - startedAt, status, error: String(error ?? ''), attempts,
                });
            } catch { /* телеметрия не ломает ответ */ }
        };
        const context = {
            onTelemetry,
            id, worker, settings, payload, messages, signal, check: check ?? null,
            push, userMessage, resolution, user, runId, publishEvent, targetFormat, stream, retry,
            requestFor: (nextMessages, options = {}) => makeRequest(
                options.backupWorkerId ? workerForId(options.backupWorkerId) : worker,
                settings, payload, nextMessages, stream, disabledEffort, options.boost ?? 1,
            ),
        };
        // Проверять нечем (классификатор не настроен) — поток идёт живьём, как до части 11: держать ответ незачем,
        // а пользователь иначе ничего не видит, пока писатель не допишет целиком.
        const canCheck = context.check
            ? (typeof context.check.ready === 'function' ? await context.check.ready().catch(() => false) : true)
            : false;
        if (!canCheck) {
            announce(publishEvent, { runId, attempt: 1, phase: 'final', skipped: true, error: 'No classifier connection is set — the writer streams without a check.' });
            context.check = null;
            if (stream) return { respondWith: buildLiveStreamResponse(context, { network }) };
        }
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
        // Цитату не ищем: это был запрос к классификатору на каждое предложение ответа (десятки подряд), а писатель
        // находит место по самой причине.
        const quote = '';
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
            let result;
            try {
                result = await context.retry.run({ request: options => jsonOnce(context, messages, options) });
            } catch (error) {
                const message = error?.status ? writerErrorMessage(context.id, error.status, error.text) : (error?.message ?? String(error));
                return jsonResponse(writerErrorBody(message), error?.status || 502);
            }
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

    async function jsonOnce(context, messages, options = {}) {
        const result = await network({ ...context.requestFor(messages, options), stream: false, signal: context.signal }, { timeoutMs: TIMEOUT_MS });
        if (!result.ok) throw new Error(`Writer connection "${context.id}" request failed: ${result.error.message}`);
        const value = result.value;
        if (!value.ok) throw writerFailure(context.id, value.status, value.text);
        const body = writerJsonBody(value.text);
        let usage = null;
        try { usage = JSON.parse(value.text)?.usage ?? null; } catch { usage = null; }
        const text = String(body?.choices?.[0]?.message?.content ?? '');
        context.onTelemetry?.({ status: text.trim() ? 'ok' : 'empty', usage });
        return { text };
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
        // Проверенный путь держит поток у себя: повтор безопасен, кадры в ST ещё не ушли (часть 19).
        try {
            const answer = await context.retry.run({
                request: async options => {
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
                            ...context.requestFor(messages, options), stream: true, signal: abortController.signal, stallMs: STALL_MS,
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
                        if (abortedByCheck) {
                            throw Object.assign(new Error('the classifier stopped the stream'), { code: 'check-abort', text, verdict });
                        }
                        if (context.signal?.aborted) throw Object.assign(new Error('stopped'), { code: 'stopped' });
                        if (!result.ok) throw new Error(`Writer connection "${context.id}" request failed: ${result.error.message}`);
                        const value = result.value;
                        if (!value.ok) throw writerFailure(context.id, value.status, value.text);
                        if (!text && String(value.text ?? '').trim()) text = String(value.text).trim();
                        return { text };
                    } catch (error) {
                        if (abortedByCheck) throw Object.assign(new Error('the classifier stopped the stream'), { code: 'check-abort', text, verdict });
                        throw error;
                    } finally {
                        unlink();
                    }
                },
            });
            if (context.signal?.aborted) return { aborted: true };
            const verdict = await checkText(context, answer.text, attempt, 'final');
            return { ok: true, text: answer.text, verdict };
        } catch (error) {
            if (context.signal?.aborted) return { aborted: true };
            if (error?.code === 'check-abort') return { ok: true, text: error.text, verdict: error.verdict };
            const message = error?.status ? writerErrorMessage(context.id, error.status, error.text) : `Writer connection "${context.id}" request failed: ${error?.message ?? error}`;
            return { ok: false, error: message };
        }
    }

    return { respond };
}
