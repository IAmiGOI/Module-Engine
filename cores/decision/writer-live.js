import { translateWriterFrame, writerErrorBody, writerErrorMessage } from '../../libraries/core/writer-response.js';

/**
 * Живой поток писателя без проверки классификатором (часть 11): кадры
 * провайдера сразу уходят в ST. Вынесено из `writer-proxy.js`, чтобы файл
 * держался в разумном размере. Повторы здесь невозможны после первого кадра:
 * текст уже у пользователя, и второй проход задвоил бы ответ.
 */

const STALL_MS = 120000;
const isDone = data => String(data ?? '').trim() === '[DONE]';

export function buildLiveStreamResponse(context, { network } = {}) {
    const { id, signal, targetFormat } = context;
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
    // Итог потока — чтобы обрыв без текста не прятался: причина конца, сколько пришло текста и мыслей, последний кадр.
    const tally = { content: 0, reasoning: 0, finish: '', last: '' };
    const count = data => {
        try {
            const choice = JSON.parse(data)?.choices?.[0] ?? {};
            tally.content += String(choice.delta?.content ?? choice.message?.content ?? '').length;
            tally.reasoning += String(choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? '').length;
            if (choice.finish_reason) tally.finish = String(choice.finish_reason);
        } catch { /* не json — [DONE] или мусор */ }
        if (!isDone(data)) tally.last = data.slice(0, 300);
    };
    const report = how => {
        try { console.warn(`[ME writer] stream ${how}: text ${tally.content} chars, reasoning ${tally.reasoning} chars, finish_reason ${tally.finish || 'none'}; last frame: ${tally.last}`); } catch { /* консоли нет */ }
    };
    const pushData = data => {
        count(data);
        const translated = translateWriterFrame(data, targetFormat);
        if (translated === null) return;
        if (translated === '[DONE]') sawDone = true;
        sawFrame = true;
        push(`data: ${translated}\n\n`);
    };
    (async () => {
        if (signal?.aborted) { finish(); return; }
        const result = await network({
            ...context.requestFor(context.messages), stream: true, signal, stallMs: STALL_MS,
            onChunk: frame => { const data = String(frame?.data ?? ''); if (data) pushData(data); },
        });
        if (signal?.aborted) { report('stopped by the caller'); finish(); return; }
        if (!result.ok) { report('failed'); fail(`Writer connection "${id}" request failed: ${result.error.message}`); return; }
        const value = result.value;
        if (!value.ok) { report(`HTTP ${value.status}`); fail(writerErrorMessage(id, value.status, value.text)); return; }
        if (!sawFrame && String(value.text ?? '').trim()) pushData(String(value.text).trim());
        report('ended');
        if (!tally.content) {
            fail(`Writer connection "${id}" ended without reply text (finish_reason: ${tally.finish || 'none'}, reasoning ${tally.reasoning} chars). Last frame: ${tally.last || 'none'}`);
            return;
        }
        if (!sawDone) push('data: [DONE]\n\n');
        finish();
    })().catch(error => {
        report(`threw ${error?.message ?? error}`);
        if (signal?.aborted) finish();
        else fail(`Writer connection "${id}" request failed: ${error?.message ?? error}`);
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

export { STALL_MS };
