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

test('a block file is edited, reviewed as a diff, saved, kept in history; an AI edit is accepted one by one', async () => {
    const { createCourtFiles } = await import('../cores/ui/court-files.js');
    let settings = { promptSections: { director: { blocks: [{ id: 'b1', name: 'Need Guidelines', content: 'Needs are wants.\nIndependence is for all.' }] }, writer: { blocks: [] } }, decider: { workerId: 'w' } };
    const stored = {};
    const calls = [];
    const call = async (contract, params) => {
        calls.push(contract);
        if (contract === 'decision.settings') return { ok: true, value: settings };
        if (contract === 'decision.configure') { settings = { ...settings, ...params.patch }; return { ok: true, value: settings }; }
        if (contract === 'storage.settings.get') return { ok: true, value: stored[params.key] ?? params.fallback };
        if (contract === 'storage.settings.set') { stored[params.key] = params.value; return { ok: true }; }
        if (contract === 'model.generate') return { ok: true, value: '[{"old":"Independence is for all.","new":"Independence depends on values."}]' };
        return { ok: true, value: null };
    };
    const files = createCourtFiles({ call });
    await files.load();
    assert.equal(files.selected(), 'blocks/director/b1');
    assert.ok(files.files().some(file => file.builtIn && file.id.startsWith('built-in/')), 'built-in prompts are listed');
    files.draft.set('Needs are wants.\nIndependence is rare.');
    files.reviewing.set(true);
    await files.save();
    assert.equal(settings.promptSections.director.blocks[0].content, 'Needs are wants.\nIndependence is rare.');
    assert.equal(stored.history['blocks/director/b1'].length, 1);
    files.draft.set('Needs are wants.\nIndependence is for all.');
    const built = files.files().find(file => file.builtIn);
    files.open(built.id);
    files.draft.set(`${built.base}\nOne more rule.`);
    files.reviewing.set(true);
    await files.save();
    assert.equal(settings.promptOverrides[built.id], `${built.base}\nOne more rule.`);
    const { setPromptOverrides, promptText } = await import('../libraries/core/prompt-overrides.js');
    const { builtInPrompts } = await import('../libraries/core/prompt-catalog.js');
    setPromptOverrides(settings.promptOverrides, builtInPrompts());
    assert.equal(promptText(built.base), `${built.base}\nOne more rule.`, 'the engine uses the edited text');
    setPromptOverrides({}, builtInPrompts());
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
