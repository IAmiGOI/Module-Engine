/**
 * Группа с обёрткой отдаёт модели ОДНО сообщение `<tag>\n…содержимое…\n</tag>` (решение владельца, ROADMAP.md 5.140:
 * теги — встроенная функция группы, а не отдельные промпты). Пустая группа не отправляет ничего.
 *
 * Склейка в одно сообщение — только когда она ничего не меняет по смыслу: у всего содержимого та же роль, что у тегов,
 * это обычный текст (без вызовов инструментов и без сообщений истории). Иначе — прежняя форма: тег, содержимое, тег
 * отдельными сообщениями.
 *
 * Обычные группы склеиваются ПОСЛЕ обрезки (`joinWrappers`): сборщик помечает теги `_open`/`_close`, а обрезка
 * по-прежнему видит каждый блок отдельно со своим приоритетом. Если обрезка сняла всё содержимое — теги тоже не уходят.
 */
const mergeable = (message, role) => message.role === role && typeof message.content === 'string'
    && !message.tool_calls && message._hid === undefined && !message._historySlot;

/** Открывающий тег, содержимое, закрывающий тег → [] (пусто) | [одно сообщение] | [как было]. */
export function mergeWrapped(open, inner, close, groupId) {
    if (!inner.length) return [];
    const role = open?.role ?? 'system';
    if (!open || !close || close.role !== role || !inner.every(message => mergeable(message, role))) {
        return [open, ...inner, close].filter(Boolean).map(({ _open, _close, ...rest }) => rest);
    }
    const content = [open.content, ...inner.map(message => message.content), close.content].join('\n');
    return [{ role, content, _block: groupId }];
}

/** Склейка помеченных групп в готовом (уже обрезанном) списке. Вложенные группы склеиваются изнутри наружу. */
export function joinWrappers(messages) {
    const out = [];
    const stack = []; // { open, items }
    const target = () => stack.at(-1)?.items ?? out;
    for (const message of messages) {
        if (message._open !== undefined) { stack.push({ open: message, items: [] }); continue; }
        if (message._close !== undefined && stack.at(-1)?.open._open === message._close) {
            const frame = stack.pop();
            target().push(...mergeWrapped(frame.open, frame.items, message, message._close));
            continue;
        }
        target().push(message);
    }
    // Незакрытая группа (закрывающий тег не дошёл) — всё как есть, без потерь.
    while (stack.length) { const frame = stack.pop(); target().push(frame.open, ...frame.items); }
    return out;
}
