/**
 * История чата ST → сообщения Chat Completion. Чистая функция над массивом
 * `chat` ST. Каждое сообщение получает `_hid` — стабильный номер в чате.
 * Вызовы инструментов (`extra.tool_invocations`) разворачиваются в пару
 * `assistant + tool_calls` → `tool`-результаты, как их отдаёт ST 1.13+. Текст
 * такой записи не уходит: это экранная сводка вызова, а пустой результат
 * уходит как `[No content]`.
 *
 * namesBehavior: -1 и 0 — имена не добавляем; 1 — префикс `Имя: ` в тексте;
 * 2 — поле `name` сообщения. Сообщения `is_system` (вставки модулей и
 * подсказки) идут как assistant.
 */
function toolMessages(invocations, hid) {
    const calls = [];
    const results = [];
    for (const item of invocations ?? []) {
        const id = item.id ?? `call_${hid}_${calls.length}`;
        calls.push({ id, type: 'function', function: { name: item.name, arguments: typeof item.parameters === 'string' ? item.parameters : JSON.stringify(item.parameters ?? {}) } });
        results.push({ role: 'tool', content: String(item.result || '[No content]'), tool_call_id: id, _hid: hid });
    }
    return calls.length ? [{ role: 'assistant', content: '', tool_calls: calls, _hid: hid }, ...results] : [];
}

export function chatToMessages(chat, { namesBehavior = 0, substitute = text => text } = {}) {
    const out = [];
    chat.forEach((entry, index) => {
        const text = substitute(String(entry?.mes ?? ''));
        const role = entry?.is_user ? 'user' : 'assistant';
        const tools = toolMessages(entry?.extra?.tool_invocations, index);
        if (!text.trim() && !tools.length) return;
        if (text.trim() && !tools.length) {
            const message = { role, content: text, _hid: index };
            const name = entry?.name;
            if (name && namesBehavior === 1) message.content = `${name}: ${text}`;
            else if (name && namesBehavior === 2) message.name = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
            out.push(message);
        }
        out.push(...tools);
    });
    return out;
}
