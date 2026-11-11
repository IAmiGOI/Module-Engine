/**
 * Отчёт Советнику о том, что сделали Бог и Директор с отправленным (Молитвой,
 * Петицией): что пришло и какие файлы они изменили, с их комментариями. Советник
 * не будит дорогие роли переспросом — он читает их запись. Чистые функции.
 */
const text = value => String(value ?? '').trim();
// Форма (check_reports) и проверка файла (review_file) — план и сверка, не дело: Советник принимал их за сделанное.
const SILENT = new Set(['view', 'await', 'ask', 'resolve_proposals', 'check_reports', 'review_file']);

/** Вызовы роли → строки «что сделано»: правки и созданные файлы с комментарием. */
export function actionLines(toolCalls = []) {
    const lines = [];
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = text(call?.name);
        if (!name || SILENT.has(name) || call?.error || call?.result?.ok === false) continue;
        const args = call?.args ?? {};
        const paths = name === 'edit'
            ? [...new Set((Array.isArray(args.edits) ? args.edits : []).map(item => text(item?.path)).filter(Boolean))]
            : [text(args.path) || text(args.character)].filter(Boolean);
        const comment = text(call?.comment) || text(args.comment);
        lines.push(`- ${name}${paths.length ? ` ${paths.join(', ')}` : ''}${comment ? ` — ${comment}` : ''}`);
    }
    return lines;
}

/** Готовый отчёт: кто ответил, на что и что сделал. Пусто — отчитываться не о чем. */
export function statusReport({ role = 'God', handled = [], toolCalls = [], failed = false, account = '' } = {}) {
    const items = (Array.isArray(handled) ? handled : []).map(text).filter(Boolean);
    if (!items.length) return '';
    const actions = actionLines(toolCalls);
    return [
        `${role} has answered what you sent:`,
        ...items.map(item => `- ${item}`),
        '',
        failed ? `${role} stopped with an error before it finished.` : (actions.length ? `What ${role} did:\n${actions.join('\n')}` : `${role} changed nothing.`),
        ...(text(account) ? ['', `${role}'s own account: ${text(account)}`] : []),
    ].join('\n');
}
