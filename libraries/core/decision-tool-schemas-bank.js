/**
 * Инструменты Great Bank — чистые данные: правка одним вызовом и уровень
 * важности. Ни модели, ни хранения: исполнение живёт в `handlers-bank.js`.
 */

import { COMMENT } from './decision-tool-comment.js';

export const BANK_EDIT_TOOL = Object.freeze({
    name: 'bank_edit',
    displayName: 'Edit the Great Bank',
    description: 'Change a character\'s Great Bank in one call, for one character or several. Sections: material 1 Appearance, 2 Property, 3 Life facts, 4 Carried items, 5 Clothing, 6 Abilities, 7 Other material facts; spiritual 1 Values, 2 Likes and dislikes, 3 Emotional display and public mood, 4 Needs and goals, 5 Speech and thinking patterns, 6 Resolving. Write the section by number, name or a close word: an uncertain section goes to Other facts of its part. "old" is the line as you remember it; the engine finds the closest line in that section (spacing, case and punctuation do not matter) and writes "new" in its place; when no line is close, "new" is appended. An empty "new" removes the line. The engine stamps the turn\'s RP time on each changed line. Give "for" or "until" in words ("an hour", "dawn", "tomorrow") when the line should expire; the engine turns it into an absolute deadline and marks it as past once it passes.',
    parameters: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        character: { type: 'string', description: 'Whose bank; a name or an alias, in any case.' },
                        section: { type: 'string', description: 'Section number, name or a close word, e.g. "material 6", "Abilities", "4", "Resolving".' },
                        old: { type: 'string', description: 'The line to change, as you remember it. Leave it out to add a new line.' },
                        new: { type: 'string', description: 'The new line. Empty removes the line.' },
                        for: { type: 'string', description: 'Optional: how long the line stays true, in words ("an hour", "three days").' },
                        until: { type: 'string', description: 'Optional: when the line stops being true, in words ("dawn", "tomorrow").' },
                    },
                    required: ['character', 'section'],
                },
            },
            comment: COMMENT,
        },
        required: ['edits', 'comment'],
    },
});

export const SET_ACQUAINTANCE_TOOL = Object.freeze({
    name: 'set_acquaintance',
    displayName: 'Record their past with the user',
    description: 'Record a character\'s past with the user\'s character, and the milestones between them. known_since: since when they have known each other before the story, in words ("since childhood", "for three years"); leave it out if they first meet in the story. time_together: roughly how much time they spent together before the story, in words. milestone: an event that changed what they are to each other — "when" in words for an event before the story; leave "when" out for an event of the story, and the engine dates it. The engine counts the time of the story itself.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string' },
            known_since: { type: 'string' },
            time_together: { type: 'string' },
            milestone: { type: 'object', properties: { when: { type: 'string' }, what: { type: 'string' } }, required: ['what'] },
            comment: COMMENT,
        },
        required: ['character', 'comment'],
    },
});

export const SET_BANK_IMPORTANCE_TOOL = Object.freeze({
    name: 'set_bank_importance',
    displayName: 'Set how important a character is',
    description: 'Set a character\'s place in the Great Bank: "main" (Main Cast), "side" (Side Character), "temporary" (Temporary Character) or "mass" (NPC/Mass). Main Cast gets Decrees first; NPC/Mass lives on the world\'s culture instead of a bank.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string' },
            importance: { type: 'string', enum: ['main', 'side', 'temporary', 'mass'] },
            comment: COMMENT,
        },
        required: ['character', 'importance', 'comment'],
    },
});
