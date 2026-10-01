import { PROPOSAL_ACTIONS } from './guide-proposals.js';

/**
 * Разметка ответов гида (маскот движка, cores/guide) — чистые функции: текст модели → сегменты для окна чата.
 *
 * Модель пишет обычный текст с двумя расширениями:
 * - **ссылка на блок** — `[Model connections](stme:card:models)`: клик открывает панель/окно и подсвечивает блок (адреса — `ui.anchors.list`);
 *   обычные `https://` ссылки тоже понимаются; `**жирный**`, `*курсив*`, `` `код` ``; списки `- пункт` и `1. пункт`, заголовки `## Заголовок` (`parseTextBlocks`);
 * - **блок** — огороженный код с JSON и именем вида:
 *   ```choice   {"prompt": "…", "options": ["Yes", "Not now"]}                       — кнопки выбора, выбранное уходит ответом пользователя;
 *   ```card     {"title": "…", "text": "…", "anchor": "card:models"}                  — карточка с заголовком и ссылкой;
 *   ```steps    {"title": "…", "items": [{"text": "…", "anchor": "…"}]}              — нумерованные шаги со ссылками;
 *   ```action   {"label": "Enable Tracker", "action": "modules.enable", "params": {"id": "module.tracker"}} — кнопка действия (нажатие = согласие);
 *               безопасное (только чтение) действие выполняется сразу, с `"auto"` или без него, без кнопки — см. `splitAutoActions`;
 *   ```proposal {"action": "tracker.create", "params": {…}}                          — карточка «что будет создано» с кнопкой Apply (guide-create.js);
 * Кнопка выбора может сама запускать действие: `{"label": "Check now", "action": "models.check"}` — один клик, второй кнопки нет.
 *   ```checklist {}                                                                   — живой чек-лист первого запуска;
 *   ```creator  {}                                                                    — карточка создателя (данные — libraries/core/guide-creator.js).
 * Битый JSON или неизвестное имя не ломают ответ: такой кусок показывается как текст.
 */

export const BLOCK_KINDS = Object.freeze(['choice', 'card', 'steps', 'action', 'proposal', 'creator', 'checklist']);
const FENCE = /```([a-z]+)[ \t]*\n?([\s\S]*?)```/g;

