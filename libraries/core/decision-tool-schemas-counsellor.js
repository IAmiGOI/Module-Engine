import { COMMENT } from './decision-tool-comment.js';
import { PROMOTE_LEVELS } from './decision-counsellor.js';

/**
 * Инструменты Советника: Petition директору, Prayer Богу, ответ пользователю
 * и «важного нет». Только данные — исполнение в `cores/decision/counsellor.js`.
 */

export const PETITION_TOOL = Object.freeze({
    name: 'petition',
    displayName: 'Petition the Director',
    description: 'Tell the Director that the Decree no longer covers what a character ran into. One call per character with a real problem. Give the problem in one or two sentences and the Ledger rows that show it, lightly trimmed. Add promote only when the character\'s standing must change.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string', description: 'The character\'s name exactly as the Ledger and the bank write it.' },
            problem: { type: 'string', description: 'What the Decree no longer covers, from what the character faced.' },
            excerpt: { type: 'string', description: 'The Ledger rows that show the problem, lightly trimmed — never a rewritten summary.' },
            promote: {
                type: 'object',
                description: 'Only when the standing must change: the new level and the reason.',
                properties: {
                    level: { type: 'string', enum: PROMOTE_LEVELS, description: 'main (Main Cast), side (Side Character), temporary (Temporary Character) or mass (NPC/Mass).' },
                    reason: { type: 'string', description: 'Why the standing changes now.' },
                },
                required: ['level', 'reason'],
            },
            comment: COMMENT,
        },
        required: ['character', 'problem', 'comment'],
    },
});

export const NOTHING_YET_TOOL = Object.freeze({
    name: 'nothing_yet',
    displayName: 'Nothing needs the Director',
    description: 'The Ledger holds nothing that the Decree cannot cover. Say in reason what you weighed and why none of it is a reason. This ends the review.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'Why nothing in the Ledger needs the Director.' },
            comment: COMMENT,
        },
        required: ['reason', 'comment'],
    },
});

export const REPLY_TOOL = Object.freeze({
    name: 'reply',
    displayName: 'Answer the user',
    description: 'Your answer to the user, outside the story: plainly, in the user\'s language, as the world\'s own voice. Say what you will pass on, or why you will not. The user never sees the Ledger or the queues.',
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'The answer to the user, one to three sentences.' },
            comment: COMMENT,
        },
        required: ['text', 'comment'],
    },
});

export const PRAYER_TOOL = Object.freeze({
    name: 'prayer',
    displayName: 'Pray to God',
    description: 'Pass a matter about the world\'s rules to God: how a system of the world was used outside its rules, or what the user asks about the world itself. One line: which rule, what was done, what came of it.',
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Which rule, what was done, what came of it.' },
            comment: COMMENT,
        },
        required: ['text', 'comment'],
    },
});

export const COUNSELLOR_AWAIT_TOOL = Object.freeze({
    name: 'await',
    displayName: 'Finish the review',
    description: 'End the review. Call it after the Petitions, or after the reply to the user.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: 'What you are waiting for.' },
            comment: COMMENT,
        },
        required: ['reason', 'comment'],
    },
});

export const COUNSELLOR_TOOLS = Object.freeze([PETITION_TOOL, NOTHING_YET_TOOL, REPLY_TOOL, PRAYER_TOOL, COUNSELLOR_AWAIT_TOOL]);

/** Советнику нужен только `nothing_yet` как конец разбора; остальное — по желанию. */
export const COUNSELLOR_STOP_TOOLS = Object.freeze(['nothing_yet']);
