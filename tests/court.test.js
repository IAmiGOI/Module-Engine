import test from 'node:test';
import assert from 'node:assert/strict';
import { laneOfEntry, splitEntry, lanesFrom, toolLabel, entrySummary, turnsIn } from '../libraries/core/court-lanes.js';
import { diffHunks, diffStats, applyEdit, applyEdits, parseEdits } from '../libraries/core/text-diff.js';

test('cycles fall into the five lanes; the Inscription of a turn goes to the Writer', () => {
    assert.equal(laneOfEntry({ event: 'turn' }), 'resolver');
    assert.equal(laneOfEntry({ event: 'counsellor' }), 'counsellor');
    assert.equal(laneOfEntry({ event: 'decree' }), 'director');
    assert.equal(laneOfEntry({ event: 'creation' }), 'god');
    const turn = { id: 'c1', event: 'turn', turn: 4, rows: [{ kind: 'call', name: 'inscribe', args: {} }, { kind: 'push', text: 'INSCRIPTION' }] };
    const parts = splitEntry(turn);
    assert.deepEqual(Object.keys(parts).sort(), ['resolver', 'writer']);
    assert.equal(parts.writer.rows[0].kind, 'push');
    const lanes = lanesFrom([turn, { id: 'c2', event: 'decree', turn: 5, rows: [] }], { turn: 4 });
    assert.equal(lanes.resolver.length, 1);
    assert.equal(lanes.director.length, 0);
    assert.deepEqual(turnsIn([turn, { turn: 2 }, { turn: 4 }]), [2, 4]);
});

test('tool calls read as what they mean, and a card has a one-line summary', () => {
    assert.equal(toolLabel('decree', { decrees: [{ character: 'Emilia' }, { character: 'Puck' }] }), 'Decree for Emilia, Puck');
    assert.equal(toolLabel('petition', { character: 'Echidna' }), 'Petition about Echidna');
    assert.match(entrySummary({ rows: [{ kind: 'message', text: 'Make it darker' }, { kind: 'counsellor_reply', text: 'Noted.' }] }), /You: Make it darker · Answered: Noted\./);
});

test('diffs show only the changed lines with context, and edits never refuse', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng';
    const after = 'a\nb\nC\nd\ne\nf\ng\nh';
    const hunks = diffHunks(before, after, { context: 1 });
    assert.equal(hunks.length, 2);
    assert.deepEqual(diffStats(before, after), { added: 2, removed: 1 });
    assert.equal(applyEdit('One line.\nTwo  lines here.', { old: 'two lines here', new: 'Second.' }).text, 'One line.\nSecond.');
    assert.equal(applyEdit('Text.', { old: 'missing', new: 'Added.' }).how, 'appended');
    assert.equal(applyEdits('x y', [{ old: 'x', new: 'z' }]).text, 'z y');
    assert.deepEqual(parseEdits('```json\n[{"old":"a","new":"b"}]\n```'), [{ old: 'a', new: 'b' }]);
    assert.deepEqual(parseEdits('{"edits":[{"old":"a","new":""}]}'), [{ old: 'a', new: '' }]);
});

