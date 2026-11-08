import { h } from './tree.js';
import { TextInput } from '../../libraries/shared/widgets.js';
import { buildTree, searchFiles } from '../../libraries/core/court-files-model.js';

/**
 * Дерево вкладки «Files»: папки сворачиваются, у папки — число файлов и
 * изменённых, у файла — вид (блок, персонаж, встроенный), несохранённое и
 * изменённое против основы. Поиск — по именам и тексту, с числом совпадений.
 */
const KIND_GLYPH = { block: '✎', character: '◉', builtin: '◇', layer: '▣' };
const ROLE_CLASS = role => `stme-files-role-${role || 'engine'}`;

function fileRow(ctx, file, { hits = 0, depth = 0, label = null } = {}) {
    const activeId = ctx.active();
    const states = [
        ctx.isDirty(file.id) ? h('span', { class: 'stme-files-mark stme-files-unsaved', title: 'Unsaved changes' }, '●') : null,
        file.changed ? h('span', { class: 'stme-files-mark stme-files-changed', title: 'Changed from the default' }, '◆') : null,
        file.readOnly ? h('span', { class: 'stme-files-mark', title: 'Read-only' }, 'ro') : null,
        hits ? h('span', { class: 'stme-files-hits' }, String(hits)) : null,
    ];
    return h('button', {
        type: 'button', key: file.id, title: file.path,
        class: `stme-files-item ${ROLE_CLASS(file.role)}${file.id === activeId ? ' stme-files-active' : ''}`,
        style: `padding-left: ${10 + depth * 14}px`,
        'on:click': () => ctx.open(file.id),
    },
    h('span', { class: 'stme-files-glyph' }, KIND_GLYPH[file.kind] ?? '·'),
    h('span', { class: 'stme-files-name' }, label ?? String(file.path).split('/').pop()),
    ...states.filter(Boolean));
}

function folderNode(ctx, folder, depth) {
    const open = ctx.expanded().has(folder.path);
    return h('div', { class: 'stme-files-folder', key: folder.path },
        h('button', { type: 'button', class: 'stme-files-folder-row', style: `padding-left: ${6 + depth * 14}px`, 'on:click': () => ctx.toggleFolder(folder.path) },
            h('span', { class: 'stme-files-chevron' }, open ? '▾' : '▸'),
            h('span', { class: 'stme-files-folder-name' }, folder.name),
            folder.changed ? h('span', { class: 'stme-files-mark stme-files-changed', title: `${folder.changed} changed` }, '◆') : null,
            h('span', { class: 'stme-files-count' }, String(folder.count))),
        open ? h('div', { class: 'stme-files-children' }, ...folder.children.map(child => (child.type === 'folder' ? folderNode(ctx, child, depth + 1) : fileRow(ctx, child.file, { depth: depth + 1 })))) : null);
}

export function filesTreeView(ctx) {
    const files = ctx.files();
    const hits = searchFiles(files, ctx.search());
    const body = hits
        ? (hits.size
            ? files.filter(file => hits.has(file.id)).map(file => fileRow(ctx, file, { hits: hits.get(file.id), label: file.path }))
            : [h('div', { class: 'stme-court-empty' }, 'Nothing matches.')])
        : buildTree(files).children.map(folder => folderNode(ctx, folder, 0));
    const dirty = files.filter(file => ctx.isDirty(file.id)).length;
    return h('nav', { class: 'stme-files-tree' },
        h('div', { class: 'stme-files-tree-head' },
            h('span', { class: 'stme-files-tree-title' }, 'Files'),
            dirty ? h('span', { class: 'stme-files-badge' }, `${dirty} unsaved`) : null),
        h('div', { class: 'stme-files-search' }, TextInput(ctx.search, { placeholder: 'Search names and text' })),
        h('div', { class: 'stme-files-new' },
            h('button', { type: 'button', class: 'stme-files-link', 'on:click': () => ctx.newBlock('director') }, '+ Director block'),
            h('button', { type: 'button', class: 'stme-files-link', 'on:click': () => ctx.newBlock('writer') }, '+ Writer block')),
        h('div', { class: 'stme-files-list' }, ...body),
        h('div', { class: 'stme-files-legend' }, '✎ your block · ◉ character · ▣ knowledge / Creation · ◇ built-in · ● unsaved · ◆ changed'));
}
