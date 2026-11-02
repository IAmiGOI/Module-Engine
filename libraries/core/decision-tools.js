/**
 * Инструменты директора — схемы и общие правила. Чистые данные и проверки,
 * без шин и моделей: исполнение живёт в ядре, здесь только то, что видит
 * модель и что движок проверяет до исполнения.
 *
 * Каждый вызов обязан нести `comment` — не меньше одного предложения. Это
 * правило владельца (DIRECTOR-SPEC.md) и оно же распространяется на чужие
 * инструменты (Notebook, Secrets): их схема дополняется полем комментария.
 */

const COMMENT = {
    type: 'string',
    description: 'Why you are calling this tool, in at least one full sentence. Required; a call without it is rejected.',
};

/** «Не меньше одного предложения»: буква есть, и есть конец предложения. */
export function hasSentence(text) {
    const clean = String(text ?? '').trim();
    if (!/[a-zа-яё]/i.test(clean)) return false;
    return /[.!?…](\s|$)/.test(clean) || clean.split(/\s+/).length >= 6;
}

export function commentProblem(args) {
    return hasSentence(args?.comment) ? null : 'Every tool call needs a comment of at least one full sentence in "comment".';
}

/** Схема ST/движка → схема с обязательным комментарием. */
export function withComment(schema) {
    const parameters = schema?.parameters && typeof schema.parameters === 'object' ? schema.parameters : { type: 'object', properties: {} };
    return {
        ...schema,
        description: `${schema?.description ?? ''}\n\nEvery call must also include "comment": why you are making it, at least one full sentence.`.trim(),
        parameters: {
            ...parameters,
            properties: { ...(parameters.properties ?? {}), comment: COMMENT },
            required: [...new Set([...(Array.isArray(parameters.required) ? parameters.required : []), 'comment'])],
        },
    };
}

/** Аргументы без служебного комментария — то, что получает чужой инструмент. */
export function stripComment(args) {
    if (!args || typeof args !== 'object') return {};
    const { comment, ...rest } = args;
    return rest;
}

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
    description: 'Ask the engine for the chance that a character can do what they intend. Describe difficulty and experience in words (trivial … impossible, novice … master); the engine projects them, rolls the dice and returns the degree words for the Push. Call it BEFORE submit_turn and cite the returned id there.',
    parameters: {
        type: 'object',
        properties: {
            character: { type: 'string', description: 'Who is attempting it.' },
            action: { type: 'string', description: 'What exactly they are trying to do.' },
            difficulty: { type: 'string', description: 'The difficulty in words, e.g. "hard, against the odds".' },
            experience: { type: 'string', description: 'Their relevant experience in words, e.g. "skilled, practised".' },
            comment: COMMENT,
        },
        required: ['character', 'action', 'difficulty', 'experience', 'comment'],
    },
});

export const SUBMIT_TURN_TOOL = Object.freeze({
    name: 'submit_turn',
    displayName: 'Submit the turn',
    description: 'The mandatory form for this turn. Every active roster member must appear exactly once; every listed assess id must exist. Without a valid form the writer does not write. If the engine returns "missing", fix those fields and call again.',
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
                        decision: { type: 'string', description: 'What they do overall. Persists between turns.' },
                        decisionReason: { type: 'string' },
                        action: { type: 'string', description: 'What they do in this turn, including the line they speak.' },
                        actionReason: { type: 'string' },
                        speech: { type: 'string' },
                        assessId: { type: 'string', description: 'Id returned by assess.' },
                        outcome: { type: 'string', description: 'Why it succeeded or failed, written after the assess result is known.' },
                    },
                    required: ['name', 'decision', 'decisionReason', 'action', 'actionReason', 'assessId', 'outcome'],
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
    description: 'Keep at most four short notes per character: what the writer must know about them right now. A fifth note is refused — replace or delete one first. This replaces the Notebook notes while the core is on; old Notebook notes are not deleted.',
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

/** Все схемы движка, к которым добавляются чужие инструменты при включённом ядре. */
export function buildToolList(externalSchemas = []) {
    const own = [UPDATE_ROSTER_TOOL, ASSESS_TOOL, SUBMIT_TURN_TOOL, SET_PLAN_TOOL, CHARACTER_NOTE_TOOL, ARC_TOOL, CURRENT_STATE_TOOL, AWAIT_TOOL];
    const external = (Array.isArray(externalSchemas) ? externalSchemas : [])
        .filter(schema => schema && String(schema.name ?? '').trim())
        .map(withComment);
    return [...own, ...external];
}
