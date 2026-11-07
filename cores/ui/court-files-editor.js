import { h } from './tree.js';
import { Button, TextInput, Segment, Select, HoldButton } from '../../libraries/shared/widgets.js';
import { signal } from './reactive.js';
import { diffHunks, diffStats } from '../../libraries/core/text-diff.js';
import { applyEdit } from '../../libraries/core/text-diff.js';
import { usageOf, placeholders, tokensOf, linesOf, hunkHeader, ROLE_FOLDERS } from '../../libraries/core/court-files-model.js';
import { markdownBlocks } from '../../libraries/core/court-markdown.js';

/**
 * Редактор вкладки «Files»: вкладки открытых файлов, путь и сведения о файле
 * (роль, где он в контексте, строки, токены, переменные), режимы Edit / Preview /
 * Changes / vs Default, редактор с номерами строк, diff с номерами старой и новой
 * версии, сохранение с заметкой, правка через ИИ, история с откатом.
 */
const KIND_LABEL = { block: 'Your block', character: 'Great Bank', builtin: 'Built-in' };

function inline(tokens) {
    return tokens.map(token => (token.t === 'b' ? h('strong', {}, token.v) : token.t === 'i' ? h('em', {}, token.v)
        : token.t === 'code' ? h('code', {}, token.v) : token.t === 'var' ? h('span', { class: 'stme-files-var' }, token.v) : token.v));
}

function previewNode(value) {
    const blocks = markdownBlocks(value);
    if (!blocks.length) return h('div', { class: 'stme-court-empty' }, 'Empty file.');
    return h('div', { class: 'stme-files-preview' }, ...blocks.map(block => {
        if (block.type === 'h') return h(`h${Math.min(6, block.level + 2)}`, {}, ...inline(block.inline));
        if (block.type === 'li') return h('div', { class: 'stme-files-li', style: `padding-left: ${12 + block.indent * 6}px` }, h('span', { class: 'stme-files-li-mark' }, block.ordered ? `${block.mark}.` : '•'), ...inline(block.inline));
        if (block.type === 'quote') return h('blockquote', {}, ...inline(block.inline));
        if (block.type === 'code') return h('pre', { class: 'stme-files-code' }, block.text);
        if (block.type === 'hr') return h('hr', {});
        return h('p', {}, ...inline(block.inline));
    }));
}

export function diffNode(before, after, { empty = 'No changes.' } = {}) {
    const hunks = diffHunks(before, after, { context: 3 });
    if (!hunks.length) return h('div', { class: 'stme-files-nodiff' }, empty);
    const stats = diffStats(before, after);
    return h('div', { class: 'stme-files-diff' },
        h('div', { class: 'stme-files-diff-stats' }, h('span', { class: 'stme-files-plus' }, `+${stats.added}`), ' ', h('span', { class: 'stme-files-minus' }, `−${stats.removed}`), ` in ${hunks.length} place${hunks.length === 1 ? '' : 's'}`),
        ...hunks.map(hunk => h('div', { class: 'stme-files-hunk' },
            h('div', { class: 'stme-files-hunk-head' }, hunkHeader(hunk)),
            ...hunk.lines.map(line => h('div', { class: `stme-files-line stme-files-${line.type}` },
                h('span', { class: 'stme-files-no' }, line.oldNo ?? ''),
                h('span', { class: 'stme-files-no' }, line.newNo ?? ''),
                h('span', { class: 'stme-files-sign' }, line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''),
                h('span', { class: 'stme-files-code-text' }, line.text || ' '))))));
}

function editorArea(ctx, file) {
    const value = ctx.draftOf(file.id);
    const count = linesOf(value);
    const gutter = h('div', { class: 'stme-files-gutter', 'aria-hidden': 'true' }, ...Array.from({ length: count }, (_, index) => h('div', {}, String(index + 1))));
    return h('div', { class: 'stme-files-edit' }, gutter,
        h('textarea', {
            class: 'stme-files-text', value, spellcheck: 'false', readonly: file.readOnly ? true : undefined, wrap: 'off',
            'on:input': event => ctx.setDraft(file.id, String(event?.target?.value ?? '')),
            'on:scroll': event => { const g = event?.target?.previousElementSibling; if (g) g.scrollTop = event.target.scrollTop; },
            'on:keydown': event => {
                if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
                    event.preventDefault?.();
                    if (ctx.viewOf(file.id) === 'diff') ctx.save(file.id); else if (ctx.isDirty(file.id)) ctx.setView(file.id, 'diff');
                }
                if (event.key === 'Tab' && !file.readOnly) {
                    event.preventDefault?.();
                    const target = event.target;
                    const start = target.selectionStart;
                    const next = `${target.value.slice(0, start)}    ${target.value.slice(target.selectionEnd)}`;
                    ctx.setDraft(file.id, next);
                    setTimeout(() => { target.selectionStart = target.selectionEnd = start + 4; }, 0);
                }
            },
        }));
}

