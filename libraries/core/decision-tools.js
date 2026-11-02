import { COMMENT } from './decision-tool-comment.js';
import * as turn from './decision-tool-schemas-turn.js';
import * as world from './decision-tool-schemas-world.js';

export * from './decision-tool-schemas-turn.js';
export * from './decision-tool-schemas-world.js';
export { COMMENT } from './decision-tool-comment.js';

/**
 * Инструменты директора — общие правила. Чистые данные и проверки, без шин и
 * моделей: исполнение живёт в ядре, здесь только то, что видит модель и что
 * движок проверяет до исполнения.
 *
 * Каждый вызов обязан нести `comment` — не меньше одного предложения. Это
 * правило владельца (DIRECTOR-SPEC.md) и оно же распространяется на чужие
 * инструменты (Notebook, Secrets): их схема дополняется полем комментария.
 */

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

/** Все схемы движка, к которым добавляются чужие инструменты. */
export function buildToolList(externalSchemas = []) {
    const own = [
        turn.UPDATE_ROSTER_TOOL, turn.ASSESS_TOOL, turn.SUBMIT_TURN_TOOL, turn.SET_PLAN_TOOL,
        turn.CHARACTER_NOTE_TOOL, turn.ARC_TOOL, turn.CURRENT_STATE_TOOL, world.SET_CHARACTER_LEVEL_TOOL,
        world.SET_CHARACTER_PLAN_TOOL, world.RESOLVE_CHARACTER_PLAN_TOOL, world.LIBRARY_TOOL,
        world.MEMORY_TOOL, world.FORCED_MEMORY_TOOL, world.SPAWN_RESEARCHER_TOOL, world.RECALL_NAME_TOOL,
        world.LOREBOOK_TOOL, world.CHARACTER_BANK_TOOL, world.SAVE_DRAFT_TOOL, world.AWAIT_TOOL,
    ];
    const external = (Array.isArray(externalSchemas) ? externalSchemas : [])
        .filter(schema => schema && String(schema.name ?? '').trim())
        .map(withComment);
    return [...own, ...external];
}
