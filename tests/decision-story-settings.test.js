import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    GAME_OPTIONS, DEFAULT_GAME_SETTINGS, buildStorySettingsBlock, modeValues, patchGameSettings,
} from '../libraries/core/game-settings.js';
import {
    STORY_SETTINGS_RULES, STORY_SETTINGS_HEADER, DIRECTOR_SYSTEM, DIRECTOR_TURN, WRITER_SYSTEM,
} from '../libraries/core/decision-prompts.js';
import { buildDeciderContext, buildWriterContext } from '../libraries/core/decision-context.js';
import { createCycleContext } from '../cores/decision/cycle-context.js';

const doc = () => readFileSync(new URL('../docs/research-decision/PROMPTS.md', import.meta.url), 'utf8');

test('every rule line is PROMPTS.md section 22 word for word', () => {
    const text = doc();
    const section = text.slice(text.indexOf('## 22. STORY SETTINGS'));
    assert.ok(section.length > 0, 'the section exists');
    for (const [index, option] of GAME_OPTIONS.slice(0, 14).entries()) {
        const heading = `**${index + 1}. ${option.id}**`;
        const at = section.indexOf(heading);
        assert.ok(at >= 0, `${heading} exists`);
        const fence = section.indexOf('```text', at);
        const body = section.indexOf('\n', fence) + 1;
        const lines = section.slice(body, section.indexOf('```', body)).trimEnd().split('\n');
        assert.equal(lines.length, option.values.length, `${option.id} has a line per value`);
        for (const [position, item] of option.values.entries()) {
            const prefix = `${item.value}: `;
            assert.ok(lines[position].startsWith(prefix), `${option.id}.${item.value} is listed`);
            assert.equal(lines[position].slice(prefix.length), STORY_SETTINGS_RULES[option.id][item.value], `${option.id}.${item.value} is word for word`);
        }
    }
});

test('the block holds only the chosen values of its own side, in option order', () => {
    const values = patchGameSettings(modeValues('story'), { tone: 'dark' });
    const director = buildStorySettingsBlock('director', values);
    const lines = director.split('\n');
    assert.equal(lines[0], STORY_SETTINGS_HEADER);
    assert.equal(lines.length, 10, 'header plus nine director rules');
    for (const id of ['difficulty', 'power', 'consequences', 'pacing', 'initiative', 'canon', 'romance', 'tone', 'hooks']) {
        assert.ok(lines.includes(STORY_SETTINGS_RULES[id][values[id]]), `${id} uses the chosen value`);
    }
    assert.ok(lines.includes(STORY_SETTINGS_RULES.tone.dark));
    assert.ok(!lines.includes(STORY_SETTINGS_RULES.tone.light), 'the other value is not there');

    const writer = buildStorySettingsBlock('writer', values);
    assert.equal(writer.split('\n').length, 6, 'header plus five writer rules');
    assert.ok(writer.includes(STORY_SETTINGS_RULES.replyLength.medium));
    assert.ok(!director.includes(STORY_SETTINGS_RULES.replyLength.medium), 'the writer rules stay with the writer');
    assert.equal(buildStorySettingsBlock('nobody', values), '');
});

const memory = new Map();
const call = async (contract, params = {}) => {
    if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? structuredClone(memory.get(params.key)) : params.fallback;
    if (contract === 'storage.chatMemory.set') { memory.set(params.key, structuredClone(params.value)); return true; }
    if (contract === 'lorebook.books') return [];
    if (contract === 'lorebook.entries') return [];
    throw new Error(`unexpected ${contract}`);
};

function makeStore() {
    let boundary = null;
    return {
        roster: () => ({ active: [] }), library: () => ({}), plans: () => [], clock: () => ({ minutes: 0 }),
        plan: () => null, arcs: () => [], notes: () => ({}), cycles: () => [], digests: () => [],
        boundary: () => boundary, saveBoundary: async value => { boundary = value; return value; },
        gameSettings: () => null,
    };
}

test('without a settings change the protected part is byte-identical between turns', async () => {
    memory.clear();
    const store = makeStore();
    const game = { ...DEFAULT_GAME_SETTINGS };
    const context = createCycleContext({ call, store, banks: null, getGameSettings: () => game });
    const settings = { promptSections: {} };
    const first = await context.runContext({ settings, chat: [], worker: { id: 'director' } });
    const second = await context.runContext({ settings, chat: [], worker: { id: 'director' } });
    assert.deepEqual(second.messages, first.messages);
});

test('changing a setting changes the block and nothing else in the protected part', async () => {
    memory.clear();
    const store = makeStore();
    let game = { ...DEFAULT_GAME_SETTINGS };
    const context = createCycleContext({ call, store, banks: null, getGameSettings: () => game });
    const settings = { promptSections: {} };
    const before = await context.runContext({ settings, chat: [], worker: { id: 'director' } });
    assert.equal(before.messages[0].content, DIRECTOR_SYSTEM);
    assert.ok(before.messages[1].content.startsWith(STORY_SETTINGS_HEADER), 'the block follows the system prompt at once');

    game = { ...DEFAULT_GAME_SETTINGS, difficulty: 'brutal' };
    const after = await context.runContext({ settings, chat: [], worker: { id: 'director' } });
    assert.equal(after.messages[0].content, before.messages[0].content);
    assert.notEqual(after.messages[1].content, before.messages[1].content);
    assert.ok(after.messages[1].content.includes(STORY_SETTINGS_RULES.difficulty.brutal));
    assert.deepEqual(after.messages.slice(2), before.messages.slice(2), 'nothing else moved');
});

test('the writer gets its own block right after its system prompt', () => {
    const block = buildStorySettingsBlock('writer', DEFAULT_GAME_SETTINGS);
    const context = buildWriterContext({ chat: [], decision: 'The door opens.', storySettings: block });
    assert.equal(context.messages[0].content, WRITER_SYSTEM);
    assert.equal(context.messages[1].content, block);
    const director = buildDeciderContext({ storySettings: buildStorySettingsBlock('director', DEFAULT_GAME_SETTINGS) });
    assert.equal(director.messages[0].content, DIRECTOR_SYSTEM);
    assert.ok(director.messages[1].content.startsWith(STORY_SETTINGS_HEADER));
});

test('Classic keeps the rules that moved into options, and the turn task no longer repeats them', () => {
    const classic = buildStorySettingsBlock('director', DEFAULT_GAME_SETTINGS);
    assert.match(classic, /abilities as stated, at full strength/);
    assert.match(classic, /Move one thing forward each turn/);
    assert.match(classic, /End the turn at the first point where the user would naturally react/);
    assert.match(classic, /hold to their canon/);
    assert.doesNotMatch(DIRECTOR_TURN, /Take them as stated, at full strength/);
    assert.doesNotMatch(DIRECTOR_TURN, /At most one new complication per turn/);
    assert.match(DIRECTOR_SYSTEM, /STORY SETTINGS/);
    assert.match(DIRECTOR_TURN, /follows STORY SETTINGS/);
});
