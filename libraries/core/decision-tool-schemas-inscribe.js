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
    description: 'The mandatory template for this turn: the roster, every active character from the inside, the beats for the Writer, and where the turn stops. Fill it once, in the order of the CoT. Every active roster member appears exactly once; a member with nothing to do is listed with only the name and "idle": true. Where there was a roll, cite the assess id in "assessId" and explain in "outcome" why it went that way; where there was no roll, leave assessId out. The engine repairs what it can and refuses only a turn without beats while someone acts.',
    parameters: {
        type: 'object',
        properties: {
            roster: {
                type: 'object',
                description: 'Who enters or leaves the active scene this turn. Omit it when nobody does.',
                properties: {
                    add: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name'] }, description: 'Characters entering the active scene.' },
                    remove: { type: 'array', items: { type: 'string' }, description: 'Characters leaving the active scene.' },
                },
            },
            characters: {
                type: 'array',
                description: 'Every active character, in the order of the CoT: feels → what the Decree wants → conflict → does and says.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        idle: { type: 'boolean', description: 'True when the character is present but does nothing worth showing this turn. Then only the name and busy are needed.' },
                        busy: { type: 'string', description: 'For an idle character: what occupies them right now — their own concern, from their bank or Decree. A few words.' },
                        feels: { type: 'string', description: 'What they feel right now and why — from their Emotions and what just happened.' },
                        decreeWants: { type: 'string', description: 'What their Decree wants from them in this moment: its goal for today and its rules of resolving. With no Decree yet, what their bank and situation want.' },
                        conflict: {
                            type: 'object',
                            description: 'How far the Decree pulls against what the character would do on their own.',
                            properties: {
                                level: { type: 'string', enum: CONFLICT_LEVELS, description: 'none — no tension; minor — a hesitation or a cost; strong — they act against themselves.' },
                                why: { type: 'string', description: 'What pulls where, in one line. Required for minor and strong.' },
                            },
                            required: ['level'],
                        },
                        does: { type: 'string', description: 'What they do this turn, deeds only, in one line. The order of actions and lines goes in beats.' },
                        says: { type: 'string', description: 'What they say, in meaning only — never the wording: the Writer writes the words. Leave it out when they say nothing.' },
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
            userResult: { type: 'string', description: 'The result of the user\'s attempt only: success or failure and why. Never decide the user\'s action itself, and do not finish a long action for them — show what has happened up to the moment someone reacts.' },
            scene: {
                type: 'object',
                properties: {
                    duration: { type: 'string', description: 'How long the scene took, as one step of the scale: "a moment", "a few minutes", "a quarter hour", "half an hour", "an hour", "a few hours", "until dawn", "until morning", "until noon", "until evening", "until night", "until tomorrow". The engine counts the minutes.' },
                    place: { type: 'string', description: 'Optional; the engine fills it from the map when omitted.' },
                },
                required: ['duration'],
            },
            comment: COMMENT,
        },
        required: ['characters', 'beats', 'stop', 'scene', 'comment'],
    },
});
