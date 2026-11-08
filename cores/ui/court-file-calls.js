import { h } from './tree.js';
import { diffNode, previewNode } from './court-files-editor.js';

/**
 * Файловые вызовы ролей в ленте The Court (часть 21) — как в редакторе кода:
 * `edit` — дифф по строкам с номерами, `create` — файл в Markdown под катом,
 * `view` — что прочитано и сколько строк. Путь — кнопка: файл открывается во
 * вкладке Files. Сырой JSON остаётся под «Raw» в самой строке вызова.
 */
const FILE_CALLS = new Set(['view', 'edit', 'create']);
const clean = value => String(value ?? '').trim();
const lineCount = value => (clean(value) ? String(value).split('\n').length : 0);
const HOW = { loose: 'matched loosely', append: 'not found — appended' };

export const isFileCall = name => FILE_CALLS.has(clean(name));

function pathChip(path, openFile) {
    const label = clean(path) || 'a file';
    return typeof openFile === 'function' && clean(path)
        ? h('button', { type: 'button', class: 'stme-dw-file-path', title: 'Open in Files', 'on:click': event => { event?.preventDefault?.(); openFile(path); } }, label)
        : h('span', { class: 'stme-dw-file-path' }, label);
}

function editNode(row, openFile) {
    const edits = Array.isArray(row.args?.edits) ? row.args.edits : [];
    const results = Array.isArray(row.result?.files) ? row.result.files : [];
    const byPath = new Map();
    for (const item of edits) {
        const path = clean(item?.path) || 'a file';
        if (!byPath.has(path)) byPath.set(path, []);
        byPath.get(path).push(item);
    }
    return h('div', { class: 'stme-dw-files' }, ...[...byPath].map(([path, list], fileIndex) => {
        const result = results.find(item => clean(item?.path).toLowerCase() === path.toLowerCase()) ?? results[fileIndex] ?? null;
        const notes = [
            ...(result?.applied ?? []).map(how => HOW[how]).filter(Boolean),
            result?.unchanged ? 'no change' : '',
            result?.note ?? '',
        ].filter(Boolean);
        return h('div', { class: `stme-dw-file${result && result.ok === false ? ' stme-dw-error' : ''}`, key: `${path}_${fileIndex}` },
            h('div', { class: 'stme-dw-file-head' }, pathChip(result?.path ?? path, openFile),
                h('span', { class: 'stme-dw-muted' }, `${list.length} edit${list.length === 1 ? '' : 's'}`),
                notes.length ? h('span', { class: 'stme-dw-file-note' }, [...new Set(notes)].join(' · ')) : null),
            result?.error ? h('div', { class: 'stme-dw-error-text' }, result.error) : null,
            ...list.map((item, index) => h('div', { class: 'stme-dw-file-edit', key: `e${index}` },
                diffNode(String(item?.old ?? ''), String(item?.new ?? ''), { empty: 'The same text.' }))));
    }));
}

function createNode(row, openFile) {
    const body = String(row.args?.text ?? '');
    const lines = lineCount(body);
    return h('div', { class: 'stme-dw-files' },
        h('div', { class: `stme-dw-file${row.result && row.result.ok === false ? ' stme-dw-error' : ''}` },
            h('div', { class: 'stme-dw-file-head' }, h('span', { class: 'stme-files-plus' }, 'new'), pathChip(row.args?.path, openFile),
                h('span', { class: 'stme-dw-muted' }, `${lines} line${lines === 1 ? '' : 's'}`)),
            row.result?.error ? h('div', { class: 'stme-dw-error-text' }, row.result.error) : null,
            body ? h('details', { class: 'stme-dw-fold' }, h('summary', {}, 'Show the file'), previewNode(body)) : null));
}

function viewNode(row, openFile) {
    const path = clean(row.args?.path);
    if (!path) {
        const list = Array.isArray(row.result?.files) ? row.result.files : [];
        return h('div', { class: 'stme-dw-files' }, h('details', { class: 'stme-dw-fold' },
            h('summary', {}, row.pending ? 'Listing the files…' : `Listed ${list.length} file${list.length === 1 ? '' : 's'}`),
            h('div', { class: 'stme-dw-file-list' }, ...list.map(item => h('div', { key: String(item) }, pathChip(item, openFile))))));
    }
    const body = String(row.result?.text ?? '');
    const lines = lineCount(body);
    return h('div', { class: 'stme-dw-files' },
        h('div', { class: 'stme-dw-file' },
            h('div', { class: 'stme-dw-file-head' }, h('span', { class: 'stme-dw-muted' }, 'read'), pathChip(row.result?.path ?? path, openFile),
                h('span', { class: 'stme-dw-muted' }, row.pending ? 'reading…' : (row.result?.ok === false ? 'not found' : `${lines} line${lines === 1 ? '' : 's'}`))),
            row.result?.error ? h('div', { class: 'stme-dw-error-text' }, row.result.error) : null,
            body ? h('details', { class: 'stme-dw-fold' }, h('summary', {}, 'Show what was read'), previewNode(body)) : null));
}

export function fileCallNode(row, { openFile = null } = {}) {
    const name = clean(row?.name);
    if (name === 'edit') return editNode(row, openFile);
    if (name === 'create') return createNode(row, openFile);
    if (name === 'view') return viewNode(row, openFile);
    return null;
}

/** Модель пишет вызов прямо сейчас: файл и сколько строк уже пришло. */
export function writingNode(row, { openFile = null } = {}) {
    const calls = Array.isArray(row?.calls) ? row.calls : [];
    return h('div', { class: 'stme-dw-writing' }, ...calls.map((call, index) => h('div', { class: 'stme-dw-writing-line', key: `w${index}` },
        h('span', { class: 'stme-dw-writing-dot' }, '●'),
        isFileCall(call.name) && clean(call.path)
            ? [`${call.name === 'edit' ? 'Editing' : call.name === 'create' ? 'Writing' : 'Reading'} `, pathChip(call.path, openFile), ` … ${call.lines} line${call.lines === 1 ? '' : 's'}`]
            : `Writing the ${call.name} call…`)));
}