function infoNode(ctx, file) {
    const value = ctx.draftOf(file.id);
    const vars = placeholders(value);
    const problems = ctx.problemsOf(file);
    return h('div', { class: 'stme-files-info' },
        h('div', { class: 'stme-files-crumbs' }, ...String(file.path).split('/').flatMap((part, index, all) => [h('span', { class: index === all.length - 1 ? 'stme-files-crumb-last' : '' }, part), index < all.length - 1 ? h('span', { class: 'stme-files-sep' }, '/') : null]).filter(Boolean)),
        h('div', { class: 'stme-files-meta' },
            h('span', { class: `stme-files-pill stme-files-role-${file.role}` }, ROLE_FOLDERS[file.role] ?? file.role ?? 'Engine'),
            h('span', { class: 'stme-files-pill' }, KIND_LABEL[file.kind] ?? file.kind),
            file.changed ? h('span', { class: 'stme-files-pill stme-files-pill-changed' }, 'changed from default') : null,
            file.readOnly ? h('span', { class: 'stme-files-pill' }, 'read-only') : null,
            h('span', { class: 'stme-files-dim' }, `${linesOf(value)} lines · ~${tokensOf(value)} tokens`)),
        h('div', { class: 'stme-files-usage' }, usageOf(file)),
        vars.length ? h('div', { class: 'stme-files-vars' }, h('span', { class: 'stme-files-dim' }, 'Filled by the engine: '), ...vars.map(name => h('code', { class: 'stme-files-var' }, `{{${name}}}`))) : null,
        problems.missing.length ? h('div', { class: 'stme-dw-warning' }, `Put back ${problems.missing.map(name => `{{${name}}}`).join(', ')} — the engine needs it.`) : null,
        problems.unknown.length ? h('div', { class: 'stme-dw-warning' }, `${problems.unknown.map(name => `{{${name}}}`).join(', ')} is not something the engine can fill — remove it.`) : null);
}

function actionsNode(ctx, file) {
    const dirty = ctx.isDirty(file.id);
    const view = ctx.viewOf(file.id);
    const views = [{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }, { value: 'diff', label: dirty ? 'Changes •' : 'Changes' }];
    if (file.kind === 'builtin') views.push({ value: 'default', label: 'vs Default' });
    const viewSignal = signal(view);
    return h('div', { class: 'stme-files-actions' },
        Segment(views, viewSignal, { label: 'View', onChange: value => ctx.setView(file.id, value) }),
        h('span', { class: 'stme-files-spacer' }),
        file.kind === 'block' ? Select(signal(file.blockRole), [{ value: 'system', label: 'system' }, { value: 'user', label: 'user' }, { value: 'assistant', label: 'assistant' }], { onChange: role => ctx.setBlockRole(file.id, role) }) : null,
        file.kind === 'block' ? Button('Rename', () => ctx.renameBlock(file.id)) : null,
        file.kind === 'block' ? Button('Duplicate', () => ctx.duplicateBlock(file.id)) : null,
        file.kind === 'block' ? HoldButton('Hold to delete', () => ctx.deleteBlock(file.id)) : null,
        file.kind === 'builtin' && file.changed ? Button('Reset to default', () => ctx.resetToDefault(file.id)) : null);
}

function saveBar(ctx, file) {
    if (file.readOnly || !ctx.isDirty(file.id)) return null;
    return h('div', { class: 'stme-files-savebar' },
        h('span', { class: 'stme-files-dim' }, ctx.viewOf(file.id) === 'diff' ? 'Review the changes, then save.' : 'Unsaved changes.'),
        TextInput(ctx.saveNote, { placeholder: 'What changed (optional)' }),
        ctx.viewOf(file.id) === 'diff' ? null : Button('Review', () => ctx.setView(file.id, 'diff')),
        Button(ctx.busy() ? 'Saving…' : 'Save', () => ctx.save(file.id), { disabled: ctx.busy(), variant: 'primary' }),
        Button('Discard', () => ctx.discard(file.id)));
}

