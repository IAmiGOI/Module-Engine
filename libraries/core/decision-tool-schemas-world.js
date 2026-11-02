import { COMMENT } from './decision-tool-comment.js';

/**
 * Схемы мира: библиотека персонажей, банк памяти, Forced Memory, имена,
 * субагент, лорбук, заготовка и await. Только данные.
 */

export const SET_CHARACTER_LEVEL_TOOL = Object.freeze({
    name: 'set_character_level',
    displayName: 'Set a character level',
    description: 'Put a character into the library with a level 1–5. Level 1 plans last 3–12 hours, level 2 several days, level 3 a detailed plan with no special details, level 4 has no plans, level 5 exists only while the character is in the active roster.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string' },
            level: { type: 'number', description: '1–5.' },
            comment: COMMENT,
        },
        required: ['character', 'level', 'comment'],
    },
});

export const SET_CHARACTER_PLAN_TOOL = Object.freeze({
    name: 'set_character_plan',
    displayName: 'Set a character plan',
    description: 'Give a library character a plan. Outside the active roster the plan runs for the level\'s duration; inside the roster it is interrupted and approximate, with no due time. Level 4 takes no plans.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string' },
            summary: { type: 'string', description: 'What the character is doing and heading toward.' },
            steps: { type: 'array', items: { type: 'string' } },
            durationMinutes: { type: 'number', description: 'For a timed plan: level 1 180–720, level 2 1440–10080, level 3 720–4320.' },
            comment: COMMENT,
        },
        required: ['character', 'summary', 'comment'],
    },
});

export const RESOLVE_CHARACTER_PLAN_TOOL = Object.freeze({
    name: 'resolve_character_plan',
    displayName: 'Resolve a finished plan',
    description: 'When a plan ends by RP time, write what came of it, mark it resolved and (optionally) give the next plan. The result goes into the memory bank; mark it "important" if it must never be compressed.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string' },
            result: { type: 'string', description: 'What actually came of the plan.' },
            important: { type: 'boolean', description: 'Never compress this record.' },
            nextSummary: { type: 'string', description: 'Optional next plan.' },
            nextSteps: { type: 'array', items: { type: 'string' } },
            nextDurationMinutes: { type: 'number' },
            comment: COMMENT,
        },
        required: ['character', 'result', 'comment'],
    },
});

export const LIBRARY_TOOL = Object.freeze({
    name: 'library',
    displayName: 'Read the character library',
    description: 'Read the library: levels, notes and current plans of characters. Read-only.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string', description: 'Optional: one character instead of the whole library.' },
            comment: COMMENT,
        },
        required: ['comment'],
    },
});

export const FORCED_MEMORY_TOOL = Object.freeze({
    name: 'forced_memory',
    displayName: 'Keep or release a summary',
    description: 'Mark a summary so it is never folded into a higher level, or release it again. Without a mark the summary folds as usual.',
    parameters: {
        type: 'object',
        properties: {
            op: { type: 'string', enum: ['keep', 'unkeep', 'list'] },
            summaryId: { type: 'string', description: 'Summary id for keep/unkeep.' },
            comment: COMMENT,
        },
        required: ['op', 'comment'],
    },
});

export const RECALL_NAME_TOOL = Object.freeze({
    name: 'recall_name',
    displayName: 'Issue an unused name',
    description: 'Take a name from the built-in name library so names never repeat in this chat. Give gender, culture (germany, poland, czech, latvia, china, japan) and setting (modern, fictional). Returns the name and surname; if the list is exhausted, an honest refusal.',
    parameters: {
        type: 'object',
        properties: {
            gender: { type: 'string', enum: ['male', 'female'] },
            culture: { type: 'string', enum: ['germany', 'poland', 'czech', 'latvia', 'china', 'japan'] },
            setting: { type: 'string', enum: ['modern', 'fictional'] },
            comment: COMMENT,
        },
        required: ['gender', 'culture', 'setting', 'comment'],
    },
});

