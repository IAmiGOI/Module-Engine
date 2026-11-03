import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeciderContext, buildWriterContext, DIRECTOR_BLOCK_CYCLES, WRITER_BLOCK_DEPTH } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';
import { buildToolList } from '../libraries/core/decision-tools.js';
import { DIRECTOR_SYSTEM, DIRECTOR_PASSIVE, DIRECTOR_FORCED_MEMORY, DIRECTOR_ARC_SUMMARY, RESEARCHER_SYSTEM, BANK_COMPRESSION, fillPrompt } from '../libraries/core/decision-prompts.js';

const BLOCK = 'USER CUSTOM BLOCK';

function chat(cycles) {
    const out = [];
    for (let index = 0; index < cycles; index += 1) {
        out.push({ mes: `user ${index}`, is_user: true });
        out.push({ mes: `assistant ${index}`, is_user: false });
    }
    return out;
}

function directorHistoryOf(context) {
    return context.messages.slice(1, -2);
}

function writerHistoryOf(context) {
    return context.messages.slice(1, -1);
}

function blockAt(messages) {
    return messages.findIndex(message => message.content === BLOCK);
}

test('the director custom block sits before the last two full cycles, and before everything when there are fewer', () => {
    const cases = [
        [0, 0, 0],
        [1, 0, 2],
        [2, 0, 4],
        [5, 6, 4],
    ];
    for (const [cycles, before, after] of cases) {
        const context = buildDeciderContext({ chat: chat(cycles), directorBlock: BLOCK });
        const history = directorHistoryOf(context);
        assert.equal(blockAt(history), before, `${cycles} cycles: block before ${before} history messages`);
        assert.equal(history.length - blockAt(history) - 1, after, `${cycles} cycles: ${after} history messages follow`);
        assert.equal(history.filter(message => message.content !== BLOCK).length, cycles * 2);
    }
    assert.equal(DIRECTOR_BLOCK_CYCLES, 2);
});

test('the writer custom block sits five messages from the end of the story, and before everything when the story is shorter', () => {
    const short = buildWriterContext({ chat: chat(1), decision: 'push', writerBlock: BLOCK });
    assert.equal(blockAt(writerHistoryOf(short)), 0, 'two messages are fewer than five: the block goes first');
    const exact = buildWriterContext({ chat: [{ mes: 'u0', is_user: true }, { mes: 'a0' }, { mes: 'u1', is_user: true }, { mes: 'a1' }, { mes: 'u2', is_user: true }], decision: 'push', writerBlock: BLOCK });
    assert.equal(blockAt(writerHistoryOf(exact)), 0, 'exactly five messages: first');
    const long = buildWriterContext({ chat: chat(5), decision: 'push', writerBlock: BLOCK });
    const history = writerHistoryOf(long);
    assert.equal(history.filter(message => message.content !== BLOCK).length, 10);
    assert.equal(blockAt(history), 5, 'ten messages: five from the end');
    assert.equal(history.length - blockAt(history) - 1, 5);
    assert.equal(WRITER_BLOCK_DEPTH, 5);
});

test('an empty custom block is not inserted at all, and the push stays after the history', () => {
    const director = buildDeciderContext({ chat: chat(3), directorBlock: '   ' });
    assert.equal(director.messages.some(message => message.role === 'system' && !message.content), false);
    const writer = buildWriterContext({ chat: chat(3), decision: 'push', writerBlock: '' });
    assert.equal(writer.messages.some(message => message.content === ''), false);
    assert.match(writer.messages.at(-1).content, /^PUSH — what happens this turn:/);
    assert.equal(writer.messages.at(-1).role, 'system');
});

test('a block at two cycles costs less of the shared prefix than the same block at the start of the request', () => {
    const previousChat = chat(4);
    const nextChat = chat(5);
    const withStart = context => {
        const messages = [...context.messages];
        messages.splice(1, 0, { role: 'system', content: BLOCK });
        return messages;
    };
    const start = compareRequests(
        withStart(buildDeciderContext({ chat: previousChat })),
        withStart(buildDeciderContext({ chat: nextChat })),
    );
    const depth = compareRequests(
        buildDeciderContext({ chat: previousChat, directorBlock: BLOCK }).messages,
        buildDeciderContext({ chat: nextChat, directorBlock: BLOCK }).messages,
    );
    assert.ok(depth.sharedTokens < start.sharedTokens, `depth ${depth.sharedTokens} < start ${start.sharedTokens}`);
    assert.match(DIRECTOR_PASSIVE, /\{\{event\}\}/);
});

test('every built-in prompt fills its placeholders, and none is left with a raw {{…}}', () => {
    const filled = [
        fillPrompt(DIRECTOR_PASSIVE, { event: 'A plan ended.' }),
        fillPrompt(DIRECTOR_FORCED_MEMORY, { summaries: '[s1]' }),
        fillPrompt(DIRECTOR_ARC_SUMMARY, { arcs: 'ARC: one' }),
        fillPrompt(RESEARCHER_SYSTEM, { steps: 5 }),
        fillPrompt(BANK_COMPRESSION, { records: '- one' }),
    ];
    for (const text of filled) assert.doesNotMatch(text, /\{\{[a-z0-9_]+\}\}/i);
    assert.equal(fillPrompt('a {{value}} b', { value: 'x' }), 'a x b');
    assert.throws(() => fillPrompt('{{missing}}', {}), /no value/);
});

test('the director prompt names exactly the tools the engine gives it, and no description still talks about an on/off core', () => {
    const named = new Set();
    for (const line of DIRECTOR_SYSTEM.split('\n')) {
        const match = line.match(/^- ([a-z_]+(?:, [a-z_]+)*) —/);
        if (match) match[1].split(', ').forEach(name => named.add(name));
    }
    const tools = buildToolList();
    const names = new Set(tools.map(tool => tool.name));
    for (const name of named) assert.ok(names.has(name), `the prompt names "${name}" but there is no such tool`);
    for (const name of names) if (name !== 'save_draft' && name !== 'lorebook') assert.ok(named.has(name), `the tool "${name}" is not explained in the director prompt`);
    for (const tool of tools) assert.doesNotMatch(String(tool.description ?? ''), /while the core is on/i);
});
