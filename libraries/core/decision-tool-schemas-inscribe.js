import { COMMENT } from './decision-tool-comment.js';

/**
 * `inscribe` — шаблон хода резолвера. Один вызов на ход вместо цепочки
 * инструментов: ростер, каждый персонаж по пунктам, шаги для писателя, где
 * ход заканчивается. Планы, заметки и записи сняты с хода: их место в
 * «после хода» и в руках директора.
 */

export const CONFLICT_LEVELS = Object.freeze(['none', 'minor', 'strong']);

export const INSCRIBE_TOOL = Object.freeze({
    name: 'inscribe',
    displayName: 'Inscribe the turn',
    description: 'The mandatory template for this turn: the characters who act, from the inside, the beats for the Writer, and where the turn stops. Fill it once, in the order of the CoT. List only those who act this turn; everyone else here stays in the background on their own, and the engine keeps them there. Where there was a roll, cite the assess id in "assessId" and explain in "outcome" why it went that way; where there was no roll, leave assessId out. The engine repairs what it can and refuses only a turn without beats while someone acts.',
    parameters: {
        type: 'object',
        properties: {
            roster: {
                type: 'object',
                description: 'Who enters or leaves the scene this turn. Omit it when nobody does — someone gone in the previous ending and not in this turn leaves on their own.',
                properties: {
                    add: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name'] }, description: 'Characters entering the active scene.' },
                    remove: { type: 'array', items: { type: 'string' }, description: 'Characters leaving the active scene.' },
                },
            },
            characters: {
                type: 'array',
                description: 'Only the characters who act this turn, in the order of the CoT: heard → feels → next → does and says.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        heard: { type: 'string', description: 'What in the user\'s latest message — or in what just happened — matters to them, in one line. What is new in it for them.' },
                        feels: { type: 'string', description: 'What they feel now, from their Emotions and what they heard. A few words.' },
                        next: { type: 'string', description: 'Their next step toward their Decree\'s aim from where things stand now — never a step already in ALREADY SAID AND DONE or already taken. With no Decree yet, toward what their bank wants.' },
                        does: { type: 'string', description: 'What they do this turn, deeds only, in one line. The order of actions and lines goes in beats.' },
                        says: { type: 'string', description: 'What they say, in meaning only — never the wording: the Writer writes the words. Leave it out when they say nothing.' },
                        mode: { type: 'object', description: 'Only when THIS TURN asks for it: the fields it names, each as {"real": …, "lens": …}.' },
                        assessId: { type: 'string', description: 'Id returned by assess. Leave it out when no roll was needed.' },
                        outcome: { type: 'string', description: 'Why it succeeded or failed, written after the assess result is known.' },
                    },
                    required: ['name'],
                },
            },
            beats: {
                type: 'array',
                description: 'The turn as it happens, in order: every action and every line of the characters who act, each exactly once. The user\'s character gets no beats.',
                items: {
                    type: 'object',
                    properties: {
                        who: { type: 'string' },
                        kind: { type: 'string', enum: ['line', 'action'], description: 'line — they speak; action — what their body does.' },
                        text: { type: 'string', description: 'For a line: what the words mean, in direct form ("what were you two saying at the sill?") — never the wording, never "she asks…". For an action: what they do.' },
                    },
                    required: ['who', 'kind', 'text'],
                },
            },
            stop: { type: 'string', description: 'The last beat the turn ends on — the line or gesture after which the user would naturally react — in one sentence. Do not retell the other beats. Never describe anyone as waiting for the user: that pause is implied.' },
            userResult: { type: 'string', description: 'What the user did, as their own deed in their own terms, then the result of it: success or failure and why. It has happened — the others meet it; nobody does it for them or instead of them. Never decide the user\'s action itself, and do not finish a long action for them — show what has happened up to the moment someone reacts.' },
            scene: {
                type: 'object',
                description: 'Leave it out for a short exchange in the same place; set it when the scene takes longer or moves.',
                properties: {
                    duration: { type: 'string', description: 'How long the scene took, as one step of the scale: "a moment", "a few minutes", "a quarter hour", "half an hour", "an hour", "a few hours", "until dawn", "until morning", "until noon", "until evening", "until night", "until tomorrow". The engine counts the minutes.' },
                    place: { type: 'string', description: 'Optional; the engine fills it from the map when omitted.' },
                },
            },
            comment: COMMENT,
        },
        required: ['characters', 'beats', 'stop', 'comment'],
    },
});
