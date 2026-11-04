import { COMMENT } from './decision-tool-comment.js';
import { ASK_USER_DESCRIPTION, WRITE_CHAT_BRIEF_DESCRIPTION, BANK_GUIDE_DESCRIPTION } from './decision-prompts.js';

/** Инструменты bootstrap — `PROMPTS.md`, раздел 16. */
export const ASK_USER_TOOL = Object.freeze({
    name: 'ask_user',
    displayName: 'Ask the user',
    description: ASK_USER_DESCRIPTION,
    parameters: {
        type: 'object',
        properties: {
            question: { type: 'string', description: 'The question, concrete and answerable from the material.' },
            options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Two to four concrete options.' },
            why: { type: 'string', description: 'One phrase: what depends on the answer.' },
            comment: COMMENT,
        },
        required: ['question', 'options', 'comment'],
    },
});

export const WRITE_CHAT_BRIEF_TOOL = Object.freeze({
    name: 'write_chat_brief',
    displayName: 'Write the chat brief',
    description: WRITE_CHAT_BRIEF_DESCRIPTION,
    parameters: {
        type: 'object',
        properties: {
            brief: { type: 'string', description: 'The brief in sections TIMELINE, WORLD AT THE START, WHO KNOWS WHOM, DIFFERENCES FROM CANON, ASSUMPTIONS.' },
            bankGuide: { type: 'string', description: BANK_GUIDE_DESCRIPTION },
            timelineBanks: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, note: { type: 'string' } },
                    required: ['name'],
                },
                description: 'Every character whose data bank depends on the point of the timeline, and what must change.',
            },
            comment: COMMENT,
        },
        required: ['brief', 'comment'],
    },
});
