import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { Button, TextArea, TextInput, Row } from '../../libraries/shared/widgets.js';
import { diffHunks, diffStats, applyEdit, parseEdits } from '../../libraries/core/text-diff.js';
import { builtInPrompts } from '../../libraries/core/prompt-catalog.js';
import { renderPart, editsForPart } from '../../libraries/core/court-bank-files.js';

/**
 * Вкладка «Files» окна The Court: любые промпты — файлами. Правка как у ИИ-кодера:
 * сначала diff, потом сохранение; история каждого файла с откатом; правка через ИИ —
 * правками `old → new`, каждую можно принять или отклонить (часть 21).
 * Встроенные промпты правятся поверх неизменной основы (`promptOverrides`), «Reset to default» — через diff.
 */
const HISTORY_NAMESPACE = 'core.ui.courtFiles';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 20;
const kebab = name => name.toLowerCase().replace(/_/g, '-');
const AI_INSTRUCTION = `You edit one prompt file. Return only JSON: an array of edits [{"old": "exact text from the file", "new": "replacement"}]. Keep everything else unchanged. An empty "new" removes the text. To add new text, use an "old" line it should follow and repeat that line in "new" with the addition.`;

export function createCourtFiles({ call }) {
    const sections = signal({});
    const overrides = signal({});
    const great = signal({});
    const history = signal({});
    const selected = signal('');
    const draft = signal('');
    const reviewing = signal(false);
    const ask = signal('');
    const proposals = signal([]);
    const busy = signal(false);
    const note = signal('');

    const blockFiles = computed(() => ['director', 'writer'].flatMap(section => (sections()[section]?.blocks ?? []).map(block => ({
        id: `blocks/${section}/${block.id}`, group: `${section === 'director' ? 'Director' : 'Writer'} blocks`,
        label: `${kebab(String(block.name || block.id).replace(/[^\w ]+/g, '').trim().replace(/\s+/g, '_')) || block.id}.md`,
        text: String(block.content ?? ''), readOnly: false, section, blockId: block.id,
    }))));
    const builtIns = computed(() => builtInPrompts().map(file => ({
        id: file.id, group: 'Built-in', label: `${file.folder}/${file.id.split('/').pop()}`,
        text: overrides()[file.id] ?? file.text, base: file.text, readOnly: false, builtIn: true,
    })));
    const characterFiles = computed(() => Object.values(great()).filter(character => character?.name).flatMap(character => [
        ...['material', 'spiritual'].map(part => ({
            id: `characters/${character.name}/${part}.md`, group: `Characters — ${character.name}`, label: `${part}.md`,
            text: renderPart(character, part), readOnly: false, bank: { name: character.name, part },
        })),
        { id: `characters/${character.name}/decree.md`, group: `Characters — ${character.name}`, label: 'decree.md', text: renderPart(character, 'decree'), readOnly: true },
    ]));
    const files = computed(() => [...blockFiles(), ...characterFiles(), ...builtIns()]);
    const current = computed(() => files().find(file => file.id === selected()) ?? null);
    const dirty = computed(() => Boolean(current()) && draft() !== current().text);

    async function load() {
        const [settings, stored, bank] = await Promise.all([call('decision.settings'), call('storage.settings.get', { namespace: HISTORY_NAMESPACE, key: HISTORY_KEY, fallback: {} }), call('decision.greatBank')]);
        great.set(bank.ok && bank.value && typeof bank.value === 'object' ? bank.value : {});
        sections.set(settings.ok ? structuredClone(settings.value?.promptSections ?? {}) : {});
        overrides.set(settings.ok ? { ...(settings.value?.promptOverrides ?? {}) } : {});
        history.set(stored.ok && stored.value && typeof stored.value === 'object' ? stored.value : {});
        if (!selected.peek() && files.peek().length) open(files.peek()[0].id);
    }

    function open(id) {
        if (dirty.peek() && typeof globalThis.confirm === 'function' && !globalThis.confirm('Discard the unsaved changes?')) return;
        selected.set(id);
        draft.set(files.peek().find(file => file.id === id)?.text ?? '');
        reviewing.set(false);
        proposals.set([]);
        note.set('');
    }

    async function save() {
        const file = current.peek();
        if (!file || file.readOnly || !dirty.peek()) return;
        busy.set(true);
        try {
            const before = file.text;
            if (file.bank) {
                const edits = editsForPart(file.bank.name, file.bank.part, file.text, draft.peek());
                const answer = await call('decision.greatBankEdit', { comment: 'Edited by the user in The Court.', edits });
                if (!answer.ok) throw new Error(answer.error?.message ?? 'Not saved.');
                const fresh = await call('decision.greatBank');
                if (fresh.ok && fresh.value) great.set(fresh.value);
                draft.set(files.peek().find(item => item.id === file.id)?.text ?? draft.peek());
            } else if (file.builtIn) {
                const next = { ...overrides.peek() };
                if (draft.peek() === file.base) delete next[file.id]; else next[file.id] = draft.peek();
                const answer = await call('decision.configure', { patch: { promptOverrides: next } });
                if (!answer.ok) throw new Error(answer.error?.message ?? 'Not saved.');
                overrides.set(next);
            } else {
                const next = structuredClone(sections.peek());
                const block = next[file.section]?.blocks?.find(item => item.id === file.blockId);
                if (!block) throw new Error('The block is gone — reopen the file.');
                block.content = draft.peek();
                // Активный пресет хранит копии блоков: без этого он при загрузке вернул бы старый текст (как вернулся Anti Bias).
                const section = next[file.section];
                const preset = (section?.presets ?? []).find(item => item.id === section.activePresetId);
                const copy = preset?.blocks?.find(item => item.id === file.blockId || (item.name && item.name === block.name));
                if (copy) copy.content = draft.peek();
                const answer = await call('decision.configure', { patch: { promptSections: next } });
                if (!answer.ok) throw new Error(answer.error?.message ?? 'Not saved.');
                sections.set(next);
            }
            const versions = [...(history.peek()[file.id] ?? []), { at: Date.now(), text: before }].slice(-HISTORY_LIMIT);
            history.set({ ...history.peek(), [file.id]: versions });
            await call('storage.settings.set', { namespace: HISTORY_NAMESPACE, key: HISTORY_KEY, value: history.peek() });
            reviewing.set(false);
            note.set('Saved.');
        } catch (error) {
            note.set(error?.message ?? String(error));
        } finally {
            busy.set(false);
        }
    }

    async function askAi() {
        const file = current.peek();
        const wish = String(ask.peek() ?? '').trim();
        if (!file || file.readOnly || !wish || busy.peek()) return;
        busy.set(true);
        note.set('');
        try {
            const settings = await call('decision.settings');
            const workerId = settings.ok ? settings.value?.decider?.workerId : undefined;
            const answer = await call('model.generate', {
                ...(workerId ? { workerId } : {}), maxTokens: 4000, temperature: 0.2, stream: false,
                reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
                messages: [{ role: 'system', content: AI_INSTRUCTION }, { role: 'user', content: `FILE ${file.label}\n\n${draft.peek()}\n\nCHANGE: ${wish}` }],
            });
            const edits = parseEdits(answer.ok ? answer.value?.text ?? answer.value : '');
            if (!edits.length) throw new Error('The AI returned no edits.');
            proposals.set(edits.map((edit, index) => ({ ...edit, id: `p${index}`, preview: applyEdit(draft.peek(), edit).text })));
        } catch (error) {
            note.set(error?.message ?? String(error));
        } finally {
            busy.set(false);
        }
    }

    function accept(proposal) {
        draft.set(applyEdit(draft.peek(), proposal).text);
        proposals.set(proposals.peek().filter(item => item.id !== proposal.id).map(item => ({ ...item, preview: applyEdit(draft.peek(), item).text })));
        reviewing.set(true);
    }

    function hunksNode(before, after) {
        const hunks = diffHunks(before, after);
        if (!hunks.length) return h('div', { class: 'stme-files-nodiff' }, 'No changes.');
        return h('div', { class: 'stme-files-diff' }, ...hunks.map(hunk => h('pre', { class: 'stme-files-hunk' },
            ...hunk.lines.map(line => h('div', { class: `stme-files-line stme-files-${line.type}` }, `${line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '} ${line.text}`)))));
    }

    function editorNode(file) {
        const stats = diffStats(file.text, draft());
        return h('div', { class: 'stme-files-editor' },
            h('div', { class: 'stme-files-path' }, file.label, file.builtIn ? h('span', { class: 'stme-files-badge' }, file.text === file.base ? 'built-in' : 'built-in · changed') : null,
                dirty() ? h('span', { class: 'stme-files-badge' }, `+${stats.added} −${stats.removed}`) : null),
            reviewing() ? hunksNode(file.text, draft()) : h('textarea', {
                class: 'text_pole stme-files-text', value: draft(), readonly: file.readOnly ? true : undefined, spellcheck: 'false',
                'on:input': event => draft.set(String(event?.target?.value ?? '')),
                'on:keydown': event => { if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') { event.preventDefault?.(); reviewing.set(true); } },
            }),
            file.readOnly ? null : Row(
                reviewing() ? Button('Back to editing', () => reviewing.set(false)) : Button('Review changes', () => reviewing.set(true), { disabled: !dirty() }),
                Button('Save', save, { disabled: busy() || !dirty() || !reviewing() }),
                Button('Discard', () => { draft.set(file.text); reviewing.set(false); }, { disabled: !dirty() }),
                file.builtIn && file.text !== file.base ? Button('Reset to default', () => { draft.set(file.base); reviewing.set(true); }) : null),
            file.readOnly ? null : h('div', { class: 'stme-files-ai' },
                TextInput(ask, { placeholder: 'Describe a change — the AI proposes edits you can accept one by one' }),
                Button(busy() ? 'Working…' : 'Change with AI', askAi, { disabled: busy() })),
            ...proposals().map(proposal => h('div', { class: 'stme-files-proposal' },
                hunksNode(draft(), proposal.preview),
                Row(Button('Accept', () => accept(proposal)), Button('Reject', () => proposals.set(proposals.peek().filter(item => item.id !== proposal.id)))))),
            (history()[file.id] ?? []).length ? h('details', { class: 'stme-files-history' },
                h('summary', {}, `History (${history()[file.id].length})`),
                ...[...history()[file.id]].reverse().map(version => h('details', { class: 'stme-files-version' },
                    h('summary', {}, new Date(version.at).toLocaleString()),
                    hunksNode(draft(), version.text),
                    Button('Restore this version', () => { draft.set(version.text); reviewing.set(true); })))) : null,
            note() ? h('div', { class: 'stme-dw-muted' }, note()) : null);
    }

    function tree() {
        const groups = [...new Set(files().map(file => file.group))];
        return h('div', { class: 'stme-files' },
            h('nav', { class: 'stme-files-tree' }, ...groups.map(group => h('div', { class: 'stme-files-group' },
                h('div', { class: 'stme-files-group-title' }, group),
                ...files().filter(file => file.group === group).map(file => h('button', {
                    type: 'button', class: `stme-files-item${file.id === selected() ? ' stme-files-active' : ''}`, 'on:click': () => open(file.id), title: file.label,
                }, file.label))))),
            current() ? editorNode(current()) : h('div', { class: 'stme-court-empty' }, 'Choose a file.'));
    }

    return { tree, load, open, save, draft, selected, files, reviewing, proposals, accept };
}
