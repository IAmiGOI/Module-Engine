import { BASE_STYLE, deriveStyle } from './style.js';
import { legacyColor } from './legacy-color.js';

/**
 * Разбор HTML тела сообщения в блоки раскладки + детектор поддержки. Вход — корень DOM-подобного дерева (настоящий HTML-парсер браузера
 * инжектируется снаружи, как `normalizeHtmlToXml` у `services/html-rasterizer.js`; в тестах — фейковые узлы с тем же интерфейсом:
 * `nodeType`, `tagName`, `childNodes`, `data`, `getAttribute`, `attributes`).
 *
 * Правило поддержки — БЕЛЫЙ список: всё, чего здесь нет, отдаётся старому пути (зеркало + SVG-растр) целым сообщением. Лучше лишний раз
 * уйти на старый путь, чем нарисовать не так, как нарисовал бы браузер.
 *
 * Блоки: `para` (строчное содержимое), `list`, `quote`, `group` (div/center — контейнер с выравниванием), `rule` (hr). У блока верхнего
 * уровня `gap: true`, если перед ним есть элемент-сосед (правило `> * + *` зеркала/растра), кроме заглушки аватарки.
 */

export const AVATAR_SPACER_CLASS = 'stme-chat-viewport-avatar-spacer';

const INLINE_TAGS = new Set(['EM', 'I', 'STRONG', 'B', 'U', 'INS', 'S', 'STRIKE', 'DEL', 'A', 'Q', 'SPAN', 'FONT', 'BR', 'IMG']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'CENTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'HR']);
const HEADING_SCALE = { H1: 2, H2: 1.5, H3: 1.17, H4: 1, H5: 0.83, H6: 0.67 };
/** Атрибуты, не влияющие ни на раскладку, ни на цвет. Всё прочее (`style`, `align`, `dir`, `hidden`, `width` у не-картинок…) — старый путь. */
const NEUTRAL_ATTRIBUTES = new Set(['class', 'title', 'lang', 'id', 'aria-hidden', 'role', 'data-mesid', 'translate', 'spellcheck']);
const SPAN_STYLE_PROPERTIES = new Set(['color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line']);
/** Справа-налево и письменности, которым нужен словарный перенос или сложное формообразование — не в объёме раскладчика. */
const UNSUPPORTED_SCRIPTS = /[֐-ࣿऀ-෿฀-࿿က-႟ក-៿᠀-᢯יִ-﷿ﹰ-﻿­]/;

class Unsupported extends Error {
    constructor(reason) { super(reason); this.reason = reason; }
}
const fail = reason => { throw new Unsupported(reason); };

function attributeNames(node) {
    if (node.attributes) return Array.from(node.attributes, attribute => attribute.name.toLowerCase());
    return [];
}

function checkAttributes(node, allowed = []) {
    for (const name of attributeNames(node)) {
        if (NEUTRAL_ATTRIBUTES.has(name) || name.startsWith('data-') || allowed.includes(name)) continue;
        fail(`attribute "${name}" on <${node.tagName.toLowerCase()}>`);
    }
}

/** `color: red; font-weight: bold` → Map. Значения с `!important`/`var()` — старый путь (не знаем, чем они разрешатся). */
export function parseStyleAttribute(text) {
    const declarations = new Map();
    for (const chunk of String(text ?? '').split(';')) {
        const index = chunk.indexOf(':');
        if (index < 0) { if (chunk.trim()) fail(`malformed style "${chunk.trim()}"`); continue; }
        const property = chunk.slice(0, index).trim().toLowerCase();
        const value = chunk.slice(index + 1).trim();
        if (!property) continue;
        if (/!important|var\(|expression|url\(/i.test(value)) fail(`style value "${value}"`);
        declarations.set(property, value);
    }
    return declarations;
}

function applySpanStyle(style, declarations) {
    const patch = {};
    for (const [property, value] of declarations) {
        if (!SPAN_STYLE_PROPERTIES.has(property)) fail(`style property "${property}"`);
        const lower = value.toLowerCase();
        if (property === 'color') patch.color = value;
        else if (property === 'font-weight') {
            if (lower === 'bold' || lower === 'bolder') patch.weight = 700;
            else if (lower === 'normal') patch.weight = 400;
            else if (/^[1-9]00$/.test(lower)) patch.weight = Number(lower);
            else fail(`font-weight "${value}"`);
        } else if (property === 'font-style') {
            if (lower === 'italic' || lower === 'oblique') patch.italic = true;
            else if (lower === 'normal') patch.italic = false;
            else fail(`font-style "${value}"`);
        } else {
            const words = lower.split(/\s+/);
            if (words.some(word => !['underline', 'line-through', 'none'].includes(word))) fail(`text-decoration "${value}"`);
            patch.underline = words.includes('underline');
            patch.strike = words.includes('line-through');
        }
    }
    return deriveStyle(style, patch);
}

/** Контекст строчного обхода: стиль + флаги, от которых зависит наследование цвета (`q em`, `font[color] q` в CSS тела). */
function inlineChild(node, context, out) {
    const tag = node.tagName;
    let { style, inQuote, inFontColor } = context;
    switch (tag) {
        case 'BR': checkAttributes(node); out.push({ t: 'br' }); return;
        case 'IMG': {
            checkAttributes(node, ['src', 'alt', 'width', 'height', 'loading', 'decoding']);
            const src = node.getAttribute('src');
            if (!src) fail('<img> without src');
            const size = name => { const raw = node.getAttribute(name); if (raw === null || raw === undefined || raw === '') return null; if (!/^\d+(\.\d+)?$/.test(raw)) fail(`img ${name}="${raw}"`); return Number(raw); };
            out.push({ t: 'img', src, width: size('width'), height: size('height') });
            return;
        }
        case 'EM': case 'I': checkAttributes(node); style = deriveStyle(style, { italic: true, ...(inQuote || inFontColor ? {} : { color: '@em' }) }); break;
        case 'STRONG': case 'B': checkAttributes(node); style = deriveStyle(style, { weight: 700 }); break;
        case 'U': case 'INS': checkAttributes(node); style = deriveStyle(style, { underline: true }); break;
        case 'S': case 'STRIKE': case 'DEL': checkAttributes(node); style = deriveStyle(style, { strike: true }); break;
        case 'A': checkAttributes(node, ['href', 'target', 'rel']); style = deriveStyle(style, { underline: true, color: inFontColor ? style.color : '@link' }); break;
        case 'Q': checkAttributes(node, ['cite']); if (!inFontColor) style = deriveStyle(style, { color: '@quote' }); inQuote = true; break;
        case 'SPAN': checkAttributes(node, ['style']); style = applySpanStyle(style, parseStyleAttribute(node.getAttribute('style'))); break;
        case 'FONT': {
            checkAttributes(node, ['color']);
            const color = legacyColor(node.getAttribute('color'));
            if (color) { style = deriveStyle(style, { color }); inFontColor = true; }
            break;
        }
        default: fail(`inline <${tag.toLowerCase()}>`);
    }
    collectInlines(node.childNodes, { style, inQuote, inFontColor }, out);
}

function collectInlines(nodes, context, out) {
    for (const node of nodes) {
        if (node.nodeType === 3) {
            if (UNSUPPORTED_SCRIPTS.test(node.data)) fail('unsupported script or soft hyphen');
            out.push({ t: 'text', text: node.data, style: context.style });
        } else if (node.nodeType === 1) {
            if (BLOCK_TAGS.has(node.tagName)) fail(`block <${node.tagName.toLowerCase()}> inside inline content`);
            if (!INLINE_TAGS.has(node.tagName)) fail(`<${node.tagName.toLowerCase()}>`);
            inlineChild(node, context, out);
        }
    }
    return out;
}

function isSpacer(node) {
    return node.nodeType === 1 && node.tagName === 'DIV' && String(node.getAttribute('class') ?? '').split(/\s+/).includes(AVATAR_SPACER_CLASS);
}

/** Заглушка аватарки → исключение для строк: `{ width, height }` из её `style` (float-коробка в левом верхнем углу тела). */
function readSpacer(node) {
    const declarations = parseStyleAttribute(node.getAttribute('style'));
    const px = name => { const match = /^(\d+(?:\.\d+)?)px$/.exec(declarations.get(name) ?? ''); if (!match) fail(`spacer ${name}`); return Number(match[1]); };
    if (declarations.get('float') !== 'left') fail('spacer is not float:left');
    return { width: px('width'), height: px('height') };
}

function hasRealContent(inlines) {
    return inlines.some(item => item.t !== 'text' || /[^ \t\n\r\f]/.test(item.text));
}

/**
 * Поток блоков внутри контейнера. Строчное содержимое между блоками собирается в анонимный абзац (у него нет `gap`: `> * + *` бьёт по
 * элементам, а не по анонимным коробкам). `topLevel` — корень тела: только там действует промежуток между блоками.
 */
function parseFlow(nodes, context, { topLevel = false, listDepth = 0 } = {}) {
    const blocks = [];
    let pending = [];
    let seenElement = false;
    let afterSpacer = false;
    let exclusion = null;
    const flush = () => {
        if (pending.length && hasRealContent(pending)) blocks.push({ kind: 'para', inlines: pending, style: context.style, align: context.align, gap: false });
        pending = [];
    };
    for (const node of nodes) {
        if (node.nodeType === 3) { collectInlines([node], context, pending); continue; }
        if (node.nodeType !== 1) continue;
        const tag = node.tagName;
        if (topLevel && !seenElement && isSpacer(node)) {
            exclusion = readSpacer(node);
            seenElement = true;
            afterSpacer = true;
            continue;
        }
        const gap = topLevel && seenElement && !afterSpacer;
        seenElement = true;
        afterSpacer = false;
        if (INLINE_TAGS.has(tag)) { collectInlines([node], context, pending); continue; }
        if (!BLOCK_TAGS.has(tag)) fail(`<${tag.toLowerCase()}>`);
        flush();
        blocks.push(parseBlock(node, context, gap, listDepth));
    }
    flush();
    return { blocks, exclusion };
}

function parseBlock(node, context, gap, listDepth) {
    const tag = node.tagName;
    if (tag === 'P') {
        checkAttributes(node);
        return { kind: 'para', inlines: collectInlines(node.childNodes, context, []), style: context.style, align: context.align, gap };
    }
    if (HEADING_SCALE[tag]) {
        checkAttributes(node);
        const style = deriveStyle(context.style, { weight: 700, scale: HEADING_SCALE[tag] });
        return { kind: 'para', inlines: collectInlines(node.childNodes, { ...context, style }, []), style, align: context.align, gap };
    }
    if (tag === 'HR') {
        checkAttributes(node);
        if (node.childNodes.length) fail('<hr> with children');
        return { kind: 'rule', gap };
    }
    if (tag === 'DIV' || tag === 'CENTER' || tag === 'BLOCKQUOTE') {
        checkAttributes(node, tag === 'BLOCKQUOTE' ? ['cite'] : []);
        const inner = tag === 'CENTER' ? { ...context, align: 'center' } : context;
        const flow = parseFlow(node.childNodes, inner, { listDepth });
        if (flow.exclusion) fail('avatar spacer outside the body root');
        return { kind: tag === 'BLOCKQUOTE' ? 'quote' : 'group', blocks: flow.blocks, align: inner.align, gap };
    }
    // UL / OL
    checkAttributes(node, tag === 'OL' ? ['start'] : []);
    let start = 1;
    if (tag === 'OL' && node.getAttribute('start') !== null && node.getAttribute('start') !== undefined) {
        const raw = String(node.getAttribute('start')).trim();
        if (!/^-?\d+$/.test(raw)) fail(`ol start="${raw}"`);
        start = Number(raw);
    }
    const items = [];
    for (const child of node.childNodes) {
        if (child.nodeType === 3) { if (/[^ \t\n\r\f]/.test(child.data)) fail('text directly inside a list'); continue; }
        if (child.nodeType !== 1) continue;
        if (child.tagName !== 'LI') fail(`<${child.tagName.toLowerCase()}> directly inside a list`);
        checkAttributes(child);
        items.push(parseFlow(child.childNodes, context, { listDepth: listDepth + 1 }).blocks);
    }
    return { kind: 'list', ordered: tag === 'OL', start, depth: listDepth, items, markerStyle: context.style, gap };
}

/**
 * Корень тела → `{ ok: true, blocks, exclusion }` или `{ ok: false, reason }`. Ничего не бросает наружу: причина отказа — строка для отчёта
 * (сколько и почему ушло на старый путь).
 */
export function parseBody(root) {
    try {
        const { blocks, exclusion } = parseFlow(root?.childNodes ?? [], { style: BASE_STYLE, align: 'left', inQuote: false, inFontColor: false }, { topLevel: true });
        return { ok: true, blocks, exclusion };
    } catch (error) {
        if (error instanceof Unsupported) return { ok: false, reason: error.reason };
        throw error;
    }
}
