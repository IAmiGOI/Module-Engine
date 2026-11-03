import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBriefSection, normalizeBrief, renderChatBrief } from '../libraries/core/decision-brief.js';
import { buildDeciderContext } from '../libraries/core/decision-context.js';
import { compareRequests } from '../libraries/core/decision-cache.js';

const BRIEF = {
    text: 'TIMELINE:\nThe story starts before the war.\n\nWORLD AT THE START:\nThe port is quiet.\n\nASSUMPTIONS:\n- The user arrived yesterday.',
    timelineBanks: [{ name: 'Emilia', note: 'Has not met Subaru yet.' }],
};

test('the TIMELINE section is extracted from the brief', () => {
    assert.equal(extractBriefSection(BRIEF.text, 'TIMELINE'), 'The story starts before the war.');
    assert.equal(extractBriefSection(BRIEF.text, 'ASSUMPTIONS'), '- The user arrived yesterday.');
    assert.equal(extractBriefSection(BRIEF.text, 'WHO KNOWS WHOM'), '');
});

test('normalizeBrief derives the timeline and keeps timelineBanks; render puts the header on it', () => {
    const brief = normalizeBrief({ text: BRIEF.text, timelineBanks: BRIEF.timelineBanks, at: 5 });
    assert.equal(brief.timeline, 'The story starts before the war.');
    assert.deepEqual(brief.timelineBanks, BRIEF.timelineBanks);
    assert.match(renderChatBrief(brief), /^CHAT BRIEF:\n\nTIMELINE:/);
});

test('CHAT BRIEF sits in the protected part after the lorebook and arcs, before the library', () => {
    const built = buildDeciderContext({
        banksText: 'BANKS', lorebookText: 'LORE', arcs: [{ status: 'open', title: 'The Escape' }],
        chatBriefText: renderChatBrief(BRIEF), libraryText: 'LIBRARY', plan: { direction: 'p' },
    });
    const at = needle => built.messages.findIndex(message => String(message.content).includes(needle));
    assert.ok(at('LORE') < at('ARCS'));
    assert.ok(at('ARCS') < at('CHAT BRIEF'));
    assert.ok(at('CHAT BRIEF') < at('LIBRARY'));
});

test('the protected part including CHAT BRIEF is byte-identical between turns', () => {
    const make = extra => buildDeciderContext({
        banksText: 'BANKS', lorebookText: 'LORE', arcs: [{ status: 'open', title: 'The Escape' }],
        chatBriefText: renderChatBrief(BRIEF), libraryText: 'LIBRARY', plan: { direction: 'p' },
        windowEntries: [{ kind: 'turn', turn: 1, text: 'TURN 1' }], ...extra,
    });
    const comparison = compareRequests(make({ task: 'first' }).messages, make({ task: 'second' }).messages);
    assert.equal(comparison.sharedMessages, make({}).messages.length - 1, 'only the task differs at the end');
});
