import { request } from '../../libraries/shared/request.js';
import { buildProviderRequest } from '../../libraries/core/provider-request.js';
import { translateWriterFrame, writerSourceFormat, writerErrorMessage, writerErrorBody, writerJsonBody } from '../../libraries/core/writer-response.js';

/**
 * Прозаик через своё подключение ME: строим openai-запрос к нему, ждём ответ
 * через сетевой Сервис (права `networkAccess` Ядра решений) и отдаём ST
 * Response в его форме. Ни ключ, ни тело запроса не попадают в события или
 * ошибки — ключ уходит только в заголовок запроса к самому подключению.
 */

const STALL_MS = 120000;
const TIMEOUT_MS = 120000;
const OPENAI = 'openai';

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

    async function respond({ payload, messages, signal }) {
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
        const generateRequest = { messages, ...samplerFor(settings, payload), reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0 };
        const providerRequest = buildProviderRequest(worker, generateRequest, { stream });
        return stream
            ? { respondWith: streamResponse({ providerRequest, targetFormat, id, signal }) }
            : { respondWith: await jsonRequest({ providerRequest, id, signal }) };
    }

    async function jsonRequest({ providerRequest, id, signal }) {
        const result = await network({ ...providerRequest, stream: false, signal }, { timeoutMs: TIMEOUT_MS });
        if (!result.ok) return jsonResponse(writerErrorBody(`Writer connection "${id}" request failed: ${result.error.message}`), 502);
        const value = result.value;
        if (!value.ok) return jsonResponse(writerErrorBody(writerErrorMessage(id, value.status, value.text)), value.status || 502);
        return jsonResponse(writerJsonBody(value.text), 200);
    }

    function streamResponse({ providerRequest, targetFormat, id, signal }) {
        const encoder = new TextEncoder();
        let controller = null;
        let closed = false;
        let sawFrame = false;
        let sawDone = false;
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
        const pushData = data => {
            const translated = translateWriterFrame(data, targetFormat);
            if (translated === null) return;
            if (translated === '[DONE]') sawDone = true;
            sawFrame = true;
            push(`data: ${translated}\n\n`);
        };

        (async () => {
            if (signal?.aborted) { finish(); return; }
            const result = await network({
                ...providerRequest, stream: true, signal, stallMs: STALL_MS,
                onChunk: frame => { const data = String(frame?.data ?? ''); if (data) pushData(data); },
            });
            if (signal?.aborted) { finish(); return; }
            if (!result.ok) { fail(`Writer connection "${id}" request failed: ${result.error.message}`); return; }
            const value = result.value;
            if (!value.ok) { fail(writerErrorMessage(id, value.status, value.text)); return; }
            if (!sawFrame && String(value.text ?? '').trim()) pushData(String(value.text).trim());
            if (!sawDone) push('data: [DONE]\n\n');
            finish();
        })().catch(error => {
            if (signal?.aborted) finish();
            else fail(`Writer connection "${id}" request failed: ${error?.message ?? error}`);
        });

        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    }

    return { respond };
}
