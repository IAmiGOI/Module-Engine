/**
 * Провод синхронизации между двумя устройствами: запрос-ответ поверх ЛЮБОГО упорядоченного надёжного канала кадров (в живом
 * движке — WebRTC DataChannel, в тестах — пара функций в памяти). Файлы едут как бинарные тела запроса/ответа, порезанные на
 * куски: DataChannel не любит кадры больше ~16 КБ, а целиком гнать 200-мегабайтный фон через одно сообщение нельзя.
 *
 * Кадры двух видов:
 *   текстовый JSON  `{t:'req', id, m, p, size}` / `{t:'res', id, ok, r | e, size}` — заголовок вызова, `size` — длина тела в байтах;
 *   бинарный        `[1 байт: 0 тело запроса | 1 тело ответа][4 байта: id][данные]`.
 * Обе стороны равноправны (каждая и вызывает, и обслуживает); признак «запрос/ответ» в бинарном кадре снимает путаницу, когда у
 * двух сторон совпали номера вызовов. Тайм-аут — по простою: пока по вызову идут данные, он не истекает (файлы бывают большими).
 */

const HEADER_BYTES = 5;
const BODY_OF_REQUEST = 0;
const BODY_OF_RESPONSE = 1;
const READ_SLICE_BYTES = 1024 * 1024;

const sizeOf = body => (body == null ? 0 : (body.size ?? body.byteLength ?? 0));

async function readSlice(body, start, end) {
    if (typeof body.slice === 'function' && typeof body.arrayBuffer === 'function') return new Uint8Array(await body.slice(start, end).arrayBuffer());
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    return bytes.subarray(start, end);
}

function frameOf(kind, id, bytes) {
    const out = new Uint8Array(HEADER_BYTES + bytes.byteLength);
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, id);
    out.set(bytes, HEADER_BYTES);
    return out;
}

export function createRpcEndpoint({
    send,
    drain = async () => {},
    handlers = {},
    chunkBytes = 16 * 1024,
    idleTimeoutMs = 30000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    BlobCtor = globalThis.Blob,
} = {}) {
    let nextId = 1;
    let closed = false;
    const pending = new Map();     // id -> { resolve, reject, timer }
    const incoming = new Map();    // `${kind}:${id}` -> assembler

    function armIdle(id) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimer(entry.timer);
        entry.timer = setTimer(() => { pending.delete(id); entry.reject(new Error(`sync call "${entry.method}" timed out (no data for ${idleTimeoutMs} ms)`)); }, idleTimeoutMs);
    }

    async function sendBody(kind, id, body) {
        const total = sizeOf(body);
        for (let start = 0; start < total; start += READ_SLICE_BYTES) {
            const slice = await readSlice(body, start, Math.min(total, start + READ_SLICE_BYTES));
            for (let offset = 0; offset < slice.byteLength; offset += chunkBytes) {
                await send(frameOf(kind, id, slice.subarray(offset, Math.min(slice.byteLength, offset + chunkBytes))));
                await drain();
            }
        }
    }

    function assemble(key, size, onDone) {
        if (size <= 0) { onDone(undefined); return; }
        incoming.set(key, { parts: [], got: 0, size, onDone });
    }

    async function serve(id, method, params, body) {
        let answer;
        try {
            const handler = handlers[method];
            if (!handler) throw new Error(`unknown sync method "${method}"`);
            answer = await handler(params, { body });
        } catch (error) {
            await send(JSON.stringify({ t: 'res', id, ok: false, e: error?.message ?? String(error) }));
            return;
        }
        const hasEnvelope = answer && typeof answer === 'object' && ('result' in answer || 'body' in answer);
        const result = hasEnvelope ? answer.result : answer;
        const outBody = hasEnvelope ? answer.body : undefined;
        const size = sizeOf(outBody);
        await send(JSON.stringify({ t: 'res', id, ok: true, r: result ?? null, size }));
        if (size) await sendBody(BODY_OF_RESPONSE, id, outBody);
    }

    function receiveText(text) {
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (message.t === 'req') {
            assemble(`${BODY_OF_REQUEST}:${message.id}`, message.size ?? 0, blob => { serve(message.id, message.m, message.p, blob); });
        } else if (message.t === 'res') {
            const entry = pending.get(message.id);
            if (!entry) return;
            const finish = body => { clearTimer(entry.timer); pending.delete(message.id); if (message.ok) entry.resolve({ result: message.r, body }); else entry.reject(new Error(message.e ?? 'sync call failed')); };
            if (message.ok && message.size > 0) { assemble(`${BODY_OF_RESPONSE}:${message.id}`, message.size, finish); armIdle(message.id); } else finish(undefined);
        }
    }

    function receiveBinary(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.byteLength < HEADER_BYTES) return;
        const kind = bytes[0];
        const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
        const key = `${kind}:${id}`;
        const entry = incoming.get(key);
        if (!entry) return;
        entry.parts.push(bytes.slice(HEADER_BYTES));
        entry.got += bytes.byteLength - HEADER_BYTES;
        if (kind === BODY_OF_RESPONSE) armIdle(id);
        if (entry.got >= entry.size) { incoming.delete(key); entry.onDone(new BlobCtor(entry.parts)); }
    }

    return {
        receive(frame) {
            if (closed) return;
            if (typeof frame === 'string') receiveText(frame); else receiveBinary(frame);
        },
        /** `body` — Blob/Uint8Array или ничего. Резолвится `{ result, body }`; ошибка обработчика на той стороне — отказ промиса. */
        async call(method, params, { body } = {}) {
            if (closed) throw new Error('sync channel is closed');
            const id = nextId; nextId += 1;
            const size = sizeOf(body);
            const promise = new Promise((resolve, reject) => { pending.set(id, { resolve, reject, timer: null, method }); });
            armIdle(id);
            try {
                await send(JSON.stringify({ t: 'req', id, m: method, p: params ?? null, size }));
                if (size) await sendBody(BODY_OF_REQUEST, id, body);
            } catch (error) {
                const entry = pending.get(id);
                if (entry) { clearTimer(entry.timer); pending.delete(id); }
                throw error;
            }
            armIdle(id);
            return promise;
        },
        close(reason = new Error('sync channel closed')) {
            closed = true;
            for (const entry of pending.values()) { clearTimer(entry.timer); entry.reject(reason); }
            pending.clear();
            incoming.clear();
        },
        get pendingCalls() { return pending.size; },
    };
}

/** Пара связанных в памяти концов — для тестов и для «локальной» проверки протокола без сети. */
export function createLinkedEndpoints(optionsA = {}, optionsB = {}) {
    let a; let b;
    const deliver = target => frame => { queueMicrotask(() => target().receive(frame instanceof Uint8Array ? frame.slice() : frame)); };
    a = createRpcEndpoint({ ...optionsA, send: deliver(() => b) });
    b = createRpcEndpoint({ ...optionsB, send: deliver(() => a) });
    return { a, b };
}
