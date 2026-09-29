/**
 * Внутренний формат пресета Prompt Manager (PROMPT_MANAGER_PLAN.md, разделы 0 и 9).
 * Чистые данные и константы, без ввода-вывода. Источник истины — этот формат;
 * файл ST — только вход и выход (pm-st-import.js / pm-st-export.js).
 *
 * Пресет:
 *   formatVersion, name,
 *   params      — параметры генерации под ИМЕНАМИ ST (temperature, top_p, reasoning_effort…),
 *   templates   — служебные шаблоны (newChat, wi, scenario…),
 *   blocks[]    — библиотека блоков в порядке `prompts[]` ST,
 *   tree[]      — порядок отправки: узлы `item` (ссылка на блок) и `group` (обёртка с детьми),
 *   orders      — прочие списки `prompt_order` ST как есть (для точного экспорта),
 *   primaryOrder— character_id того списка, из которого собрано дерево,
 *   extensions  — `extensions` ST как есть (regex_scripts и др.),
 *   opaque      — всё нераспознанное, включая поля подключения (не применяем, секреты чистим при экспорте).
 *
 * Блок хранит ТОЛЬКО те поля, что были в источнике: экспорт не выдумывает лишнего.
 */
export const PM_FORMAT_VERSION = 1;

/** Параметры генерации ST Chat Completion (имена ST, значения как есть). */
export const PARAM_KEYS = [
    'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty',
    'openai_max_context', 'openai_max_tokens', 'max_context_unlocked', 'seed', 'n', 'stream_openai',
    'reasoning_effort', 'show_thoughts', 'verbosity', 'function_calling', 'tool_call_recurse_limit', 'tool_reasoning_mode',
    'enable_web_search', 'use_sysprompt', 'squash_system_messages', 'names_behavior',
    'assistant_prefill', 'assistant_impersonation', 'continue_prefill', 'continue_postfix',
    'media_inlining', 'inline_image_quality', 'request_images', 'request_image_aspect_ratio', 'request_image_resolution',
];

/** Служебные шаблоны: имя в ST -> имя во внутреннем формате. */
export const TEMPLATE_KEYS = {
    impersonation_prompt: 'impersonation',
    new_chat_prompt: 'newChat',
    new_group_chat_prompt: 'newGroupChat',
    new_example_chat_prompt: 'newExampleChat',
    continue_nudge_prompt: 'continueNudge',
    group_nudge_prompt: 'groupNudge',
    send_if_empty: 'sendIfEmpty',
    wi_format: 'wi',
    scenario_format: 'scenario',
    personality_format: 'personality',
};

/** Маркеры ST: содержимое подставляет сборка, а не текст блока. */
export const MARKER_IDS = [
    'dialogueExamples', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter',
    'charDescription', 'charPersonality', 'scenario', 'personaDescription',
];

export function createEmptyPreset(name = 'New preset') {
    return {
        formatVersion: PM_FORMAT_VERSION, name,
        params: {}, templates: {}, blocks: [], tree: [],
        orders: [], primaryOrder: null, extensions: {}, opaque: {},
    };
}

/** Блок в позиции «в истории на глубине» (инжект), а не «относительно порядка». */
export function isDepthBlock(block) {
    return block?.position === 'depth';
}

export function blockById(preset, id) {
    return preset.blocks.find(block => block.id === id) ?? null;
}

/** Обход дерева в порядке отправки: item и group (group — до детей). */
export function* walkTree(nodes) {
    for (const node of nodes) {
        yield node;
        if (node.type === 'group') yield* walkTree(node.children);
    }
}
