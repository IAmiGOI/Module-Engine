/**
 * Журнал отладки гида: последние ходы с тем, что пришло от провайдера (включая то, что мы обычно отбрасываем: `tool_calls`, ризонинг, `finish_reason`), что гид из этого
 * сделала (видимый текст, запущенные действия, причина продолжения или остановки). Нужен, чтобы остановки и обрывы разбирались по фактам, а не по догадкам: владелец
 * копирует журнал кнопкой в настройках окна и присылает. Чистые функции и маленькое хранилище без Шины.
 */

const ENTRY_LIMIT = 12;
const REPLY_CHARS = 6000;
const RAW_HEAD_CHARS = 2500;
const RAW_TAIL_CHARS = 3500;

/** Сводка по сырому телу ответа провайдера: SSE-кадры (`data: {…}`) или один JSON. Ничего не выбрасывает молча: что нашлось — то и в сводке. */
export function summarizeRawResponse(raw) {
    const body = String(raw?.body ?? '');
    const frames = [];
    for (const line of body.split('\n')) {
        const match = /^data:\s*(.*)$/.exec(line.trim());
        if (!match || match[1] === '[DONE]') continue;
        try { frames.push(JSON.parse(match[1])); } catch { /* обрывок кадра */ }
    }
    if (!frames.length) { try { frames.push(JSON.parse(body)); } catch { /* не JSON */ } }
    const finish = new Set();
    const toolCalls = [];
    let reasoningChars = 0;
    let contentChars = 0;
    let usage = null;
    const extraKeys = new Set();
    for (const frame of frames) {
        usage = frame?.usage ?? usage;
        for (const choice of frame?.choices ?? []) {
            if (choice.finish_reason) finish.add(choice.finish_reason);
            const part = choice.delta ?? choice.message ?? {};
            contentChars += String(part.content ?? '').length;
            reasoningChars += String(part.reasoning_content ?? part.reasoning ?? '').length;
            for (const call of part.tool_calls ?? []) toolCalls.push({ name: call?.function?.name ?? '', args: String(call?.function?.arguments ?? '').slice(0, 300) });
            for (const key of Object.keys(part)) if (!['role', 'content', 'reasoning_content', 'reasoning', 'tool_calls'].includes(key)) extraKeys.add(key);
        }
        if (frame?.type === 'message_delta' && frame?.delta?.stop_reason) finish.add(frame.delta.stop_reason);
    }
    return {
        status: raw?.status ?? null, format: raw?.format ?? '', frames: frames.length, finishReasons: [...finish],
        providerToolCalls: toolCalls.slice(0, 10), reasoningChars, contentChars, usage, otherDeltaKeys: [...extraKeys],
        bodyChars: body.length, bodyHead: body.slice(0, RAW_HEAD_CHARS), bodyTail: body.length > RAW_HEAD_CHARS ? body.slice(-RAW_TAIL_CHARS) : '',
    };
}

/** Хранилище последних ходов: `begin` открывает запись хода (её дополняют по ходу работы), `attachRaw` пришивает к ней сводку сырого ответа по `requestId`. */
export function createDebugLog({ now = () => Date.now(), limit = ENTRY_LIMIT } = {}) {
    const entries = [];
    let counter = 0;
    return {
        begin(info = {}) {
            counter += 1;
            const entry = { n: counter, at: now(), ...info };
            entries.push(entry);
            while (entries.length > limit) entries.shift();
            return entry;
        },
        attachRaw(requestId, raw) {
            const entry = entries.find(item => item.requestId === requestId);
            if (entry) entry.raw = summarizeRawResponse(raw);
            return Boolean(entry);
        },
        entries: () => entries,
        /** Текст для копирования: заголовок со сведениями о сборке и записи ходов (длинное обрезано). */
        toText(meta = {}) {
            const shown = entries.map(entry => ({
                ...entry, at: new Date(entry.at).toISOString(),
                ...(typeof entry.reply === 'string' ? { reply: entry.reply.length > REPLY_CHARS ? `${entry.reply.slice(0, REPLY_CHARS)}… [+${entry.reply.length - REPLY_CHARS} chars]` : entry.reply } : {}),
            }));
            return `${JSON.stringify({ guideDebugLog: 1, meta, turns: shown }, null, 1)}\n`;
        },
    };
}
