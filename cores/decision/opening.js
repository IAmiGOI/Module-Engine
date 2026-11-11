/**
 * Первое сообщение чата в том виде, в каком оно выбрано сейчас: ST держит текст активного свайпа в `mes`.
 * Богу и Директору — откуда и когда начинается история. Нет сервиса или чата — пустая строка.
 */
export async function readOpening(callService) {
    if (typeof callService !== 'function') return '';
    try {
        const rows = await callService('stChat.messages', { mesids: ['0'], includeSystem: true });
        const first = Array.isArray(rows) ? rows.find(row => String(row?.mesid) === '0') : null;
        return first && !first.isUser ? String(first.text ?? '').trim() : '';
    } catch { return ''; }
}
