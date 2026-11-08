import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { applyEdit, parseEdits } from '../../libraries/core/text-diff.js';
import { builtInPrompts } from '../../libraries/core/prompt-catalog.js';
import { renderPart, editsForPart } from '../../libraries/core/court-bank-files.js';
import { roleOfPrompt, ROLE_FOLDERS, placeholderProblems } from '../../libraries/core/court-files-model.js';
import { filesTreeView } from './court-files-tree.js';
import { filesEditorView } from './court-files-editor.js';

/**
 * Вкладка «Files» окна The Court (часть 21): всё, что модели читают, — файлами.
 * Свои блоки разделов, персонажи Great Bank и встроенные промпты ролей; вкладки,
 * черновики, сохранение через diff с заметкой, история с откатом, правка через ИИ
 * правками `old → new`, создание и удаление блоков. Здесь — состояние и действия;
 * дерево и редактор рисуют `court-files-tree.js` и `court-files-editor.js`.
 */
const HISTORY_NAMESPACE = 'core.ui.courtFiles';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 30;
const kebab = value => String(value ?? '').trim().toLowerCase().replace(/[^\w\s-]+/g, '').replace(/[\s_]+/g, '-') || 'untitled';
const AI_INSTRUCTION = `You edit one prompt file. Return only JSON: an array of edits [{"old": "exact text from the file", "new": "replacement"}]. Keep everything else unchanged; keep every {{variable}} exactly. An empty "new" removes the text. To add text, use as "old" the line it follows and repeat that line in "new" with the addition.`;
const ask = (message, value) => (typeof globalThis.prompt === 'function' ? globalThis.prompt(message, value) : value);

