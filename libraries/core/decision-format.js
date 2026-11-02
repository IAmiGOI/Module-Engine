import { parseModelJson } from './parse-model-json.js';

/**
 * Формат ответа директора и правки блоков о персонаже — чистые функции.
 *
 * Ответ директора — один JSON-объект `{ decision, blocks? }`. «Мусор» и
 * неполный JSON — это ОШИБКА прогона, а не исключение: вызывающий решает,
 * повторять попытку или отменять генерацию. Испорченные элементы `blocks`
 * отбрасываются по одному — из-за одной кривой правки не должен падать весь
 * ход.
 */

export const MAX_BLOCK_EDITS = 20;
export const MAX_BLOCK_TEXT = 8000;
export const MAX_DECISION_CHARS = 8000;

function failure(message) {
    return { ok: false, error: { message } };
}

function fixtureText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeEdit(raw, index, warnings) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(`block edit #${index + 1} is not an object — dropped`);
        return null;
    }
    const op = String(raw.op ?? '').trim().toLowerCase();
    const id = fixtureText(raw.id);
    const title = fixtureText(raw.title).slice(0, 120);
    if (op === 'remove') {
        if (!id && !title) {
            warnings.push(`block edit #${index + 1} removes nothing — dropped`);
            return null;
        }
        return { op: 'remove', id, title };
    }
    const text = fixtureText(raw.text);
    if (!text) {
        warnings.push(`block edit #${index + 1} has no text — dropped`);
        return null;
    }
    return {
        op: op === 'add' || op === 'update' ? op : '',
        id,
        title,
        text: text.slice(0, MAX_BLOCK_TEXT),
    };
}

/** `raw` — ответ модели целиком. Возвращает `{ ok, value: { decision, edits, warnings } }` либо `{ ok: false, error }`. */
export function parseDeciderResponse(raw, { maxEdits = MAX_BLOCK_EDITS } = {}) {
    const source = String(raw ?? '').trim();
    if (!source) return failure('the director returned an empty response');
    const json = parseModelJson(source);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return failure('the director did not return a JSON object');
    const decision = fixtureText(json.decision);
    if (!decision) return failure('the director did not return a "decision"');
    const warnings = [];
    const list = Array.isArray(json.blocks) ? json.blocks : [];
    const edits = [];
    for (const [index, item] of list.entries()) {
        if (edits.length >= maxEdits) {
            warnings.push(`more than ${maxEdits} block edits — the rest were dropped`);
            break;
        }
        const edit = normalizeEdit(item, index, warnings);
        if (edit) edits.push(edit);
    }
    return { ok: true, value: { decision: decision.slice(0, MAX_DECISION_CHARS), edits, warnings } };
}

function slug(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function titleFromText(text) {
    return String(text ?? '').trim().split('\n')[0].slice(0, 60) || 'Untitled';
}

function uniqueId(blocks, title) {
    const base = slug(title) ? `blk_${slug(title)}` : 'blk';
    if (!blocks.some(block => block.id === base)) return base;
    let index = 2;
    while (blocks.some(block => block.id === `${base}_${index}`)) index += 1;
    return `${base}_${index}`;
}

function findBlock(blocks, id, title) {
    if (id) {
        const byId = blocks.findIndex(block => block.id === id);
        if (byId >= 0) return byId;
    }
    if (title) {
        const key = title.toLowerCase();
        const byTitle = blocks.findIndex(block => String(block.title ?? '').toLowerCase() === key);
        if (byTitle >= 0) return byTitle;
    }
    return -1;
}

/**
 * Применяет правки к копии списка блоков. Неизвестный `update` (директор
 * сослался на несуществующий id) становится добавлением: намерение «этот
 * блок должен быть» честнее выполнить, чем потерять правку. `remove`
 * несуществующего блока — no-op с предупреждением.
 */
export function applyBlockEdits(blocks, edits, { now = () => Date.now() } = {}) {
    const next = (Array.isArray(blocks) ? blocks : []).map(block => ({ ...block }));
    const applied = [];
    const warnings = [];
    for (const edit of edits ?? []) {
        if (!edit || typeof edit !== 'object') continue;
        const index = findBlock(next, edit.id, edit.title);
        if (edit.op === 'remove') {
            if (index < 0) {
                warnings.push(`remove: no block "${edit.id || edit.title}" — skipped`);
                continue;
            }
            next.splice(index, 1);
            applied.push({ op: 'remove', id: edit.id || edit.title });
            continue;
        }
        if (index >= 0) {
            next[index] = {
                ...next[index],
                ...(edit.title ? { title: edit.title } : {}),
                text: edit.text,
                updatedAt: now(),
            };
            applied.push({ op: 'update', id: next[index].id });
            continue;
        }
        const id = edit.id || uniqueId(next, edit.title || titleFromText(edit.text));
        next.push({
            id,
            title: edit.title || titleFromText(edit.text),
            text: edit.text,
            updatedAt: now(),
        });
        applied.push({ op: 'add', id });
    }
    return { blocks: next, applied, warnings };
}