export const SPAWN_RESEARCHER_TOOL = Object.freeze({
    name: 'spawn_researcher',
    displayName: 'Start a web researcher',
    description: 'Start a background researcher with its own model and web search. It reports later, into your log; you are forbidden to wait for it. At most two tasks run at once — a third is refused, not queued.',
    parameters: {
        type: 'object',
        properties: {
            task: { type: 'string', description: 'What to find out, and for what purpose.' },
            comment: COMMENT,
        },
        required: ['task', 'comment'],
    },
});

export const MEMORY_TOOL = Object.freeze({
    name: 'memory',
    displayName: 'Read or write the memory bank',
    description: 'The memory bank holds the results of character plans. Only its index is in your context; search it here. "important" records are never compressed, so mark promises, betrayals and lasting rules.',
    parameters: {
        type: 'object',
        properties: {
            op: { type: 'string', enum: ['search', 'read', 'write'] },
            character: { type: 'string' },
            query: { type: 'string', description: 'Words to look for in the records.' },
            text: { type: 'string', description: 'For write: the new record.' },
            important: { type: 'boolean', description: 'For write: never compress this record.' },
            limit: { type: 'number', description: 'How many records to return (default 10).' },
            comment: COMMENT,
        },
        required: ['op', 'comment'],
    },
});

export const LOREBOOK_TOOL = Object.freeze({
    name: 'lorebook',
    displayName: 'Search or read the lorebook',
    description: 'Search the connected lorebook for a fact (op "search" with "query"), or read one entry (op "read" with "uid" and "book"). Always-on entries are already in your context; this tool finds the rest. The Writer never sees the lorebook.',
    parameters: {
        type: 'object',
        properties: {
            op: { type: 'string', enum: ['search', 'read'] },
            query: { type: 'string', description: 'For search: what to look for.' },
            uid: { type: 'number', description: 'For read: the entry uid.' },
            book: { type: 'string', description: 'Optional book name.' },
            limit: { type: 'number', description: 'How many entries to return (default 8).' },
            comment: COMMENT,
        },
        required: ['op', 'comment'],
    },
});


export const CHARACTER_BANK_TOOL = Object.freeze({
    name: 'character_bank',
    displayName: 'Read, edit or rebuild a character bank',
    description: 'A character bank is the compact card the Writer and the Director read. Read it before writing a character into a scene, edit it when the story changes something lasting, or rebuild it from its source with the subagent.',
    parameters: {
        type: 'object',
        properties: {
            op: { type: 'string', enum: ['read', 'write', 'rebuild'] },
            character: { type: 'string', description: 'Whose bank.' },
            text: { type: 'string', description: 'For write: the full new bank text.' },
            comment: COMMENT,
        },
        required: ['op', 'character', 'comment'],
    },
});

export const SAVE_DRAFT_TOOL = Object.freeze({
    name: 'save_draft',
    displayName: 'Save a draft turn',
    description: 'Prepare a draft of the likely next turn without submitting it. If the real turn times out, the writer can use this draft instead of cancelling. Only available when turn drafting is on.',
    parameters: {
        type: 'object',
        properties: {
            draft: {
                type: 'object',
                properties: {
                    scene: { type: 'object', properties: { minutes: { type: 'number' } } },
                    resolution: { type: 'string' },
                    userResult: { type: 'string' },
                    characters: { type: 'array', items: { type: 'object' } },
                },
            },
            comment: COMMENT,
        },
        required: ['draft', 'comment'],
    },
});

export const AWAIT_TOOL = Object.freeze({
    name: 'await',
    displayName: 'Await an event',
    description: 'End this cycle and sleep until an event wakes you: the next turn, a plan ending by RP time, a roster change, or a researcher report. Nothing happens between cycles.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'What you are waiting for.' },
            wakeOn: { type: 'string', enum: ['turn', 'time', 'roster', 'researcher', 'any'], description: 'Which event should wake you; "any" by default.' },
            comment: COMMENT,
        },
        required: ['reason', 'comment'],
    },
});
