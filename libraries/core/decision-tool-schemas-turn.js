import { COMMENT } from './decision-tool-comment.js';
import { DIFFICULTY_LEVELS, EXPERIENCE_LEVELS } from './decision-probability.js';

/**
 * Схемы хода: ростер, оценка, форма, план, заметки, арки и текущее
 * состояние. Только данные — исполнение в cores/decision/handlers.js.
 */

export const UPDATE_ROSTER_TOOL = Object.freeze({
    name: 'update_roster',
    displayName: 'Update roster',
    description: 'Mark who is active — everyone who can directly affect the current situation. Call it when someone appears or leaves the active scene, not every turn. The roster is ready before the turn starts.',
    parameters: {
        type: 'object',
        properties: {
            add: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name'] }, description: 'Characters entering the active scene.' },
            remove: { type: 'array', items: { type: 'string' }, description: 'Characters leaving the active scene.' },
            comment: COMMENT,
        },
        required: ['comment'],
    },
});

export const ASSESS_TOOL = Object.freeze({
    name: 'assess',
    displayName: 'Assess an action',
    description: 'Ask the engine for the chance that a character can carry out an attempt that may fail. Pick a difficulty level and an experience level from the lists and explain the circumstances in "why". The engine rolls and returns a degree; you never choose the result yourself. Call it BEFORE submit_turn and cite the returned id there.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string', description: 'Who is attempting it.' },
            action: { type: 'string', description: 'What exactly they are trying to do.' },
            kind: { type: 'string', enum: ['body', 'stealth', 'perception', 'craft', 'magic', 'social'], description: 'What sort of attempt it is. Talk (persuading, lying, pressing, asking) is "social" and is never rolled — you decide it.' },
            difficulty: { type: 'string', enum: DIFFICULTY_LEVELS, description: 'The task in its real circumstances: opposition, terrain, time pressure, injuries, tools, distractions.' },
            experience: { type: 'string', enum: EXPERIENCE_LEVELS, description: 'This character\'s skill at this exact task, not their general competence or importance.' },
            why: { type: 'string', description: 'The circumstances of the attempt in a sentence or two. The levels decide the chance; "why" explains it.' },
            comment: COMMENT,
        },
        required: ['character', 'action', 'kind', 'difficulty', 'experience', 'why', 'comment'],
    },
});

export const SUBMIT_TURN_TOOL = Object.freeze({
    name: 'submit_turn',
    displayName: 'Submit the turn',
    description: 'The mandatory form for this turn. Every active roster member must appear exactly once; a member who does nothing worth showing this turn is listed with only the name and "idle": true. Every listed assess id must exist. Where there was no roll, leave assessId out and say in "noCheck" why none was needed. Without a valid form the writer does not write. If the engine returns "missing", fix those fields and call again.',
    parameters: {
        type: 'object',
        properties: {
            scene: {
                type: 'object',
                properties: {
                    minutes: { type: 'number', description: 'How long this scene took, in minutes (0–1440).' },
                    place: { type: 'string', description: 'Optional; the engine fills it from the map when omitted.' },
                },
                required: ['minutes'],
            },
            resolution: { type: 'string', description: 'How this turn ends — the concrete outcome of this scene.' },
            userResult: { type: 'string', description: 'The result of the user action only: success or failure and why. Never decide the user action itself.' },
            characters: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        idle: { type: 'boolean', description: 'True when the character is present but does nothing worth showing this turn. Then only the name is needed, and the writer keeps them in the background.' },
                        decision: { type: 'string', description: 'What they do overall. Persists between turns.' },
                        decisionReason: { type: 'string' },
                        action: { type: 'string', description: 'What they do in this turn, and what they say in substance — the meaning, never the wording: the Writer writes the words.' },
                        actionReason: { type: 'string' },
                        assessId: { type: 'string', description: 'Id returned by assess. Leave it out when no roll was needed.' },
                        noCheck: { type: 'string', description: 'Why no roll was needed, when assessId is absent: a decision, a reaction, agreeing or refusing, staying put.' },
                        outcome: { type: 'string', description: 'Why it succeeded or failed, written after the assess result is known.' },
                    },
                    required: ['name'],
                },
            },
            comment: COMMENT,
        },
        required: ['scene', 'resolution', 'userResult', 'characters', 'comment'],
    },
});

export const SET_PLAN_TOOL = Object.freeze({
    name: 'set_plan',
    displayName: 'Set the director plan',
    description: 'Keep your own direction for future events around the user. A plan always exists: if you have none, create it before submit_turn. It is a direction, not a fixed sequence, and may change freely when the story turns.',
    parameters: {
        type: 'object',
        properties: {
            direction: { type: 'string', description: 'Where the story is heading and what you want to put in the user\'s way.' },
            stages: { type: 'array', items: { type: 'string' }, description: 'Loose stages; not a mandatory script.' },
            currentStage: { type: 'number', description: 'Index of the current stage (0-based).' },
            comment: COMMENT,
        },
        required: ['direction', 'comment'],
    },
});

export const CHARACTER_NOTE_TOOL = Object.freeze({
    name: 'character_note',
    displayName: 'Edit a character note',
    description: 'Keep at most four short notes per character: what the Writer must know about them right now. A fifth note replaces the one updated longest ago; a note with the same title is updated, not doubled. Old Notebook notes are not touched.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string' },
            op: { type: 'string', enum: ['add', 'set', 'remove'] },
            id: { type: 'string', description: 'Existing note id for set/remove.' },
            title: { type: 'string' },
            text: { type: 'string' },
            comment: COMMENT,
        },
        required: ['character', 'op', 'comment'],
    },
});

export const ARC_TOOL = Object.freeze({
    name: 'arc',
    displayName: 'Open, stage or close an arc',
    description: 'Track the long arcs of the story. Open one when it starts, add RP-time stages as they pass, close it when it is resolved. A closed arc is not reopened.',
    parameters: {
        type: 'object',
        properties: {
            op: { type: 'string', enum: ['open', 'stage', 'close'] },
            id: { type: 'string', description: 'Arc id for stage/close.' },
            title: { type: 'string', description: 'Arc title for open.' },
            note: { type: 'string', description: 'Stage note.' },
            comment: COMMENT,
        },
        required: ['op', 'comment'],
    },
});

export const CURRENT_STATE_TOOL = Object.freeze({
    name: 'current_state',
    displayName: 'Read the current state',
    description: 'Read where the scene is, the current RP time, the plan stage and the open arc. Read-only: it never invents a source. If the map or RP Time has no value, it says so.',
    parameters: {
        type: 'object',
        properties: { comment: COMMENT },
        required: ['comment'],
    },
});
