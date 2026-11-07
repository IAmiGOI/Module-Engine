import { COMMENT } from './decision-tool-comment.js';
import * as turn from './decision-tool-schemas-turn.js';
import * as world from './decision-tool-schemas-world.js';
import * as bootstrap from './decision-tool-schemas-bootstrap.js';
import * as bank from './decision-tool-schemas-bank.js';
import { INSCRIBE_TOOL } from './decision-tool-schemas-inscribe.js';
import { AFTER_TURN_TOOL } from './decision-tool-schemas-after-turn.js';
import { DECREE_TOOL } from './decision-tool-schemas-decree.js';
import { COUNSELLOR_TOOLS, COUNSELLOR_STOP_TOOLS } from './decision-tool-schemas-counsellor.js';

export * from './decision-tool-schemas-turn.js';
export * from './decision-tool-schemas-world.js';
export * from './decision-tool-schemas-bootstrap.js';
export * from './decision-tool-schemas-bank.js';
export * from './decision-tool-schemas-inscribe.js';
export * from './decision-tool-schemas-after-turn.js';
export * from './decision-tool-schemas-decree.js';
export { COMMENT } from './decision-tool-comment.js';
export { COUNSELLOR_TOOLS, COUNSELLOR_STOP_TOOLS, PETITION_TOOL, NOTHING_YET_TOOL, REPLY_TOOL, PRAYER_TOOL, COUNSELLOR_AWAIT_TOOL } from './decision-tool-schemas-counsellor.js';

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

/**
 * Инструменты хода резолвера: `assess` для того, что может провалиться, и
 * `inscribe` — сам шаблон. Всё остальное на ходу закрыто: планы убраны из
 * спеки, заметки и записи — в «после хода».
 */
export const TURN_ONLY_TOOLS = Object.freeze(['assess', 'inscribe']);

/** Что видит резолвер на ходу: `assess` и шаблон, а не весь набор. */
export function buildTurnToolList() {
    return [turn.ASSESS_TOOL, INSCRIBE_TOOL];
}

/** Советник читает Ведомость: Petition, «важного нет», ответ пользователю и Молитва. */
export function buildCounsellorToolList() {
    return [...COUNSELLOR_TOOLS];
}

/**
 * Director (часть 19) — только Указ и правка банка: контекст полу-слепой, а
 * предложения резолвера принимаются тем же вызовом `decree`.
 */
export function buildDirectorToolList() {
    return [DECREE_TOOL, bank.BANK_EDIT_TOOL, bank.SET_BANK_IMPORTANCE_TOOL, turn.AWAIT_TOOL];
}

/** Все схемы движка, к которым добавляются чужие инструменты. */
export function buildToolList(externalSchemas = []) {
    const own = [
        turn.ASSESS_TOOL, INSCRIBE_TOOL, AFTER_TURN_TOOL,
        turn.UPDATE_ROSTER_TOOL, turn.SET_PLAN_TOOL,
        turn.CHARACTER_NOTE_TOOL, turn.ARC_TOOL, turn.CURRENT_STATE_TOOL, world.SET_CHARACTER_LEVEL_TOOL,
        world.SET_CHARACTER_PLAN_TOOL, world.RESOLVE_CHARACTER_PLAN_TOOL, world.LIBRARY_TOOL,
        world.MEMORY_TOOL, world.FORCED_MEMORY_TOOL, world.SPAWN_RESEARCHER_TOOL, world.RECALL_NAME_TOOL,
        world.LOREBOOK_TOOL, world.CHARACTER_BANK_TOOL, bank.BANK_EDIT_TOOL, bank.SET_BANK_IMPORTANCE_TOOL,
        world.CHARACTER_KNOWLEDGE_TOOL, turn.UPDATE_STORY_TOOL, world.SAVE_DRAFT_TOOL, world.AWAIT_TOOL,
        bootstrap.ASK_USER_TOOL, bootstrap.WRITE_CHAT_BRIEF_TOOL,
    ];
    const external = (Array.isArray(externalSchemas) ? externalSchemas : [])
        .filter(schema => schema && String(schema.name ?? '').trim())
        .map(withComment);
    return [...own, ...external];
}
