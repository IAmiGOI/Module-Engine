import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDeciderContext, buildWriterContext, historyMessages, selectRecentChat,
    summariesSection, blocksSection, runsSection, RECENT_MESSAGE_LIMIT,
} from '../libraries/core/decision-context.js';

function message(text, extra = {}) {
    return { mes: text, ...extra };
}

function toolCall(name, result) {
    return message(`${name} was called`, { is_system: true, extra: { tool_invocations: [{ id: `call_${name}`, name, parameters: '{}', result }] } });
}

test('history is the last 20 logical units, and a tool-call chain is never cut from the reply that follows it', () => {
    const chat = Array.from({ length: 25 }, (_, index) => message(`m${index}`));
    const selected = selectRecentChat(chat);
    assert.equal(selected.length, RECENT_MESSAGE_LIMIT);
    assert.equal(selected[0].mes, 'm5');
    assert.equal(selected.at(-1).mes, 'm24');

    const withTool = [...Array.from({ length: 21 }, (_, index) => message(`m${index}`)), toolCall('Notebook', 'Saved'), message('the real reply')];
    const tail = selectRecentChat(withTool, 1);
    assert.deepEqual(tail.map(entry => entry.mes), ['Notebook was called', 'the real reply'], 'the call and its reply stay one unit');
});

test('summary injections are excluded from the history tail: all summaries already travel as their own part', () => {
    const chat = [
        message('summary text', { is_system: true, name: 'Summary' }),
        message('older'),
        message('newer'),
    ];
    assert.deepEqual(selectRecentChat(chat).map(entry => entry.mes), ['older', 'newer']);
});

test('historyMessages expands a tool call into the same assistant + tool pair PM sends, and never leaks private _fields', () => {
    const messages = historyMessages([toolCall('Notebook', 'Saved')]);
    assert.deepEqual(messages, [
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_Notebook', type: 'function', function: { name: 'Notebook', arguments: '{}' } }] },
        { role: 'tool', content: 'Saved', tool_call_id: 'call_Notebook' },
    ]);
    assert.equal('_hid' in messages[0], false);
});

test('the director context puts stable rules and summaries first, volatile blocks last before the task, and ends with a user message', () => {
    const context = buildDeciderContext({
        rules: 'Never kill a named character.',
        blocks: [{ id: 'blk_goal', title: 'Goal', text: 'Find the exit.' }],
        summaries: [{ startIndex: 1, endIndex: 9, text: 'They arrived at the keep.' }],
        runs: { 5: { mesid: '5', decision: 'She trusted the guard.' } },
        chat: [message('older'), message('Where is the exit?', { is_user: true })],
    });
    assert.match(context.systemPrompt, /DIRECTOR RULES/);
    assert.match(context.systemPrompt, /Never kill a named character/);
    const contents = context.messages.map(item => item.content);
    assert.match(contents[0], /You are the director/);
    assert.match(contents[1], /LONG-TERM SUMMARIES/);
    assert.match(contents[2], /PAST DIRECTOR RUNS/);
    assert.match(contents[3], /CHARACTER BLOCKS/);
    assert.equal(context.messages.at(-2).role, 'user');
    assert.equal(context.messages.at(-2).content, 'Where is the exit?');
    assert.equal(context.messages.at(-1).role, 'user');
    assert.match(context.messages.at(-1).content, /Answer with ONLY a JSON object/);
    assert.match(context.prompt, /Where is the exit\?/);
    assert.match(context.prompt, /Find the exit/);
});

test('the writer context has no extra user turn: the last message is the history tail, so the writer answers the right line', () => {
    const context = buildWriterContext({
        blocks: [{ id: 'blk_goal', title: 'Goal', text: 'Find the exit.' }],
        summaries: [{ startIndex: 1, endIndex: 9, text: 'They arrived.' }],
        chat: [message('older'), message('Where is the exit?', { is_user: true })],
        decision: 'She points at the eastern door and starts walking.',
    });
    assert.equal(context.messages.at(-1).role, 'user');
    assert.equal(context.messages.at(-1).content, 'Where is the exit?');
    assert.equal(context.messages.filter(item => item.role === 'user').length, 1, 'no synthetic user turn after the real one');
    const system = context.messages.filter(item => item.role === 'system').map(item => item.content).join('\n');
    assert.match(system, /LONG-TERM SUMMARIES/);
    assert.match(system, /CHARACTER BLOCKS/);
    assert.match(system, /DECISION FOR THIS TURN/);
    assert.match(system, /eastern door/);
});

test('empty parts are omitted instead of producing empty system messages', () => {
    assert.equal(summariesSection([]), '');
    assert.equal(blocksSection([]), '');
    assert.equal(runsSection({}), '');
    const context = buildWriterContext({ chat: [message('hi', { is_user: true })], decision: '' });
    assert.equal(context.messages.filter(item => item.role === 'system').length, 1, 'only the writer role');
});

test('past runs are ordered by message number, not by object insertion order', () => {
    const section = runsSection({ 9: { mesid: '9', decision: 'later' }, 2: { mesid: '2', decision: 'earlier' } });
    assert.ok(section.indexOf('Turn #2') < section.indexOf('Turn #9'));
});
