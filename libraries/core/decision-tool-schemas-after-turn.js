import { COMMENT } from './decision-tool-comment.js';

/**
 * `after_turn` — шаблон резолвера после ответа писателя. Исход хода пишется
 * по тому, что реально случилось на странице, изменения — по фактам, Молитва
 * и Телеграмма — только когда есть повод из закрытого списка.
 */

export const TELEGRAM_REASONS = Object.freeze([
    'a death or an irreversible loss',
    "the user's act breaks the Decree outright — a betrayal, a revelation, an attack on someone close",
    'a character leaves the story for good',
]);

const BANK_EDIT = {
    type: 'object',
    properties: {
        character: { type: 'string', description: 'Whose bank; a name or an alias, in any case.' },
        section: { type: 'string', description: 'Section number or name, e.g. "material 4", "Appearance", "knowledge".' },
        old: { type: 'string', description: 'The line to change, as you remember it. Leave it out to add a new line.' },
        new: { type: 'string', description: 'The new line. Empty removes the line.' },
        for: { type: 'string', description: 'Optional: how long the line stays true, in words ("an hour", "three days").' },
        until: { type: 'string', description: 'Optional: when the line stops being true, in words ("dawn", "tomorrow").' },
    },
    required: ['character', 'section'],
};

export const AFTER_TURN_TOOL = Object.freeze({
    name: 'after_turn',
    displayName: 'Record what the turn left behind',
    description: 'The template after the Writer has finished, filled from the reply itself. outcome — what actually came of each character\'s action on the page. bankEdits — the physical changes and what they learned, in the same shape as bank_edit; you may change the Material sections and Knowledge, and a spiritual edit is kept as a proposal for the Director. prayer — only when the world\'s systems were used against their rules. telegram — only for something on the closed list: a death or an irreversible loss; the user\'s act breaks the Decree outright; a character leaves the story for good. Leave out what did not happen; one call ends the work.',
    parameters: {
        type: 'object',
        properties: {
            outcome: {
                type: 'array',
                description: 'What the page left each acting character with. One entry per character who acted.',
                items: {
                    type: 'object',
                    properties: {
                        character: { type: 'string' },
                        result: { type: 'string', description: 'What actually came of their action on the page, in one line.' },
                    },
                    required: ['character', 'result'],
                },
            },
            bankEdits: { type: 'array', items: BANK_EDIT, description: 'Physical changes and knowledge, in the shape of bank_edit.' },
            prayer: { type: 'string', description: 'Only when the world\'s systems were used outside their rules: which rule, what was done, what came of it.' },
            telegram: { type: 'string', description: 'Only for the closed list of urgent matters: a death or an irreversible loss; the user\'s act breaks the Decree outright; a character leaves the story for good. One line.' },
            comment: COMMENT,
        },
        required: ['comment'],
    },
});