function normalizeBlock(kind, data) {
    const text = value => (typeof value === 'string' ? value.trim() : '');
    if (kind === 'choice') {
        const options = (Array.isArray(data.options) ? data.options : []).map(option => (typeof option === 'string' ? { label: option.trim() } : { label: text(option?.label), send: text(option?.send) || undefined, action: text(option?.action) || undefined, params: option?.params && typeof option.params === 'object' ? option.params : undefined })).filter(option => option.label);
        return options.length ? { kind, prompt: text(data.prompt), options: options.slice(0, 6) } : null;
    }
    if (kind === 'card') return text(data.title) || text(data.text) ? { kind, title: text(data.title), text: text(data.text), anchor: text(data.anchor) || undefined } : null;
    if (kind === 'steps') {
        const items = (Array.isArray(data.items) ? data.items : []).map(item => (typeof item === 'string' ? { text: item.trim() } : { text: text(item?.text), anchor: text(item?.anchor) || undefined })).filter(item => item.text);
        return items.length ? { kind, title: text(data.title), items: items.slice(0, 12) } : null;
    }
    if (kind === 'action') {
        const action = text(data.action);
        return action ? { kind, label: text(data.label) || action, action, params: data.params && typeof data.params === 'object' ? data.params : {}, auto: data.auto === true } : null;
    }
    if (kind === 'proposal') {
        const action = text(data.action);
        return PROPOSAL_ACTIONS.includes(action) ? { kind, action, params: data.params && typeof data.params === 'object' ? data.params : {} } : null;
    }
    if (kind === 'checklist' || kind === 'creator') return { kind };
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

const INLINE = /\[([^\]]+)\]\((stme:[^)\s]+|https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`\n]+)`|(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g;

/** Строка текста → `[{ type: 'text' | 'bold' | 'italic' | 'code', text } | { type: 'anchor', label, anchor } | { type: 'url', label, url }]`. */
export function parseInline(line) {
    const source = String(line ?? '');
    const parts = [];
    let last = 0;
    for (const match of source.matchAll(INLINE)) {
        if (match.index > last) parts.push({ type: 'text', text: source.slice(last, match.index) });
        if (match[3] !== undefined) parts.push({ type: 'bold', text: match[3] });
        else if (match[4] !== undefined) parts.push({ type: 'code', text: match[4] });
        else if (match[5] !== undefined) parts.push({ type: 'italic', text: match[5] });
        else if (match[2].startsWith('stme:')) parts.push({ type: 'anchor', label: match[1], anchor: match[2].slice(5) });
        else parts.push({ type: 'url', label: match[1], url: match[2] });
        last = match.index + match[0].length;
    }
    if (last < source.length) parts.push({ type: 'text', text: source.slice(last) });
    return parts;
}

const BULLET = /^\s{0,3}(?:[-*•])\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,4}\s+(.*)$/;

/**
 * Текст реплики → блоки вёрстки: `{ type: 'p', lines: [..] }` (абзац, строки через перенос), `{ type: 'ul' | 'ol', items: [..] }` (списки — пункты `- `, `* `, `• `, `1. `; продолжение
 * пункта на следующей строке с отступом приклеивается к нему), `{ type: 'h', text }` (заголовок `#`). Пустая строка разделяет абзацы; список и абзац можно писать без пустой строки между ними.
 */
export function parseTextBlocks(text) {
    const blocks = [];
    const current = () => blocks.at(-1);
    for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
        if (!raw.trim()) { blocks.push({ type: 'gap' }); continue; }
        const heading = HEADING.exec(raw);
        if (heading) { blocks.push({ type: 'h', text: heading[1].trim() }); continue; }
        const bullet = BULLET.exec(raw);
        const numbered = bullet ? null : NUMBERED.exec(raw);
        const kind = bullet ? 'ul' : numbered ? 'ol' : null;
        if (kind) {
            const item = (bullet ?? numbered)[1].trim();
            if (current()?.type === kind) current().items.push(item); else blocks.push({ type: kind, items: [item] });
            continue;
        }
        const last = current();
        if (/^\s+\S/.test(raw) && last && (last.type === 'ul' || last.type === 'ol')) { last.items[last.items.length - 1] += ` ${raw.trim()}`; continue; }
        if (last?.type === 'p') last.lines.push(raw.trim()); else blocks.push({ type: 'p', lines: [raw.trim()] });
    }
    return blocks.filter(block => block.type !== 'gap');
}

/** Текст реплики для истории модели и облачка виджета: блоки — коротко словами, ссылки — подписью. */
export function plainText(reply) {
    return parseGuideReply(reply).map(segment => {
        if (segment.type === 'text') return parseInline(segment.text).map(part => part.text ?? part.label).join('');
        const { block } = segment;
        if (block.kind === 'choice') return `${block.prompt ? `${block.prompt} ` : ''}[${block.options.map(option => option.label).join(' / ')}]`;
        if (block.kind === 'action') return `[${block.label}]`;
        if (block.kind === 'proposal') return `[proposal: ${block.action}]`;
        if (block.kind === 'steps') return block.items.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
        if (block.kind === 'card') return [block.title, block.text].filter(Boolean).join(': ');
        if (block.kind === 'creator') return '[creator card]';
        return '[checklist]';
    }).join('\n').trim();
}

/**
 * Безопасные действия выполняются сразу (пометка `auto` не нужна — забытая модель оставляла кнопку) (человек уже попросил — второй раз кликать незачем). Возвращает
 * `{ text, actions }`: реплика без этих блоков и список того, что выполнить. Остальные блоки (и действия, меняющие состояние) не трогаются.
 */
