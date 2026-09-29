/**
 * Быстрый приблизительный счётчик токенов (решение владельца: свой, без токенизаторов
 * провайдеров). Один проход по кодам символов. Коэффициенты — средние по BPE-токенизаторам
 * современных моделей; погрешность порядка 10–15 %, поэтому обрезка идёт с запасом (pm-trim.js).
 *   латиница/цифры ≈ 4 символа на токен, кириллица и прочие алфавиты ≈ 2.2, CJK ≈ 1.1 на символ,
 *   пробелы почти бесплатны (входят в слова), знаки препинания и прочее ≈ 1 на символ.
 */
const MESSAGE_OVERHEAD = 4; // роль и служебные токены сообщения

export function estimateTokens(text) {
    if (typeof text !== 'string' || !text) return 0;
    let latin = 0, other = 0, cjk = 0, punct = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 10 || c === 13 || c === 9) continue;
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++;
        else if (c < 128) punct++;
        else if ((c >= 0x3040 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
        else other++;
    }
    return Math.ceil(latin / 4 + other / 2.2 + cjk * 1.1 + punct * 0.9);
}

export function estimateMessageTokens(message) {
    let total = MESSAGE_OVERHEAD + estimateTokens(typeof message.content === 'string' ? message.content : '');
    if (Array.isArray(message.content)) for (const part of message.content) total += estimateTokens(part?.text ?? '') + (part?.type === 'image_url' ? 85 : 0);
    if (message.tool_calls) total += estimateTokens(JSON.stringify(message.tool_calls));
    return total;
}

/** Сколько токенов занимает каждый блок и всего (для превью и бюджета). */
export function summarizeTokens(messages) {
    const byBlock = new Map();
    let total = 0;
    for (const message of messages) {
        const tokens = estimateMessageTokens(message);
        total += tokens;
        const key = message._block ?? (message._hid !== undefined ? 'history' : 'other');
        byBlock.set(key, (byBlock.get(key) ?? 0) + tokens);
    }
    return { total, byBlock };
}
