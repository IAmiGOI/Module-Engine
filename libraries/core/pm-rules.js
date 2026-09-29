/**
 * Текстовые правила — простой язык поверх regex (решение владельца 10.1): пользователь описывает «что заменить и где»
 * словами, а regex — лишь запасной вариант «для продвинутых» и вход для импорта скриптов ST. Правила меняют ТОЛЬКО
 * исходящий промпт, сохранённый чат не трогают. Чистые функции.
 *
 * Правило: { id, name, enabled, find: { kind, ... }, replace, scope: { roles, minDepth, maxDepth, targets } }
 *   find.kind: 'text'   { value, caseSensitive, wholeWord }   — заменить фразу
 *              'remove' { value, caseSensitive, wholeWord }   — убрать фразу (то же, что replace = '')
 *              'between'{ from, to, keepEdges }               — убрать всё между двумя метками (например <think> … </think>)
 *              'regex'  { pattern, flags }                    — обычный regex (импорт и продвинутый режим)
 *   scope.roles: ['user','assistant','system'] (пусто = все); scope.minDepth/maxDepth — сколько сообщений ПОСЛЕ этого
 *   (0 — последнее сообщение); scope.targets: 'all' | 'history' | 'prompt' (только сообщения пресета, не история чата)
 */
const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Правило → RegExp (или null, если правило пустое/битое). */
export function compileRule(rule) {
    const find = rule?.find ?? {};
    try {
        if (find.kind === 'regex') return find.pattern ? new RegExp(find.pattern, find.flags?.includes('g') ? find.flags : `${find.flags ?? ''}g`) : null;
        if (find.kind === 'between') return find.from && find.to ? new RegExp(`${escapeRegex(find.from)}[\\s\\S]*?${escapeRegex(find.to)}`, 'g') : null;
        if (!find.value) return null;
        const body = escapeRegex(find.value);
        const wrapped = find.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
        return new RegExp(wrapped, `g${find.caseSensitive ? '' : 'i'}${find.wholeWord ? 'u' : ''}`);
    } catch { return null; }
}

function replacementFor(rule) {
    if (rule.find?.kind === 'remove') return '';
    if (rule.find?.kind === 'between') return rule.find.keepEdges ? `${rule.find.from}${rule.find.to}` : (rule.replace ?? '');
    return rule.replace ?? '';
}

function applies(rule, message, depth) {
    const scope = rule.scope ?? {};
    if (scope.roles?.length && !scope.roles.includes(message.role)) return false;
    if (scope.minDepth !== undefined && scope.minDepth !== null && depth < scope.minDepth) return false;
    if (scope.maxDepth !== undefined && scope.maxDepth !== null && depth > scope.maxDepth) return false;
    const isHistory = message._hid !== undefined;
    if (scope.targets === 'history' && !isHistory) return false;
    if (scope.targets === 'prompt' && isHistory) return false;
    return true;
}

/** Применяет включённые правила к сообщениям (возвращает новые объекты). Служебные `_block`/`_hid` сохраняются. */
export function applyRules(messages, rules, { substitute = text => text } = {}) {
    const active = (rules ?? []).filter(rule => rule.enabled !== false).map(rule => ({ rule, regex: compileRule(rule), replacement: replacementFor(rule) })).filter(item => item.regex);
    if (!active.length) return messages;
    return messages.map((message, index) => {
        if (typeof message.content !== 'string' || message.role === 'tool') return message;
        const depth = messages.length - 1 - index;
        let text = message.content;
        for (const { rule, regex, replacement } of active) {
            if (!applies(rule, message, depth)) continue;
            regex.lastIndex = 0;
            text = text.replace(regex, (...args) => substitute(String(replacement).replace(/\$(\d+)|\$&/g, (whole, group) => (group === undefined ? args[0] : (typeof args[Number(group)] === 'string' ? args[Number(group)] : '')))));
        }
        return text === message.content ? message : { ...message, content: text };
    });
}

const stringToRegex = source => {
    const match = /^\/([\s\S]+)\/([a-z]*)$/i.exec(String(source ?? '').trim());
    return match ? { pattern: match[1], flags: match[2] } : { pattern: String(source ?? ''), flags: '' };
};

/**
 * Скрипты регулярных выражений ST (`extensions.regex_scripts`) → правила. Берём то, что влияет на промпт: не «только
 * отображение» (`markdownOnly` без `promptOnly`). Размещение ST: 1 — ввод пользователя, 2 — ответ ИИ; остальные (команды, лорбук,
 * ризонинг) применяем ко всем сообщениям промпта. Выключенные скрипты переносятся выключенными.
 */
export function importStRegexScripts(scripts) {
    return (Array.isArray(scripts) ? scripts : []).filter(script => script && !(script.markdownOnly && !script.promptOnly)).map((script, index) => {
        const placement = Array.isArray(script.placement) ? script.placement : [];
        const roles = [placement.includes(1) ? 'user' : null, placement.includes(2) ? 'assistant' : null].filter(Boolean);
        const { pattern, flags } = stringToRegex(script.findRegex);
        return {
            id: script.id ?? `st-regex-${index}`, name: script.scriptName || `Regex ${index + 1}`, enabled: !script.disabled, imported: true,
            find: { kind: 'regex', pattern, flags }, replace: String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, '$&'),
            scope: { roles: roles.length === 2 || !roles.length ? [] : roles, minDepth: script.minDepth ?? undefined, maxDepth: script.maxDepth ?? undefined, targets: 'all' },
        };
    });
}
