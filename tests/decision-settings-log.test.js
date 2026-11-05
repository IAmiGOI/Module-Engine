import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAction } from '../libraries/core/decision-probability.js';
import { buildCycleEntry, toolRow } from '../libraries/core/decision-feed.js';
import { describeSettingsChange, settingsLabel, DEFAULT_GAME_SETTINGS, modeValues } from '../libraries/core/game-settings.js';
import { createRollback } from '../cores/decision/rollback.js';
import { createDecisionStore } from '../cores/decision/store.js';

test('the roll keeps the level the director chose and the level the settings made of it', () => {
    const easy = assessAction({ difficulty: 'moderate', experience: 'novice', difficultyShift: -1, seed: 1 });
    assert.equal(easy.difficulty, 'moderate');
    assert.equal(easy.difficultyEffective, 'easy');
    assert.equal(easy.difficultyShift, -1);

    const brutal = assessAction({ difficulty: 'moderate', experience: 'novice', difficultyShift: 2, seed: 1 });
    assert.equal(brutal.difficultyEffective, 'very hard');
    const edge = assessAction({ difficulty: 'nearly impossible', experience: 'novice', difficultyShift: 2, seed: 1 });
    assert.equal(edge.difficultyEffective, 'nearly impossible', 'the shift stops at the table edge');
    const normal = assessAction({ difficulty: 'hard', experience: 'novice', difficultyShift: 0, seed: 1 });
    assert.equal(normal.difficultyEffective, 'hard');
});

test('the director log row carries the effective level, so the window can show "moderate → hard"', () => {
    const row = toolRow({
        name: 'assess', args: { difficulty: 'moderate', experience: 'novice', comment: 'She tries.' },
        result: { ok: true, character: 'Kael', action: 'picks the lock', difficulty: 'moderate', difficultyEffective: 'hard', difficultyShift: 1, probability: 0.45, roll: 0.3, degree: 'clean', words: 'cleanly' },
    });
    assert.equal(row.kind, 'assess');
    assert.equal(row.difficulty, 'moderate');
    assert.equal(row.effective, 'hard');
    assert.equal(row.shift, 1);
});

test('a settings change reads as a short line of the journal', () => {
    const classic = { ...DEFAULT_GAME_SETTINGS };
    assert.equal(describeSettingsChange(classic, { ...classic, tone: 'dark' }), 'Classic → Custom: Tone Dark');
    assert.equal(describeSettingsChange(modeValues('story'), modeValues('hardcore')), 'Story → Hardcore');
    assert.equal(describeSettingsChange({ ...classic, tone: 'dark' }, classic), 'Custom → Classic');
    const custom = { ...classic, tone: 'dark', difficulty: 'hard' };
    assert.equal(describeSettingsChange(custom, { ...custom, romance: 'off' }), 'Custom: Romance Off');
});

test('the turn label is the mode and the options that differ from it', () => {
    const story = settingsLabel(modeValues('story'));
    assert.equal(story.mode, 'story');
    assert.deepEqual(story.changed, [], 'a ready mode differs from its own base in nothing');

    const custom = settingsLabel({ ...DEFAULT_GAME_SETTINGS, tone: 'dark' });
    assert.equal(custom.mode, 'custom');
    assert.deepEqual(custom.changed.map(item => item.id), ['tone']);
    assert.equal(custom.changed[0].label, 'Dark');
});

test('the settings line is a feed row, not a user message', () => {
    const entry = buildCycleEntry({
        id: 'cyc_settings', event: 'settings', at: 1, wake: { label: 'Game settings changed', detail: 'Classic → Custom: Tone Dark' },
        message: { text: 'Classic → Custom: Tone Dark', at: 1 }, toolCalls: [],
    });
    assert.equal(entry.title, 'Game settings changed');
    const row = entry.rows.find(item => item.kind === 'settings');
    assert.ok(row, 'the line is a settings row');
    assert.match(row.text, /Classic → Custom: Tone Dark/);
    assert.equal(entry.rows.some(item => item.kind === 'message'), false);
});

test('a saved turn keeps its game label and the rolls its form refers to', async () => {
    const memory = new Map();
    const call = async (contract, params = {}) => {
        if (contract === 'chatHistory.messages') return [{ mesid: 7, mes: 'The reply.' }];
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
        throw new Error(`unexpected ${contract}`);
    };
    const store = createDecisionStore({ call, publishEvent: () => {} });
    await store.reload();
    await store.persist({
        runId: 'run_1', chatLength: 7, type: 'normal', decision: 'She leaves.', push: 'She leaves.',
        form: { characters: [{ name: 'Kael', assessId: 'a1' }] },
        assessments: [{ id: 'a1', words: 'cleanly' }],
        game: { mode: 'custom', changed: [{ id: 'tone', label: 'Dark' }] },
    });
    const record = store.runs()['7'];
    assert.equal(record.game.mode, 'custom');
    assert.equal(record.game.changed[0].label, 'Dark');
    assert.equal(record.assessments[0].id, 'a1');
});

test('a turn snapshot and its rollback never touch the game settings', async () => {
    const calls = [];
    const store = {
        roster: () => ({ active: [] }), plan: () => null, arcs: () => [], notes: () => ({}),
        library: () => ({}), plans: () => [], clock: () => ({ minutes: 0 }),
        saveRoster: async () => {}, savePlan: async () => {}, saveArcs: async () => {}, saveNotes: async () => {},
        saveLibrary: async () => {}, savePlans: async () => {}, saveClock: async () => {},
        restoreJournal: async () => {},
    };
    const rollback = createRollback({ store, getSettings: () => ({ snapshots: true }) });
    const snapshot = await rollback.snapshotState('run_1', null);
    assert.equal('gameSettings' in snapshot, false, 'settings are not part of the turn snapshot');
    assert.equal('game' in snapshot, false);
    await rollback.restoreState(snapshot);
    assert.deepEqual(calls, [], 'nothing writes settings during a rollback');
});
