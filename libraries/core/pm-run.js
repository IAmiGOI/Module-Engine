import { createMacroEngine } from './pm-macros.js';
import { chatToMessages } from './pm-history.js';
import { activateEntries } from './pm-lorebook.js';
import { assemblePrompt } from './pm-assemble.js';
import { trimMessages } from './pm-trim.js';
import { summarizeTokens } from './pm-tokens.js';
import { finalizeMessages, paramsToBody } from './pm-finalize.js';
import { blockById } from './pm-preset-format.js';
import { applyRules } from './pm-rules.js';
import { joinWrappers } from './pm-wrap-join.js';

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
const isBlankText = value => typeof value !== 'string' || value.trim() === '';

export function buildRequest(preset, materials, options = {}) {
    const chat = materials.chat ?? [];
    const lastOf = predicate => textOf([...chat].reverse().find(predicate));
    const values = {
        user: materials.user, char: materials.char, description: materials.description, personality: materials.personality,
        scenario: materials.scenario, persona: materials.persona, summary: materials.summary ?? '', input: materials.input ?? '',
        lastMessage: textOf(chat.at(-1)), lastChatMessage: textOf(chat.at(-1)), lastMessageId: chat.length ? String(chat.length - 1) : '',
        model: materials.model ?? '', maxPrompt: String(preset.params?.openai_max_context ?? ''), group: materials.group ?? '',
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
        chatLength: chat.length, vars: engine.vars, tracker: materials.tracker, jev: options.jev, timed: options.timed ?? {},
        random: options.random, plugins: options.plugins, onPluginError: options.onPluginError,
    };
    const injections = lore.depth.map(item => ({ ...item, block: `lore:${item.uid}` }));
    // Промпт на глубине карточки ST кладёт вставкой в чат; порядок 100 — как у вставок по умолчанию, роль и глубину задаёт сама карточка.
    if (!isBlankText(materials.depthPrompt?.prompt)) injections.push({ depth: materials.depthPrompt.depth ?? 4, order: 100, role: materials.depthPrompt.role ?? 'system', content: materials.depthPrompt.prompt, block: 'depthPrompt' });
    const assembled = assemblePrompt(preset, {
        markers, history, substitute: engine.substitute, contributions: options.contributions ?? {}, facts, injections,
        cardOverrides: { main: materials.systemPrompt, jailbreak: materials.postHistoryInstructions },
        setVariable: (name, value) => engine.vars.set(name, value),
    });

    const ruled = options.transform ? options.transform(applyRules(assembled.messages, preset.rules, { substitute: engine.substitute }), { preset, materials }) : applyRules(assembled.messages, preset.rules, { substitute: engine.substitute });
    const withPriority = ruled.map(message => {
        const block = blockById(preset, message._block);
        const priority = block?.trimPriority ?? DEFAULT_PRIORITY[message._block];
        return priority === undefined ? message : { ...message, _priority: priority };
    });
    const reserved = params.openai_max_tokens ?? 0;
    const budget = options.budgetOverride ?? Math.max(maxContext - reserved, 0);
    const trimmed = trimMessages(withPriority, { budget, headroom: options.headroom ?? 0.1, prevCut: options.prevCut ?? 0 });
    const joined = joinWrappers(trimmed.messages); // группы с обёрткой — одним сообщением, после обрезки (pm-wrap-join.js)
    const messages = finalizeMessages(joined, { params, substitute: engine.substitute });
    return {
        messages, body: paramsToBody(params), report: assembled.report, dropped: trimmed.dropped, cut: trimmed.cut,
        tokens: summarizeTokens(trimmed.messages), overBudget: trimmed.overBudget, budget,
        lore: { activated: lore.activated, skipped: lore.skipped },
        macros: { usedRandom: engine.state.usedRandom, unresolved: [...new Set(engine.state.unresolved)] },
        withMarkers: joined,
        /** Всё, что нужно, чтобы собрать промпты шагов Guided CoT теми же макросами и условиями. */
        stepEnv: { substitute: engine.substitute, facts, contributions: options.contributions ?? {}, setVariable: (name, value) => engine.vars.set(name, value) },
    };
}
