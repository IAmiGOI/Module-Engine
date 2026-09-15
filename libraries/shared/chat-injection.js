/**
 * Prompt-injection depth math — extracted at the 4th real consumer
 * (modules/notebook/index.js, modules/tools/notebook.js,
 * modules/tools/secrets.js all defined an identical copy; cores/map-narration
 * needed a 4th — LIBRARIES.md's own "extract on the second real consumer"
 * rule was already overdue here). Pure, no DOM/ST/network.
 */

/**
 * Where in a `chat` array (as `generation.beforeSend`'s `pipeline.stages`
 * mutate it — see any consumer's own `injectIntoPrompt()`) a message
 * belongs, `depth` messages from the end — `depth` 0 means "right before
 * what the model is about to say", the same `@0` Alpha already used.
 */
export function computeInsertIndex(chatLength, depth) {
    return Math.max(0, Math.min(chatLength, chatLength - Math.max(0, Number(depth) || 0)));
}