export function splitAutoActions(reply, isSafe, isAutoProposal = () => false) {
    const source = String(reply ?? '');
    const actions = [];
    const pieces = [];
    const seen = new Set();
    let last = 0;
    for (const match of source.matchAll(FENCE)) {
        const [whole, kind, body] = match;
        let block = null;
        if (kind === 'action' || kind === 'proposal') { try { block = normalizeBlock(kind, body.trim() ? JSON.parse(body) : {}); } catch { block = null; } }
        // Безопасное (только чтение) действие выполняется само, даже если модель забыла пометить его `auto`: человек уже попросил, а кнопка «прочитать страницу» только мешает.
        // Предложение действия, которое можно применять без подтверждения (карточки персонажей: каждая правка сохраняет прежнюю версию), тоже выполняется сразу.
        if (block && (block.kind === 'proposal' ? isAutoProposal(block.action) : isSafe(block.action))) {
            // Слабая модель иногда повторяет одно и то же действие несколько раз в одной реплике: одинаковое выполняется один раз.
            const key = JSON.stringify([block.action, block.params]);
            if (!seen.has(key)) { seen.add(key); actions.push({ action: block.action, params: block.params }); }
            pieces.push(source.slice(last, match.index));
            last = match.index + whole.length;
        }
    }
    pieces.push(source.slice(last));
    // Куски между вырезанными блоками склеиваются с переводом строки: иначе «…page.```action…```Let me…» слипалось в «…page.Let me…».
    const joined = pieces.map(piece => piece.trim()).filter(Boolean).join('\n');
    return { text: dropRepeatedLines(joined).replace(/\n{3,}/g, '\n\n').trim(), actions };
}

/** Одинаковые строки обычного текста (не внутри блоков ```…```) повторяются только по сбою модели: остаётся первая. */
export function dropRepeatedLines(text) {
    let inFence = false;
    const seen = new Set();
    return String(text ?? '').split('\n').filter(line => {
        if (/^\s*```/.test(line)) { inFence = !inFence; return true; }
        if (inFence) return true;
        const key = line.replace(/\s+/g, ' ').trim().toLowerCase();
        if (key.length < 12) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).join('\n');
}

/**
 * Реплика обещает пойти и посмотреть («Let me grab her personality section…»), но блока действия в ней нет: она остановилась на словах, и человеку пришлось бы писать «ну?».
 * Вопрос в конце — не обещание. Ловит форму, поэтому только для коротких реплик без блоков.
 */
export function isUnkeptPromise(visible) {
    const text = String(visible ?? '').trim();
    if (!text || text.length > 600 || text.includes('```') || /\?\s*$/.test(text)) return false;
    return /\b(?:let me|i(?:'ll| will)|i'm going to|let's|going to)\b[^.!?\n]{0,70}\b(?:read|grab|pull(?: up)?|check|look(?: up| at| into| for)?|search|open|fetch|find|get|review|go through|dig)\b/i.test(text);
}

/**
 * Адреса блоков интерфейса, на которые ссылается реплика, в порядке появления и без повторов: ссылки в тексте, `anchor` у карточек и у пунктов шагов. Гид сам
 * открывает их по этому списку (cores/guide) — чипы в окне остаются для информации.
 */
export function extractAnchors(reply) {
    const found = [];
    const add = anchor => { if (anchor && !found.includes(anchor)) found.push(anchor); };
    for (const segment of parseGuideReply(reply)) {
        if (segment.type === 'text') { for (const part of parseInline(segment.text)) if (part.type === 'anchor') add(part.anchor); continue; }
        const { block } = segment;
        if (block.kind === 'card') add(block.anchor);
        if (block.kind === 'steps') for (const item of block.items) add(item.anchor);
    }
    return found;
}

/** Есть ли в реплике блок выбора (```choice```). */
export const hasChoice = reply => parseGuideReply(reply).some(segment => segment.type === 'block' && segment.block.kind === 'choice');

/**
 * Убирает из реплики блоки заданных видов (остальное не трогает). Два применения: предохранитель от вариантов ответа на каждом ходу (`choice`) и предохранитель «сначала посмотри,
 * потом отвечай» — реплика с `<continue/>` не должна нести готовую карточку (`proposal`) или варианты: настоящий ответ будет на следующем ходу, когда блок откроется.
 */
export function stripBlocks(reply, kinds) {
    const source = String(reply ?? '');
    let out = '';
    let last = 0;
    for (const match of source.matchAll(FENCE)) {
        if (!kinds.includes(match[1])) continue;
        out += source.slice(last, match.index);
        last = match.index + match[0].length;
    }
    return (out + source.slice(last)).replace(/\n{3,}/g, '\n\n').trim();
}

export const stripChoices = reply => stripBlocks(reply, ['choice']);