function aiNode(ctx, file) {
    if (file.readOnly) return null;
    const list = ctx.proposals()[file.id] ?? [];
    return h('details', { class: 'stme-files-ai', ...(list.length ? { open: true } : {}) },
        h('summary', {}, list.length ? `AI edits — ${list.length} to review` : 'Change with AI'),
        h('div', { class: 'stme-files-ai-row' },
            TextInput(ctx.wish, { placeholder: 'Describe the change — the AI proposes edits, you accept them one by one' }),
            Button(ctx.busy() ? 'Working…' : 'Propose', () => ctx.askAi(file.id), { disabled: ctx.busy() })),
        list.length > 1 ? Button('Accept all', () => ctx.acceptAll(file.id)) : null,
        ...list.map(proposal => h('div', { class: 'stme-files-proposal', key: proposal.key },
            diffNode(ctx.draftOf(file.id), applyEdit(ctx.draftOf(file.id), proposal).text, { empty: 'This edit changes nothing.' }),
            h('div', { class: 'stme-files-row' }, Button('Accept', () => ctx.accept(file.id, proposal), { variant: 'primary' }), Button('Reject', () => ctx.reject(file.id, proposal))))));
}

function historyNode(ctx, file) {
    const list = ctx.history()[file.id] ?? [];
    return h('details', { class: 'stme-files-history' },
        h('summary', {}, `History — ${list.length} version${list.length === 1 ? '' : 's'}`),
        list.length ? null : h('div', { class: 'stme-files-dim' }, 'Every save keeps the previous version here.'),
        ...[...list].reverse().map((version, index) => {
            const stats = diffStats(version.text, ctx.draftOf(file.id));
            return h('details', { class: 'stme-files-version', key: `${version.at}_${index}` },
                h('summary', {},
                    h('span', {}, new Date(version.at).toLocaleString()),
                    h('span', { class: 'stme-files-dim' }, ` · ${version.by === 'ai' ? 'AI' : version.by === 'deleted' ? 'before delete' : 'you'}${version.note ? ` · ${version.note}` : ''}`),
                    h('span', { class: 'stme-files-dim' }, ` · ${stats.added}+ ${stats.removed}−`)),
                diffNode(ctx.draftOf(file.id), version.text, { empty: 'Same as now.' }),
                file.readOnly ? null : Button('Restore this version', () => ctx.restore(file.id, version)));
        }));
}

function tabsNode(ctx) {
    return h('div', { class: 'stme-files-tabs', role: 'tablist' }, ...ctx.tabs().map(id => {
        const file = ctx.files().find(item => item.id === id);
        if (!file) return null;
        return h('div', { key: id, class: `stme-files-tab${id === ctx.active() ? ' stme-files-tab-active' : ''}`, role: 'tab', 'on:click': () => ctx.open(id), title: file.path },
            h('span', { class: 'stme-files-tab-name' }, String(file.path).split('/').pop()),
            ctx.isDirty(id) ? h('span', { class: 'stme-files-unsaved' }, '●') : null,
            h('button', { type: 'button', class: 'stme-files-tab-close', title: 'Close', 'on:click': event => { event?.stopPropagation?.(); ctx.close(id); } }, '×'));
    }).filter(Boolean));
}

export function filesEditorView(ctx) {
    const file = ctx.current();
    if (!file) return h('section', { class: 'stme-files-editor' }, h('div', { class: 'stme-court-empty' }, 'Choose a file on the left.'));
    const view = ctx.viewOf(file.id);
    const value = ctx.draftOf(file.id);
    const body = view === 'preview' ? previewNode(value)
        : view === 'diff' ? diffNode(file.text, value, { empty: 'No unsaved changes.' })
            : view === 'default' ? diffNode(file.base ?? '', value, { empty: 'Same as the default.' })
                : editorArea(ctx, file);
    return h('section', { class: 'stme-files-editor' },
        tabsNode(ctx),
        infoNode(ctx, file),
        actionsNode(ctx, file),
        h('div', { class: 'stme-files-body' }, body),
        saveBar(ctx, file),
        aiNode(ctx, file),
        historyNode(ctx, file),
        ctx.note() ? h('div', { class: 'stme-files-note' }, ctx.note()) : null);
}
