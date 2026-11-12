/**
 * Первое сообщение чата в том виде, в каком оно выбрано сейчас: ST держит текст активного свайпа в `mes`.
 * Богу и Директору — откуда и когда начинается история. Нет сервиса или чата — пустая строка.
 */
/** Отпечаток завязки: изменилась ли она после того, как Бог её изучил. */
export function openingHash(textValue) {
    let hash = 7;
    for (const char of String(textValue ?? '').trim()) hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
    return String(textValue ?? '').trim() ? `o${hash.toString(36)}` : '';
}

export async function readOpening(callService) {
    if (typeof callService !== 'function') return '';
    try {
        const rows = await callService('stChat.messages', { mesids: ['0'], includeSystem: true });
        const first = Array.isArray(rows) ? rows.find(row => String(row?.mesid) === '0') : null;
        return first && !first.isUser ? String(first.text ?? '').trim() : '';
    } catch { return ''; }
}
