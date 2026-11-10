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
    description: 'Ask the engine for the chance that a character can carry out an attempt that may fail. Pick a difficulty level and an experience level from the lists and explain the circumstances in "why". The engine rolls and returns a degree; you never choose the result yourself. Call it before inscribe and cite the returned id there.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string', description: 'Who is attempting it.' },
            action: { type: 'string', description: 'What exactly they are trying to do.' },
            kind: { type: 'string', enum: ['body', 'stealth', 'perception', 'craft', 'magic', 'social'], description: 'What sort of attempt it is. Talk (persuading, lying, pressing, asking) is "social" and is never rolled — you decide it.' },
            difficulty: { type: 'string', enum: DIFFICULTY_LEVELS, description: 'The task in its real circumstances: opposition, terrain, time pressure, injuries, tools, distractions.' },
            experience: { type: 'string', enum: EXPERIENCE_LEVELS, description: 'This character\'s skill at this exact task, not their general competence or importance — from their data bank and history, never raised by a success earlier in this scene.' },
            rule: { type: 'string', description: 'For an attempt through a power of the world — every magic one: the rule of the Creation it uses, as "System / Rule" — the rule whose Needs the method meets, not the nearest by name: a technique the character builds from their own understanding goes under the rule for freeform working. With a rule, "difficulty" is the level the rule\'s weight gives for this kind of working — one of the levels its weight names; the engine adds the steps.' },
            method: { type: 'string', description: 'When the user\'s own character attempts it: how they do it, copied word for word from the user\'s latest message. The engine compares it with the rule\'s Needs.' },
            needs: { type: 'string', description: 'With "rule": the part of the rule\'s Needs the character and their method meet, in the rule\'s words.' },
            yields: { type: 'string', description: 'With "rule": the part of the rule\'s Yields that the aim of the attempt is, in the rule\'s words. A success gives only what Yields and the Scaling for their experience allow, within Limit.' },
            size: { type: 'string', enum: ['small', 'medium', 'heavy'], description: 'For a magic attempt: how much is put into it. small — a thin, light working (a probe, a spark, a touch of shaping); medium; heavy — a great working that draws hard on the caster. A failure costs only in proportion: a small one at worst does not work.' },
            rises: { type: 'array', items: { type: 'string' }, description: 'With "rule": each thing that makes it harder, one step up each — "rule: …" for a condition the rule\'s own rises list, "scene: …" for an obstacle already established in the scene. Nothing else counts; the character\'s own traits are their experience.' },
            falls: { type: 'array', items: { type: 'string' }, description: 'With "rule": each thing that makes it easier, one step down each — "rule: …" for a condition the rule\'s own falls list, "scene: …" for help already established in the scene. Nothing else counts; the character\'s own traits are their experience.' },
            why: { type: 'string', description: 'The circumstances of the attempt in a sentence or two. The levels decide the chance; "why" explains it.' },
            comment: COMMENT,
        },
        required: ['character', 'action', 'kind', 'difficulty', 'experience', 'why', 'comment'],
    },
});

export const SET_PLAN_TOOL = Object.freeze({
    name: 'set_plan',
    displayName: 'Set the director plan',
    description: 'Keep your own direction for future events around the user. A plan always exists: if you have none, create it in a background cycle. It is a direction, not a fixed sequence, and may change freely when the story turns.',
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

const STORY_KNOWLEDGE = {
    type: 'object',
    properties: {
        op: { type: 'string', enum: ['add', 'update', 'revise', 'forget'] },
        character: { type: 'string' },
        fact: { type: 'string' },
        source: { type: 'string', enum: ['saw', 'heard', 'told', 'read', 'worked out'] },
        from: { type: 'string' },
        id: { type: 'string', description: 'For update, revise and forget: the knowledge id.' },
    },
    required: ['op', 'character'],
};
const STORY_NOTE = {
    type: 'object',
    properties: {
        character: { type: 'string' },
        op: { type: 'string', enum: ['add', 'set', 'remove'] },
        id: { type: 'string' },
        title: { type: 'string' },
        text: { type: 'string' },
    },
    required: ['character', 'op'],
};
const STORY_CHARACTER_PLAN = {
    type: 'object',
    properties: {
        character: { type: 'string' },
        summary: { type: 'string', description: 'What the character is doing and heading toward.' },
        steps: { type: 'array', items: { type: 'string' } },
        durationMinutes: { type: 'number' },
    },
    required: ['character', 'summary'],
};

/** Все записи хода одним вызовом: знания, заметки, планы персонажей и план директора. Вместо цепочки отдельных вызовов. */
export const UPDATE_STORY_TOOL = Object.freeze({
    name: 'update_story',
    displayName: 'Record what the turn changed',
    description: 'Record everything this turn changed in ONE call: what characters learned (knowledge — same ops as character_knowledge), the notes it made wrong (notes — same ops as character_note), character plans it changed (characterPlans — same as set_character_plan), and your own plan if it changed (plan — same as set_plan). Leave out a list that has nothing; leave out what is still true. After the turn this call ends the cycle.',
    parameters: {
        type: 'object',
        properties: {
            knowledge: { type: 'array', items: STORY_KNOWLEDGE },
            notes: { type: 'array', items: STORY_NOTE },
            characterPlans: { type: 'array', items: STORY_CHARACTER_PLAN },
            plan: {
                type: 'object',
                properties: { direction: { type: 'string' }, stages: { type: 'array', items: { type: 'string' } }, currentStage: { type: 'number' } },
                required: ['direction'],
            },
            comment: COMMENT,
        },
        required: ['comment'],
    },
});
