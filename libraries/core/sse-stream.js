/**
 * Инкрементальный SSE-парсер — чистый, без HTTP (тот же приём, что и у
 * [provider-request.js](provider-request.js): "pure request-shaping, no
 * network of its own"). `fetch`'ные чанки НЕ совпадают с границами
 * SSE-фреймов (один чанк может обрывать строку посередине, а другой —
 * нести сразу несколько фреймов), поэтому нужен буфер между вызовами
 * `push()`, а не разовый `split('\n\n')`.
 *
 * Формат — стандартный SSE (WHATWG): фреймы разделены пустой строкой,
 * внутри фрейма строки `field: value`; здесь нужны только `event` и
 * `data` (`id`/`retry` провайдерам моделей не сдались). Несколько строк
 * `data:` в одном фрейме склеиваются через `\n` — так делает сам
 * стандарт, на случай многострочных данных.
 */
export function createSseFrameParser() {
    let buffer = '';

    /** Один необработанный блок "field: value\n..." → { event, data } либо null (пустой/комментарий). */
    function parseBlock(block) {
        let event = null;
        const dataLines = [];
        for (const rawLine of block.split('\n')) {
            const line = rawLine.replace(/\r$/, '');
            if (!line || line.startsWith(':')) continue;
            const sepIndex = line.indexOf(':');
            const field = sepIndex === -1 ? line : line.slice(0, sepIndex);
            const value = sepIndex === -1 ? '' : line.slice(sepIndex + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            else if (field === 'data') dataLines.push(value);
        }
        if (!event && !dataLines.length) return null;
        return { event, data: dataLines.join('\n') };
    }

    /** Кормит очередной кусок текста от `fetch`-ридера, возвращает ВСЕ фреймы, ставшие полными этим куском (может быть 0, 1 или несколько). */
    function push(textChunk) {
        buffer += textChunk;
        const blocks = buffer.split('\n\n');
        // Последний элемент — либо пустая строка (буфер кончился ровно на
        // границе фрейма), либо хвост незавершённого фрейма: в обоих случаях
        // он остаётся в буфере для следующего push(), не обрабатывается сейчас.
        buffer = blocks.pop() ?? '';
        return blocks.map(parseBlock).filter(Boolean);
    }

    /** Что бы ни осталось в буфере на конец потока — доразобрать (провайдер не обязан закрывать последний фрейм пустой строкой). */
    function flush() {
        if (!buffer.trim()) { buffer = ''; return []; }
        const frame = parseBlock(buffer);
        buffer = '';
        return frame ? [frame] : [];
    }

    return { push, flush };
}