test('Files: blocks, characters and built-ins in one tree; save keeps history; a built-in edit reaches the engine', async () => {
    const { createCourtFiles } = await import('../cores/ui/court-files.js');
    let settings = { promptSections: { director: { blocks: [{ id: 'b1', name: 'Need Guidelines', role: 'system', content: 'Needs are wants.\nIndependence is for all.' }], tree: [{ type: 'item', block: 'b1', enabled: true }], presets: [{ id: 'p1', blocks: [{ id: 'b1', name: 'Need Guidelines', content: 'old copy' }], tree: [] }], activePresetId: 'p1' }, writer: { blocks: [] } }, decider: { workerId: 'w' } };
    const stored = {};
    const call = async (contract, params) => {
        if (contract === 'decision.settings') return { ok: true, value: settings };
        if (contract === 'decision.configure') { settings = { ...settings, ...params.patch }; return { ok: true, value: settings }; }
        if (contract === 'decision.greatBank') return { ok: true, value: { Echidna: { name: 'Echidna', importance: 'main', material: { 5: ['Wool dress'] }, spiritual: {}, decree: {} } } };
        if (contract === 'storage.settings.get') return { ok: true, value: stored[params.key] ?? params.fallback };
        if (contract === 'storage.settings.set') { stored[params.key] = params.value; return { ok: true }; }
        if (contract === 'model.generate') return { ok: true, value: '[{"old":"Independence is for all.","new":"Independence depends on values."}]' };
        return { ok: true, value: null };
    };
    const files = createCourtFiles({ call });
    await files.load();
    const paths = files.files().map(file => file.path);
    assert.ok(paths.includes('Your blocks/Director/need-guidelines.md'));
    assert.ok(paths.includes('Characters/Echidna/material.md'));
    assert.ok(paths.some(path => path.startsWith('Built-in/Director/')));
    assert.equal(files.active(), 'block:director:b1');
    files.setDraft('block:director:b1', 'Needs are wants.\nIndependence is rare.');
    assert.equal(files.isDirty('block:director:b1'), true);
    files.saveNote.set('Make independence rare');
    await files.save('block:director:b1');
    assert.equal(settings.promptSections.director.blocks[0].content, 'Needs are wants.\nIndependence is rare.');
    assert.equal(settings.promptSections.director.presets[0].blocks[0].content, 'Needs are wants.\nIndependence is rare.', 'the active preset copy follows');
    assert.deepEqual(stored.history['block:director:b1'].map(entry => entry.note), ['Make independence rare']);
    files.wish.set('soften it');
    await files.askAi('block:director:b1');
    assert.equal(files.proposals()['block:director:b1'].length, 1);
    files.restore('block:director:b1', stored.history['block:director:b1'][0]);
    assert.equal(files.draftOf('block:director:b1'), 'Needs are wants.\nIndependence is for all.');
    assert.equal(files.viewOf('block:director:b1'), 'diff');
    const built = files.files().find(file => file.kind === 'builtin' && !/\{\{/.test(file.base));
    files.open(built.id);
    files.setDraft(built.id, `${built.base}\nOne more rule.`);
    await files.save(built.id);
    assert.equal(settings.promptOverrides[built.id], `${built.base}\nOne more rule.`);
    const { setPromptOverrides, promptText } = await import('../libraries/core/prompt-overrides.js');
    const { builtInPrompts } = await import('../libraries/core/prompt-catalog.js');
    setPromptOverrides(settings.promptOverrides, builtInPrompts());
    assert.equal(promptText(built.base), `${built.base}\nOne more rule.`, 'the engine uses the edited text');
    setPromptOverrides({}, builtInPrompts());
    const withVars = files.files().find(file => file.kind === 'builtin' && /\{\{/.test(file.base));
    files.open(withVars.id);
    files.setDraft(withVars.id, withVars.base.replace(/\{\{\s*[a-z0-9_]+\s*\}\}/i, ''));
    await files.save(withVars.id);
    assert.ok(!settings.promptOverrides?.[withVars.id], 'a lost {{variable}} blocks the save');
});

test('Files: a new block is added to the section and the preset; deleting removes it from both and keeps it in history', async () => {
    const { createCourtFiles } = await import('../cores/ui/court-files.js');
    let settings = { promptSections: { director: { blocks: [], tree: [], presets: [{ id: 'p1', blocks: [], tree: [] }], activePresetId: 'p1' } } };
    const stored = {};
    const call = async (contract, params) => {
        if (contract === 'decision.settings') return { ok: true, value: settings };
        if (contract === 'decision.configure') { settings = { ...settings, ...params.patch }; return { ok: true, value: settings }; }
        if (contract === 'storage.settings.get') return { ok: true, value: stored[params.key] ?? params.fallback };
        if (contract === 'storage.settings.set') { stored[params.key] = params.value; return { ok: true }; }
        return { ok: true, value: {} };
    };
    const files = createCourtFiles({ call });
    await files.load();
    await files.newBlock('director');
    const section = settings.promptSections.director;
    assert.equal(section.blocks.length, 1);
    assert.equal(section.presets[0].blocks.length, 1);
    assert.equal(section.tree[0].block, section.blocks[0].id);
    const id = files.active();
    await files.deleteBlock(id);
    assert.equal(settings.promptSections.director.blocks.length, 0);
    assert.equal(settings.promptSections.director.presets[0].blocks.length, 0);
    assert.equal(stored.history[id][0].by, 'deleted');
    assert.equal(files.tabs().includes(id), false);
});

test('Files model: tree with counts, search hits, variables, markdown and numbered hunks', async () => {
    const { buildTree, searchFiles, placeholderProblems, roleOfPrompt, hunkHeader } = await import('../libraries/core/court-files-model.js');
    const { markdownBlocks } = await import('../libraries/core/court-markdown.js');
    const { diffHunks } = await import('../libraries/core/text-diff.js');
    const tree = buildTree([{ id: 'a', path: 'Built-in/Director/x.md', changed: true, text: 'alpha beta' }, { id: 'b', path: 'Built-in/Writer/y.md', text: 'beta' }]);
    assert.equal(tree.children[0].count, 2);
    assert.equal(tree.children[0].changed, 1);
    assert.deepEqual([...searchFiles([{ id: 'a', path: 'x', text: 'beta beta' }], 'beta')], [['a', 2]]);
    assert.deepEqual(placeholderProblems('Hi {{name}} and {{thinking}}', 'Hi {{name}} {{extra}}'), { missing: ['thinking'], unknown: ['extra'] });
    assert.equal(roleOfPrompt('RESOLVER_THINK_TURN'), 'resolver');
    assert.equal(roleOfPrompt('WRITER_SYSTEM'), 'writer');
    const blocks = markdownBlocks('# Title\n\n**Bold** rule with {{name}}\n- item\n```\ncode\n```');
    assert.deepEqual(blocks.map(block => block.type), ['h', 'p', 'li', 'code']);
    assert.equal(blocks[1].inline[0].t, 'b');
    const hunk = diffHunks('a\nb\nc', 'a\nB\nc')[0];
    assert.equal(hunkHeader(hunk), '@@ −1,3 +1,3 @@');
});

test('a character part renders as a file and its edit becomes bank edits', async () => {
    const { renderPart, editsForPart, parsePart } = await import('../libraries/core/court-bank-files.js');
    const character = { name: 'Echidna', material: { 5: ['[2026-03-07 04:15] Stolen wool dress'], 1: ['White hair'] } };
    const before = renderPart(character, 'material');
    assert.match(before, /## 5\. Clothing\n- \[2026-03-07 04:15\] Stolen wool dress/);
    const after = before.replace('- [2026-03-07 04:15] Stolen wool dress', '- A black silk dress').replace('## 4. Carried items', '## 4. Carried items\n- A lantern');
    const edits = editsForPart('Echidna', 'material', before, after);
    assert.deepEqual(edits, [
        { character: 'Echidna', section: 'material 4', old: '', new: 'A lantern' },
        { character: 'Echidna', section: 'material 5', old: '[2026-03-07 04:15] Stolen wool dress', new: 'A black silk dress' },
    ]);
    assert.deepEqual(parsePart(after, 'material')[1], ['White hair']);
});

test('Files renders the tree and every view of every kind of file', async () => {
    const { createCourtFiles } = await import('../cores/ui/court-files.js');
    const settings = { promptSections: { director: { blocks: [{ id: 'b1', name: 'Rules', role: 'system', content: '# Rules\n- one {{name}}' }] } } };
    const call = async contract => (contract === 'decision.settings' ? { ok: true, value: settings }
        : contract === 'decision.greatBank' ? { ok: true, value: { Emilia: { name: 'Emilia', material: { 1: ['Silver hair'] }, spiritual: {}, decree: {} } } }
            : { ok: true, value: {} });
    const files = createCourtFiles({ call });
    await files.load();
    const resolve = value => (typeof value === 'function' ? resolve(value()) : value);
    const walk = node => { const value = resolve(node); if (Array.isArray(value)) return value.forEach(walk); if (value && typeof value === 'object' && value.children) value.children.forEach(walk); };
    for (const id of ['block:director:b1', 'character:Emilia:material', 'character:Emilia:decree', files.files().find(file => file.kind === 'builtin').id]) {
        files.open(id);
        files.setDraft(id, `${files.draftOf(id)}\nextra`);
        for (const view of ['edit', 'preview', 'diff', 'default']) { files.setView(id, view); walk(files.tree()); }
    }
    files.search.set('silver');
    walk(files.tree());
    assert.ok(true);
});

test('file edits read as what they change', async () => {
    const { toolLabel, toolFields } = await import('../libraries/core/court-lanes.js');
    const args = { edits: [{ path: 'Characters/Lena/decree.md', old: '- Today: find the key.', new: '- Today: hide.' }] };
    assert.equal(toolLabel('edit', args), 'Edit — Lena/decree.md');
    assert.deepEqual(toolFields('edit', args), [['Lena/decree.md', '- Today: find the key.  →  - Today: hide.']]);
});