export function createCourtFiles({ call }) {
    const sections = signal({});
    const overrides = signal({});
    const great = signal({});
    const layer = signal([]);
    const history = signal({});
    const tabs = signal([]);
    const active = signal('');
    const drafts = signal({});
    const views = signal({});
    const expanded = signal(new Set(['Your blocks', 'Your blocks/Director', 'Your blocks/Writer', 'Characters', 'Creation', 'Built-in']));
    const search = signal('');
    const note = signal('');
    const saveNote = signal('');
    const wish = signal('');
    const proposals = signal({});
    const busy = signal(false);
    const showHistory = signal(false);
    const builtIns = builtInPrompts();

    const blockFiles = computed(() => ['director', 'writer'].flatMap(section => (sections()[section]?.blocks ?? []).map(block => ({
        id: `block:${section}:${block.id}`, kind: 'block', path: `Your blocks/${section === 'director' ? 'Director' : 'Writer'}/${kebab(block.name)}.md`,
        title: String(block.name || 'Untitled'), text: String(block.content ?? ''), section, blockId: block.id, blockRole: block.role ?? 'system',
        role: section, readOnly: false,
    }))));
    const characterFiles = computed(() => Object.values(great()).filter(character => character?.name).flatMap(character => [
        ...['material', 'spiritual', 'decree'].map(part => ({
            id: `character:${character.name}:${part}`, kind: 'character', path: `Characters/${character.name}/${part}.md`,
            title: `${character.name} — ${part}`, text: renderPart(character, part), character: character.name, part,
            importance: character.importance, readOnly: part === 'decree', role: part === 'decree' ? 'director' : 'banks',
        })),
        // Банк старой версии ещё не разложен по разделам — его текст виден целиком, пока сборщик его не пересоберёт.
        ...(character.fallbackText ? [{
            id: `character:${character.name}:card`, kind: 'character', path: `Characters/${character.name}/card.md`,
            title: `${character.name} — card`, text: String(character.fallbackText), character: character.name, part: 'card',
            importance: character.importance, readOnly: true, role: 'banks',
        }] : []),
    ]));
    // knowledge.md персонажей и Creation/… Бога — файлами движка (`decision.files`), как их видят модели.
    const layerFiles = computed(() => layer().map(file => {
        const knowledge = /\/knowledge\.md$/i.test(file.path);
        return {
            id: `layer:${file.path}`, kind: 'layer', path: file.path, title: file.path.replace(/^(Characters|Creation)\//, '').replace(/\.md$/i, ''),
            text: String(file.text ?? ''), part: knowledge ? 'knowledge' : 'creation', role: knowledge ? 'banks' : 'god', readOnly: false,
        };
    }));
    const builtInFiles = computed(() => builtIns.map(file => {
        const role = roleOfPrompt(file.name);
        const value = overrides()[file.id] ?? file.text;
        return {
            id: file.id, kind: 'builtin', path: `Built-in/${ROLE_FOLDERS[role]}/${kebab(file.name)}.md`, title: file.name, name: file.name,
            text: value, base: file.text, changed: value !== file.text, role, readOnly: false,
        };
    }));
    const files = computed(() => [...blockFiles(), ...characterFiles(), ...layerFiles(), ...builtInFiles()]);
    const byId = id => files.peek().find(file => file.id === id) ?? null;
    const current = computed(() => files().find(file => file.id === active()) ?? null);
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const draftOf = id => (has(drafts(), id) ? drafts()[id] : (files().find(file => file.id === id)?.text ?? ''));
    const isDirty = id => has(drafts(), id) && drafts()[id] !== (files().find(file => file.id === id)?.text ?? '');

    async function load() {
        const [settings, stored, bank] = await Promise.all([
            call('decision.settings'),
            call('storage.settings.get', { namespace: HISTORY_NAMESPACE, key: HISTORY_KEY, fallback: {} }),
            call('decision.greatBank'),
        ]);
        await loadLayer();
        sections.set(settings.ok ? structuredClone(settings.value?.promptSections ?? {}) : {});
        overrides.set(settings.ok ? { ...(settings.value?.promptOverrides ?? {}) } : {});
        great.set(bank.ok && bank.value && typeof bank.value === 'object' ? bank.value : {});
        history.set(stored.ok && stored.value && typeof stored.value === 'object' ? stored.value : {});
        if (!active.peek() && files.peek().length) open(files.peek()[0].id);
    }

    async function loadLayer() {
        const answer = await call('decision.files');
        layer.set(answer.ok && Array.isArray(answer.value) ? answer.value : []);
    }

    function open(id) {
        const file = byId(id);
        if (!file) return;
        if (!tabs.peek().includes(id)) tabs.set([...tabs.peek(), id]);
        active.set(id);
        note.set('');
        const parts = String(file.path).split('/');
        const next = new Set(expanded.peek());
        for (let index = 1; index < parts.length; index += 1) next.add(parts.slice(0, index).join('/'));
        expanded.set(next);
    }

    /** Файл по пути из ленты (`Characters/Lena/decree.md`, `Creation/geography.md`): загрузить и открыть вкладкой. */
    async function openPath(path) {
        const wanted = String(path ?? '').trim().replace(/^\/+/, '').toLowerCase();
        if (!wanted) return false;
        const find = () => files.peek().find(file => String(file.path).toLowerCase() === wanted || (!wanted.endsWith('.md') && String(file.path).toLowerCase() === `${wanted}.md`));
        if (!find()) await load();
        const file = find();
        if (!file) { note.set(`There is no file "${path}" here.`); return false; }
        open(file.id);
        return true;
    }

    function close(id) {
        if (isDirty(id) && typeof globalThis.confirm === 'function' && !globalThis.confirm('Close without saving?')) return;
        const list = tabs.peek().filter(item => item !== id);
        tabs.set(list);
        const { [id]: _dropped, ...rest } = drafts.peek();
        drafts.set(rest);
        if (active.peek() === id) active.set(list.at(-1) ?? '');
    }

    const setDraft = (id, value) => drafts.set({ ...drafts.peek(), [id]: value });
    const setView = (id, value) => views.set({ ...views.peek(), [id]: value });
    const viewOf = id => views()[id] ?? 'edit';
    const toggleFolder = path => { const next = new Set(expanded.peek()); if (next.has(path)) next.delete(path); else next.add(path); expanded.set(next); };

    async function remember(file, before, by) {
        const entry = { at: Date.now(), text: before, note: String(saveNote.peek() ?? '').trim(), by };
        history.set({ ...history.peek(), [file.id]: [...(history.peek()[file.id] ?? []), entry].slice(-HISTORY_LIMIT) });
        await call('storage.settings.set', { namespace: HISTORY_NAMESPACE, key: HISTORY_KEY, value: history.peek() });
    }

    // Активный пресет хранит копии блоков: правка и удаление идут и в него, иначе он вернул бы старое (как вернулся Anti Bias).
    function withPreset(section, change) {
        const preset = (section?.presets ?? []).find(item => item.id === section.activePresetId);
        if (preset) change(preset);
    }

    async function writeSections(next) {
        const answer = await call('decision.configure', { patch: { promptSections: next } });
        if (!answer.ok) throw new Error(answer.error?.message ?? 'Not saved.');
        sections.set(next);
    }

    async function run(task, done = 'Saved.') {
        busy.set(true);
        note.set('');
        try { await task(); note.set(done); } catch (error) { note.set(error?.message ?? String(error)); } finally { busy.set(false); }
    }

    const problemsOf = file => (file?.kind === 'builtin' ? placeholderProblems(file.base, draftOf(file.id)) : { missing: [], unknown: [] });

    async function save(id = active.peek(), { by = 'you' } = {}) {
        const file = byId(id);
        if (!file || file.readOnly || !isDirty(id)) return;
        const problems = problemsOf(file);
        if (problems.missing.length || problems.unknown.length) { note.set('Fix the variables first — the engine fills only the ones the default has.'); return; }
        const value = draftOf(id);
        await run(async () => {
            if (file.kind === 'character') {
                const answer = await call('decision.greatBankEdit', { comment: saveNote.peek() || 'Edited by the user in The Court.', edits: editsForPart(file.character, file.part, file.text, value) });
                if (!answer.ok) throw new Error(answer.error?.message ?? 'Not saved.');
                const fresh = await call('decision.greatBank');
                if (fresh.ok && fresh.value) great.set(fresh.value);
            } else if (file.kind === 'layer') {
                const answer = await call('decision.filesWrite', { path: file.path, text: value, comment: saveNote.peek() });
                if (!answer.ok || answer.value?.ok === false) throw new Error(answer.error?.message ?? answer.value?.error ?? 'Not saved.');
                await loadLayer();
            } else if (file.kind === 'builtin') {
                const next = { ...overrides.peek() };
                if (value === file.base) delete next[file.id]; else next[file.id] = value;
                const answer = await call('decision.configure', { patch: { promptOverrides: next } });
                if (!answer.ok) throw new Error(answer.error?.message ?? 'Not saved.');
                overrides.set(next);
            } else {
                const next = structuredClone(sections.peek());
                const section = next[file.section];
                const block = section?.blocks?.find(item => item.id === file.blockId);
                if (!block) throw new Error('The block is gone — reopen the file.');
                block.content = value;
                withPreset(section, preset => { const copy = preset.blocks?.find(item => item.id === file.blockId || item.name === block.name); if (copy) copy.content = value; });
                await writeSections(next);
            }
            await remember(file, file.text, by);
            const { [id]: _saved, ...rest } = drafts.peek();
            drafts.set(rest);
            setView(id, 'edit');
            saveNote.set('');
        });
    }

    function discard(id = active.peek()) {
        const { [id]: _dropped, ...rest } = drafts.peek();
        drafts.set(rest);
        setView(id, 'edit');
    }

    function restore(id, version) {
        setDraft(id, version.text);
        setView(id, 'diff');
        saveNote.set(`Restored the version of ${new Date(version.at).toLocaleString()}`);
    }

    function resetToDefault(id) {
        const file = byId(id);
        if (!file?.base) return;
        setDraft(id, file.base);
        setView(id, 'diff');
        saveNote.set('Reset to default');
    }

    async function askAi(id = active.peek()) {
        const file = byId(id);
        const change = String(wish.peek() ?? '').trim();
        if (!file || file.readOnly || !change || busy.peek()) return;
        await run(async () => {
            const settings = await call('decision.settings');
            const workerId = settings.ok ? settings.value?.decider?.workerId : undefined;
            const answer = await call('model.generate', {
                ...(workerId ? { workerId } : {}), maxTokens: 4000, temperature: 0.2, stream: false,
                reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
                messages: [{ role: 'system', content: AI_INSTRUCTION }, { role: 'user', content: `FILE ${file.path}\n\n${draftOf(id)}\n\nCHANGE: ${change}` }],
            });
            const edits = parseEdits(answer.ok ? answer.value?.text ?? answer.value : '');
            if (!edits.length) throw new Error('The AI returned no edits — try saying it differently.');
            proposals.set({ ...proposals.peek(), [id]: edits.map((edit, index) => ({ ...edit, key: `${Date.now()}_${index}` })) });
        }, 'The AI proposed edits — accept or reject each one.');
    }

    function accept(id, proposal) {
        setDraft(id, applyEdit(draftOf(id), proposal).text);
        proposals.set({ ...proposals.peek(), [id]: (proposals.peek()[id] ?? []).filter(item => item.key !== proposal.key) });
        if (!saveNote.peek()) saveNote.set(`AI: ${String(wish.peek() ?? '').trim()}`);
    }
    const reject = (id, proposal) => proposals.set({ ...proposals.peek(), [id]: (proposals.peek()[id] ?? []).filter(item => item.key !== proposal.key) });
    const acceptAll = id => { for (const proposal of [...(proposals.peek()[id] ?? [])]) accept(id, proposal); };

    async function newBlock(sectionId) {
        const name = ask('Name of the new block', 'New block');
        if (!name) return;
        const block = { id: `blk_${Date.now().toString(36)}`, name: String(name), role: 'system', content: '' };
        await run(async () => {
            const next = structuredClone(sections.peek());
            const section = next[sectionId] ?? (next[sectionId] = { blocks: [], tree: [], presets: [], activePresetId: '' });
            const add = holder => { holder.blocks = [...(holder.blocks ?? []), { ...block }]; holder.tree = [...(holder.tree ?? []), { type: 'item', block: block.id, enabled: true }]; };
            add(section);
            withPreset(section, add);
            await writeSections(next);
        }, 'Block created.');
        open(`block:${sectionId}:${block.id}`);
    }

    async function changeBlock(id, change, done) {
        const file = byId(id);
        if (file?.kind !== 'block') return;
        await run(async () => {
            const next = structuredClone(sections.peek());
            change(next[file.section], file);
            await writeSections(next);
        }, done);
    }

    function renameBlock(id) {
        const file = byId(id);
        const name = ask('New name', file?.title ?? '');
        if (!name || !file) return;
        const rename = holder => { const block = holder.blocks?.find(entry => entry.id === file.blockId); if (block) block.name = String(name); };
        changeBlock(id, section => { rename(section); withPreset(section, rename); }, 'Renamed.');
    }
    const setBlockRole = (id, role) => changeBlock(id, (section, file) => { const block = section.blocks?.find(entry => entry.id === file.blockId); if (block) block.role = role; }, 'Role changed.');

    async function duplicateBlock(id) {
        const file = byId(id);
        if (file?.kind !== 'block') return;
        const copyId = `blk_${Date.now().toString(36)}`;
        await changeBlock(id, section => {
            section.blocks = [...section.blocks, { id: copyId, name: `${file.title} (copy)`, role: file.blockRole, content: draftOf(id) }];
            section.tree = [...(section.tree ?? []), { type: 'item', block: copyId, enabled: true }];
        }, 'Duplicated.');
        open(`block:${file.section}:${copyId}`);
    }

    async function deleteBlock(id) {
        const file = byId(id);
        if (file?.kind !== 'block') return;
        const prune = nodes => (nodes ?? []).filter(node => !(node.type === 'item' && node.block === file.blockId))
            .map(node => (Array.isArray(node.children) ? { ...node, children: prune(node.children) } : node));
        const drop = holder => { holder.blocks = (holder.blocks ?? []).filter(entry => entry.id !== file.blockId); holder.tree = prune(holder.tree); };
        await changeBlock(id, section => { drop(section); withPreset(section, drop); }, 'Deleted — it stays in History.');
        await remember(file, file.text, 'deleted');
        close(id);
    }

    const ctx = {
        files, current, tabs, active, search, expanded, history, note, saveNote, wish, proposals, busy, showHistory,
        draftOf, isDirty, viewOf, problemsOf, open, close, setDraft, setView, toggleFolder, save, discard, restore, resetToDefault,
        askAi, accept, reject, acceptAll, newBlock, renameBlock, setBlockRole, duplicateBlock, deleteBlock,
    };

    const tree = () => h('div', { class: 'stme-files' }, filesTreeView(ctx), filesEditorView(ctx));

    return { tree, load, openPath, ...ctx };
}
