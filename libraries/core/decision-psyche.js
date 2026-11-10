/**
 * psyche.md — строки механизмов и темпа психики. Модель отвечает обычным
 * текстом, движок оставляет из него только сами строки.
 */

/** Ответ модели → строки psyche.md: без списков, заголовков и пустых строк. */
export function psycheLines(value) {
    return String(value ?? '')
        .replace(/```[a-z]*\n?/gi, '')
        .split('\n')
        .map(line => line.replace(/^\s*[-*]\s+/, '').replace(/^#+\s*/, '').trim())
        .filter(Boolean);
}
