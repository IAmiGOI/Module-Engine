/**
 * Динамическая форма проверки файла Creation (GOD_FILE_CHECKS): строится из текста самого файла.
 * Подраздел — «###», у файла системы весов — каждое «## <Rule>» кроме Discoveries; у Scales — строка таблицы.
 * После правки в форму идут только новые и изменённые подразделы, а пункты всего файла — если изменилось
 * что-то вне подразделов (таблицы, связи) или их набор. Чистые функции, без модели.
 */
import { GOD_FILE_CHECKS } from './decision-prompts-god.js';

const text = value => String(value ?? '');
export const fileKey = path => text(path).trim().toLowerCase().replace(/^\/+/, '');

function kindOf(path) {
    const key = fileKey(path);
    if (key.startsWith('creation/scales/')) return 'system';
    const base = key.split('/').pop().replace(/\.md$/, '');
    return GOD_FILE_CHECKS[base] && base !== 'every' && base !== 'system' && base !== 'other' ? base : 'other';
}

/** Файл → { frame, parts: Map(заголовок → текст) }; frame — всё вне подразделов. */
export function splitFile(source, kind) {
    const level = kind === 'system' ? /^##\s+(.+?)\s*$/ : /^###\s+(.+?)\s*$/;
    const parts = new Map();
    const frame = [];
    let current = null;
    for (const line of text(source).split('\n')) {
        const head = line.match(level);
        const higher = kind === 'system' ? /^#\s/.test(line) : /^#{1,2}\s/.test(line);
        if (head && !(kind === 'system' && /^discoveries$/i.test(head[1]))) {
            current = head[1];
            parts.set(current, line);
            continue;
        }
        if (head || higher) current = null;
        if (current) parts.set(current, `${parts.get(current)}\n${line}`);
        else frame.push(line);
    }
    return { frame: frame.join('\n').trim(), parts };
}

/** Строки таблицы систем в Scales: имя в первой ячейке, без шапки и разделителя. */
export function tableRows(source) {
    const rows = [];
    for (const line of text(source).split('\n')) {
        if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        const cell = line.split('|')[1]?.trim();
        if (cell && !/^system$/i.test(cell)) rows.push({ name: cell, line: line.trim() });
    }
    return rows;
}

/** Форма файла: список пунктов. previous — текст до правки (нет — файл новый, форма полная). */
export function godFileForm(path, source, previous = null) {
    const kind = kindOf(path);
    const checks = GOD_FILE_CHECKS[kind];
    const fresh = previous === null || previous === undefined;
    const now = splitFile(source, kind);
    const before = fresh ? null : splitFile(previous, kind);
    const items = [];
    if (kind === 'scales') {
        const old = new Set(fresh ? [] : tableRows(previous).map(row => row.line));
        for (const row of tableRows(source)) if (!old.has(row.line)) items.push(`System "${row.name}": ${checks.row}`);
    } else {
        for (const [head, body] of now.parts) {
            if (fresh || before.parts.get(head) !== body) items.push(`"${head}": ${checks.part} What you decided rather than read is marked "(God's decision)".`);
        }
    }
    const sameSet = !fresh && [...now.parts.keys()].join('\n') === [...before.parts.keys()].join('\n');
    if (fresh || now.frame !== before.frame || !sameSet) items.unshift(...checks.whole, GOD_FILE_CHECKS.every);
    return items;
}
