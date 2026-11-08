import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDeciderContext, buildWriterContext, historyMessages, selectRecentChat,
    summariesSection, RECENT_MESSAGE_LIMIT,
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

test('the director context puts the protected part first, then the window, mutable changes, the plan at @2 and the task', () => {
    const context = buildDeciderContext({
        banksText: 'ALL-CHARACTER-BANKS',
        lorebookText: 'THE LOREBOOK',
        libraryText: 'CHARACTER LIBRARY',
        plansText: 'LONG PLANS',
        roster: ['Aria'],
        activeBanksText: 'ACTIVE-BANKS',
        windowEntries: [{ kind: 'turn', turn: 1, text: 'TURN 1 (compressed) — they left the keep.' }],
        plan: { direction: 'Find the way out.', stages: [], currentStage: 0 },
        arcs: [{ status: 'open', title: 'The escape' }],
        directorBlock: 'Never kill a named character.',
        notes: { aria: [{ id: 'n1', character: 'Aria', title: 'Goal', text: 'Find the exit.' }] },
        knowledgeText: 'WHAT CHARACTERS KNOW',
        summaries: [{ startIndex: 1, endIndex: 9, text: 'They arrived at the keep.' }],
        chat: [message('older'), message('Where is the exit?', { is_user: true })],
    });
    const contents = context.messages.map(item => item.content);
    assert.match(contents[0], /You are the Resolver of a living roleplay world/);
    assert.match(contents[1], /ALL-CHARACTER-BANKS/);
    assert.match(contents[2], /THE LOREBOOK/);
    assert.match(contents[3], /ARCS/);
    assert.match(contents[4], /CHARACTER LIBRARY/);
    assert.match(contents[5], /LONG PLANS/);
    assert.match(contents[6], /ACTIVE ROSTER/);
    assert.match(contents[7], /ACTIVE-BANKS/);
    assert.equal(contents[8], 'Never kill a named character.', 'the custom block sits inside the window history');
    assert.match(contents[9], /TURN 1 \(compressed\)/);
    assert.match(contents.at(-4), /WHAT CHARACTERS KNOW/);
    assert.match(contents.at(-3), /CHARACTER NOTES/);
    assert.match(contents.at(-2), /^YOUR PLAN/);
    assert.match(contents.at(-2), /Find the way out/);
    assert.match(contents.at(-1), /A new turn has started/);
    assert.equal(contents.some(item => /LONG-TERM SUMMARIES/.test(item)), false, 'summaries no longer reach the director');
    assert.match(context.prompt, /Find the exit/);
    assert.doesNotMatch(context.prompt, /LONG-TERM SUMMARIES/);
});

test('the writer context puts the push after the history, and the history tail stays the last story line', () => {
    const context = buildWriterContext({
        notes: { aria: [{ id: 'n1', character: 'Aria', title: 'Goal', text: 'Find the exit.' }] },
        summaries: [{ startIndex: 1, endIndex: 9, text: 'They arrived.' }],
        chat: [message('older'), message('Where is the exit?', { is_user: true })],
        decision: 'She points at the eastern door and starts walking.',
    });
    const story = context.messages.filter(item => item.role !== 'system');
    assert.equal(story.at(-1).role, 'user');
    assert.equal(story.at(-1).content, 'Where is the exit?', 'the last story line is still the user message');
    assert.ok(context.messages.slice(context.messages.lastIndexOf(story.at(-1)) + 1).every(item => item.role === 'system'), 'only the volatile notes and the push follow it');
    assert.equal(context.messages.filter(item => item.role === 'user').length, 1, 'no synthetic user turn after the real one');
    assert.equal(context.messages.at(-1).role, 'system');
    assert.match(context.messages.at(-1).content, /^INSCRIPTION — what happens this turn:/);
    const system = context.messages.filter(item => item.role === 'system').map(item => item.content).join('\n');
    assert.match(system, /LONG-TERM SUMMARIES/);
    assert.match(system, /CHARACTER NOTES/);
    assert.match(system, /Find the exit/);
    assert.doesNotMatch(context.messages[0].content, /INSCRIPTION — what happens this turn/, 'the push is not in the system preface');
    assert.match(context.messages.at(-1).content, /eastern door/);
});

test('empty parts are omitted instead of producing empty system messages', () => {
    assert.equal(summariesSection([]), '');
    const context = buildWriterContext({ chat: [message('hi', { is_user: true })], decision: '' });
    assert.equal(context.messages.filter(item => item.role === 'system').length, 1, 'only the writer role');
});

test('the writer context puts example dialogues first, then all active banks, then summaries and notes', () => {
    const context = buildWriterContext({
        chat: [], decision: 'push', examples: 'EXAMPLE-DIALOGUES', banksText: 'ACTIVE-BANKS',
        summaries: [{ startIndex: 1, endIndex: 2, text: 'SUMMARY-TEXT' }], notes: { lena: [{ title: 'Door', text: 'NOTE-TEXT' }] },
    });
    const text = context.messages.map(message => message.content).join('\n');
    assert.ok(text.indexOf('EXAMPLE-DIALOGUES') < text.indexOf('ACTIVE-BANKS'));
    assert.ok(text.indexOf('ACTIVE-BANKS') < text.indexOf('SUMMARY-TEXT'));
    assert.ok(text.indexOf('SUMMARY-TEXT') < text.indexOf('NOTE-TEXT'));
});

test('the director context carries all banks in the stable part', () => {
    const context = buildDeciderContext({ banksText: 'ALL-CHARACTER-BANKS' });
    assert.match(context.messages.map(message => message.content).join('\n'), /ALL-CHARACTER-BANKS/);
});

test('the writer keeps only rarely changing parts before its sliding history; lorebook matches and notes come after it, before the push', () => {
    const chat = [{ mes: 'Hello', is_user: true }, { mes: 'Hi.' }];
    const { messages } = buildWriterContext({
        chat, decision: 'Lena opens the door.', banksText: 'BANKS', examples: 'EXAMPLES', lorebookText: 'LORE MATCH',
        summaries: [{ id: 's1', text: 'Earlier things.', level: 1 }], notes: { Lena: [{ id: 'n1', title: 'Wound', text: 'Left arm.' }] },
    });
    const at = needle => messages.findIndex(message => String(message.content).includes(needle));
    const firstHistory = messages.findIndex(message => message.role === 'user' || message.role === 'assistant');
    assert.ok(at('BANKS') < firstHistory && at('EXAMPLES') < firstHistory, 'stable parts stay in the cacheable prefix');
    assert.ok(at('LORE MATCH') > firstHistory, 'keyword lorebook matches change every turn, so they come after the history');
    assert.ok(at('Left arm') > firstHistory, 'notes change every turn, so they come after the history');
    assert.ok(at('Lena opens the door') > at('LORE MATCH') && at('Lena opens the door') > at('Left arm'), 'the push stays last');
    assert.equal(at('Lena opens the door'), messages.length - 1);
});

test('the frozen lorebook is the whole book in the protected part, with no changes block', () => {
    const { messages } = buildDeciderContext({
        lorebookText: 'THE LOREBOOK frozen', lorebookChanges: 'LOREBOOK CHANGES new entry',
        windowEntries: [{ kind: 'turn', turn: 2, text: 'TURN 2 (compressed)' }],
        plan: { direction: 'p' },
    });
    const at = needle => messages.findIndex(message => String(message.content).includes(needle));
    assert.ok(at('THE LOREBOOK frozen') < at('TURN 2 (compressed)'));
    assert.equal(at('LOREBOOK CHANGES'), -1);
});
