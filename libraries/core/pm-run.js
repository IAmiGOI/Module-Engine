import { createMacroEngine } from './pm-macros.js';
import { chatToMessages } from './pm-history.js';
import { activateEntries } from './pm-lorebook.js';
import { assemblePrompt } from './pm-assemble.js';
import { trimMessages } from './pm-trim.js';
import { summarizeTokens } from './pm-tokens.js';
import { finalizeMessages, paramsToBody } from './pm-finalize.js';
import { blockById } from './pm-preset-format.js';

/** Приоритет обрезки по умолчанию для служебных маркеров: ниже 100 — можно резать (лорбук и примеры раньше всего). */
const DEFAULT_PRIORITY = { worldInfoBefore: 40, worldInfoAfter: 40, dialogueExamples: 30 };

const textOf = entry => String(entry?.mes ?? '');

/**
 * Вся сборка запроса одной чистой функцией (PROMPT_MANAGER_PLAN.md, этапы 2–4):
 * материалы ST и ядер → макросы → история → лорбук → порядок пресета → обрезка → тело запроса.
 *
 * materials:
 *   user, char, description, personality, scenario, persona, mesExamples — строки
 *   chat — массив `chat` ST (вставки модулей уже внутри); macros — наши макросы (rp-time_*)
 *   loreEntries — записи лорбука активных книг; tracker(id, field) — значения трекеров
 * options: { contributions, globals, seed (заморозка random), timed, prevCut, headroom, budgetOverride }
 */
export function buildRequest(preset, materials, options = {}) {
    const chat = materials.chat ?? [];
    const lastOf = predicate => textOf([...chat].reverse().find(predicate));
    const values = {
        user: materials.user, char: materials.char, description: materials.description, personality: materials.personality,
        scenario: materials.scenario, persona: materials.persona, summary: materials.summary ?? '', input: materials.input ?? '',
        lastMessage: textOf(chat.at(-1)), lastChatMessage: textOf(chat.at(-1)),
        lastUserMessage: lastOf(entry => entry.is_user), lastCharMessage: lastOf(entry => !entry.is_user && !entry.is_system),
    };
    const engine = createMacroEngine({ values, macros: materials.macros, globals: options.globals, seed: options.seed });
    const params = preset.params ?? {};
    const history = chatToMessages(chat, { namesBehavior: params.names_behavior ?? 0, substitute: engine.substitute });
    const newestFirst = [...chat].reverse().map(textOf);

    const maxContext = params.openai_max_context ?? 8192;
    const lore = activateEntries(materials.loreEntries ?? [], {
        messages: newestFirst, chatLength: chat.length, scanDepth: materials.wiScanDepth ?? 4,
        budgetTokens: Math.floor(maxContext * (materials.wiBudgetPercent ?? 25) / 100), random: options.random, timed: options.timed ?? {},
    });
    const join = list => list.join('\n');
    const examples = [join(lore.examplesTop), materials.mesExamples ?? '', join(lore.examplesBottom)].filter(Boolean).join('\n');
    const markers = {
        charDescription: materials.description, charPersonality: materials.personality, scenario: materials.scenario, personaDescription: materials.persona,
        worldInfoBefore: join(lore.before), worldInfoAfter: join(lore.after), dialogueExamples: examples,
    };
    const facts = {
        messages: [...chat].reverse().filter(entry => textOf(entry).trim()).map(entry => ({ role: entry.is_user ? 'user' : 'assistant', text: textOf(entry) })),
        chatLength: chat.length, vars: engine.vars, tracker: materials.tracker, timed: options.timed ?? {},
        random: options.random, plugins: options.plugins, onPluginError: options.onPluginError,
    };
    const injections = lore.depth.map(item => ({ ...item, block: `lore:${item.uid}` }));
    const assembled = assemblePrompt(preset, {
        markers, history, substitute: engine.substitute, contributions: options.contributions ?? {}, facts, injections,
        setVariable: (name, value) => engine.vars.set(name, value),
    });

    const withPriority = assembled.messages.map(message => {
        const block = blockById(preset, message._block);
        const priority = block?.trimPriority ?? DEFAULT_PRIORITY[message._block];
        return priority === undefined ? message : { ...message, _priority: priority };
    });
    const reserved = params.openai_max_tokens ?? 0;
    const budget = options.budgetOverride ?? Math.max(maxContext - reserved, 0);
    const trimmed = trimMessages(withPriority, { budget, headroom: options.headroom ?? 0.1, prevCut: options.prevCut ?? 0 });
    const messages = finalizeMessages(trimmed.messages, { params, substitute: engine.substitute });
    return {
        messages, body: paramsToBody(params), report: assembled.report, dropped: trimmed.dropped, cut: trimmed.cut,
        tokens: summarizeTokens(trimmed.messages), overBudget: trimmed.overBudget, budget,
        lore: { activated: lore.activated, skipped: lore.skipped },
        macros: { usedRandom: engine.state.usedRandom, unresolved: [...new Set(engine.state.unresolved)] },
        withMarkers: trimmed.messages,
    };
}
