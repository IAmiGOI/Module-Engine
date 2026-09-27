/**
 * Разметка ответов гида (маскот движка, cores/guide) — чистые функции: текст модели → сегменты для окна чата.
 *
 * Модель пишет обычный текст с двумя расширениями:
 * - **ссылка на блок** — `[Model connections](stme:card:models)`: клик открывает панель/окно и подсвечивает блок (адреса — `ui.anchors.list`);
 *   обычные `https://` ссылки тоже понимаются; `**жирный**` — жирный;
 * - **блок** — огороженный код с JSON и именем вида:
 *   ```choice   {"prompt": "…", "options": ["Yes", "Not now"]}                       — кнопки выбора, выбранное уходит ответом пользователя;
 *   ```card     {"title": "…", "text": "…", "anchor": "card:models"}                  — карточка с заголовком и ссылкой;
 *   ```steps    {"title": "…", "items": [{"text": "…", "anchor": "…"}]}              — нумерованные шаги со ссылками;
 *   ```action   {"label": "Enable Tracker", "action": "modules.enable", "params": {"id": "module.tracker"}} — кнопка действия (нажатие = согласие);
 *   ```checklist {}                                                                   — живой чек-лист первого запуска.
 * Битый JSON или неизвестное имя не ломают ответ: такой кусок показывается как текст.
 */

export const BLOCK_KINDS = Object.freeze(['choice', 'card', 'steps', 'action', 'checklist']);
const FENCE = /```([a-z]+)[ \t]*\n?([\s\S]*?)```/g;

function normalizeBlock(kind, data) {
    const text = value => (typeof value === 'string' ? value.trim() : '');
    if (kind === 'choice') {
        const options = (Array.isArray(data.options) ? data.options : []).map(option => (typeof option === 'string' ? { label: option.trim() } : { label: text(option?.label), send: text(option?.send) || undefined })).filter(option => option.label);
        return options.length ? { kind, prompt: text(data.prompt), options: options.slice(0, 6) } : null;
    }
    if (kind === 'card') return text(data.title) || text(data.text) ? { kind, title: text(data.title), text: text(data.text), anchor: text(data.anchor) || undefined } : null;
    if (kind === 'steps') {
        const items = (Array.isArray(data.items) ? data.items : []).map(item => (typeof item === 'string' ? { text: item.trim() } : { text: text(item?.text), anchor: text(item?.anchor) || undefined })).filter(item => item.text);
        return items.length ? { kind, title: text(data.title), items: items.slice(0, 12) } : null;
    }
    if (kind === 'action') {
        const action = text(data.action);
        return action ? { kind, label: text(data.label) || action, action, params: data.params && typeof data.params === 'object' ? data.params : {} } : null;
    }
    if (kind === 'checklist') return { kind };
    return null;
}

/** Ответ → `[{ type: 'text', text } | { type: 'block', block }]`. */
export function parseGuideReply(reply) {
    const source = String(reply ?? '');
    const segments = [];
    let last = 0;
    const pushText = value => { const trimmed = value.replace(/^\n+|\n+$/g, ''); if (trimmed.trim()) segments.push({ type: 'text', text: trimmed }); };
    for (const match of source.matchAll(FENCE)) {
        const [whole, kind, body] = match;
        let block = null;
        if (BLOCK_KINDS.includes(kind)) {
            try { block = normalizeBlock(kind, body.trim() ? JSON.parse(body) : {}); } catch { block = null; }
        }
        pushText(source.slice(last, match.index));
        if (block) segments.push({ type: 'block', block }); else pushText(whole);
        last = match.index + whole.length;
    }
    pushText(source.slice(last));
    return segments;
}

const INLINE = /\[([^\]]+)\]\((stme:[^)\s]+|https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*/g;

/** Строка текста → `[{ type: 'text' | 'bold', text } | { type: 'anchor', label, anchor } | { type: 'url', label, url }]`. */
export function parseInline(line) {
    const source = String(line ?? '');
    const parts = [];
    let last = 0;
    for (const match of source.matchAll(INLINE)) {
        if (match.index > last) parts.push({ type: 'text', text: source.slice(last, match.index) });
        if (match[3] !== undefined) parts.push({ type: 'bold', text: match[3] });
        else if (match[2].startsWith('stme:')) parts.push({ type: 'anchor', label: match[1], anchor: match[2].slice(5) });
        else parts.push({ type: 'url', label: match[1], url: match[2] });
        last = match.index + match[0].length;
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
    return parts;
}

/** Текст реплики для истории модели и облачка виджета: блоки — коротко словами, ссылки — подписью. */
export function plainText(reply) {
    return parseGuideReply(reply).map(segment => {
        if (segment.type === 'text') return parseInline(segment.text).map(part => part.text ?? part.label).join('');
        const { block } = segment;
        if (block.kind === 'choice') return `${block.prompt ? `${block.prompt} ` : ''}[${block.options.map(option => option.label).join(' / ')}]`;
        if (block.kind === 'action') return `[${block.label}]`;
        if (block.kind === 'steps') return block.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
        if (block.kind === 'card') return [block.title, block.text].filter(Boolean).join(': ');
        return '[checklist]';
    }).join('\n').trim();
}
