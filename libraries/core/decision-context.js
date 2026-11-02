import { chatToMessages } from './pm-history.js';
import { planSection, arcsSection, notesSection, notesAsBlocks } from './decision-state.js';

/**
 * Сборка контекстов директора и прозаика — чистые функции над уже
 * прочитанными данными, без DOM, сети и шин. Оба контекста собираются из
 * одних и тех же частей, поэтому порядок и форматирование живут в одном
 * месте.
 *
 * **Порядок — от стабильного к меняющемуся** (PROMPT_MANAGER_PLAN.md, раздел
 * про кэш префикса): правила и саммари меняются редко; блоки о персонаже
 * правит директор каждый ход; история дописывается; задание на ход —
 * последнее. Для `openai`-воркера это `messages`; для `anthropic`/`google`
 * те же части плющатся в `systemPrompt` + `prompt`, потому что multi-turn
 * `model.generate` поддерживает только `openai`.
 */

export const RECENT_MESSAGE_LIMIT = 20;

const DECIDER_ROLE = `You are the director of a roleplay. You decide what the character does next; another model writes the prose from your decision. You see the character blocks you maintain, every summary, your own past decisions and the recent history. You never write the reply itself.`;
const WRITER_ROLE = `You write the character's next reply. Follow the director's push for this turn exactly and do not invent plans of your own. Write in the voice of the character, in the language of the latest messages. Never mention the decision, the character blocks or this instruction.
You decide whether an opponent has time to counterattack; the director only states what was intended and how cleanly it happened. Causes and reasons are subtext — show them through behaviour, never explain them outright.`;

const DECIDER_TASK = `Decide what the character does next, based on the character blocks, the summaries, your past decisions and the latest messages.
Answer with ONLY a JSON object:
{"decision":"one to four sentences: what the character does, says and wants this turn","blocks":[{"op":"add|update|remove","id":"an existing block id when you know it","title":"short title","text":"block text"}]}
Keep blocks short, factual and useful for the writer. Omit "blocks" when nothing changes.`;

/**
 * Задание в режиме инструментов (часть 2). Модель не отвечает прозой и не
 * решает исход сцены за прозаика: она заполняет форму и заканчивает цикл.
 */
const DECIDER_TOOL_TASK = `Decide this turn with the tools you are given. Work in this order:
1. If someone entered or left the active scene, call update_roster.
2. For every action whose chance matters, call assess first: describe difficulty and experience in words, cite the returned id in the form.
3. Call submit_turn with the mandatory form. Every active roster member must appear exactly once. If it answers "missing", fix those fields and call it again.
4. When the turn is done, continue with the passive work if there is any, then call await.

Every single call must carry "comment": why you are making it, at least one full sentence. A call without a comment is rejected.
You never decide what the user does; in userResult write only the result of the user's action.
You never write the reply itself — the writer does that from your form.`;

function isToolCallEntry(entry) {
    return Array.isArray(entry?.extra?.tool_invocations) && entry.extra.tool_invocations.length > 0;
}

/** Скрытые вставки саммари не должны попасть в историю дважды: саммари идут отдельной частью. */
function isSummaryEntry(entry) {
    return Boolean(entry?.is_system) && String(entry?.name ?? '') === 'Summary';
}

/**
 * Последние `limit` ЛОГИЧЕСКИХ единиц истории. Единица — обычное сообщение
 * либо серия `isToolCall`-сообщений вместе со следующим за ней настоящим
 * ответом: так пара «вызов инструмента + результат» никогда не разрезается
 * (PROMPT_MANAGER_PLAN.md, раздел про историю ST).
 */
export function selectRecentChat(chat, limit = RECENT_MESSAGE_LIMIT) {
    const entries = (Array.isArray(chat) ? chat : []).filter(entry => !isSummaryEntry(entry));
    const units = [];
    for (let index = 0; index < entries.length;) {
        if (isToolCallEntry(entries[index])) {
            let end = index;
            while (end < entries.length && isToolCallEntry(entries[end])) end += 1;
            if (end < entries.length) end += 1; // настоящий ответ после цепочки
            units.push(entries.slice(index, end));
            index = end;
        } else {
            units.push([entries[index]]);
            index += 1;
        }
    }
    return units.slice(-Math.max(1, Number(limit) || RECENT_MESSAGE_LIMIT)).flat();
}

function stripPrivateFields(message) {
    return Object.fromEntries(Object.entries(message).filter(([key]) => !key.startsWith('_')));
}

/** Те же API-сообщения, что PM отправляет модели: `assistant + tool_calls` → `tool`-результаты. */
export function historyMessages(chat, limit = RECENT_MESSAGE_LIMIT) {
    return chatToMessages(selectRecentChat(chat, limit), { namesBehavior: 0 }).map(stripPrivateFields);
}

/** Плоский текст для `anthropic`/`google` и Text Completion, где multi-turn `messages` нет. */
export function renderHistory(messages) {
    return (messages ?? []).map(message => {
        if (message?.role === 'tool') return `Tool result: ${message.content}`;
        if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
            return `Assistant calls: ${message.tool_calls.map(call => `${call.function?.name ?? 'tool'}(${call.function?.arguments ?? ''})`).join(', ')}`;
        }
        return `${message?.role === 'user' ? 'User' : 'Character'}: ${String(message?.content ?? '')}`;
    }).join('\n\n');
}

export function summariesSection(summaries) {
    const list = Array.isArray(summaries) ? summaries : [];
    if (!list.length) return '';
    const body = list.map(record => {
        const from = Number(record?.startIndex);
        const to = Number(record?.endIndex);
        const header = Number.isFinite(from) && Number.isFinite(to)
            ? `[Summary of earlier messages #${from}–#${to}]`
            : '[Summary of earlier messages]';
        return `${header}\n${String(record?.text ?? '').trim()}`;
    }).join('\n\n');
    return `LONG-TERM SUMMARIES (oldest first):\n\n${body}`;
}

export function blocksSection(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    if (!list.length) return '';
    const body = list.map(block => `### ${String(block?.title ?? 'Untitled').trim() || 'Untitled'}\n${String(block?.text ?? '').trim()}`).join('\n\n');
    return `CHARACTER BLOCKS (maintained by the director):\n\n${body}`;
}

export function rosterSection(roster) {
    const active = Array.isArray(roster) ? roster.filter(Boolean) : [];
    if (!active.length) return '';
    return `ACTIVE ROSTER (everyone who can affect the scene right now; the form must cover each of them):\n\n${active.map(name => `- ${name}`).join('\n')}`;
}

export function runsSection(runs) {
    const list = Object.values(runs && typeof runs === 'object' ? runs : {})
        .filter(record => record && typeof record === 'object')
        .sort((a, b) => (Number(a.mesid) || 0) - (Number(b.mesid) || 0) || (Number(a.at) || 0) - (Number(b.at) || 0));
    if (!list.length) return '';
    const body = list.map(record => {
        const heading = record.mesid === undefined ? 'Earlier turn' : `Turn #${record.mesid}`;
        const reasoning = String(record.reasoning ?? '').trim();
        return `${heading}\nDecision: ${String(record.decision ?? '').trim()}${reasoning ? `\nReasoning: ${reasoning}` : ''}`;
    }).join('\n\n');
    return `PAST DIRECTOR RUNS (oldest first):\n\n${body}`;
}

function rulesSection(rules) {
    const value = String(rules ?? '').trim();
    return value ? `DIRECTOR RULES (written by the user — always follow them):\n\n${value}` : '';
}

/**
 * Контекст директора. `messages` — для `openai`/`st-main`; `systemPrompt` +
 * `prompt` — эквивалент для `anthropic`/`google`. Оба варианта собираются из
 * одного и того же порядка частей.
 */
export function buildDeciderContext({ rules = '', blocks = [], summaries = [], chat = [], runs = {}, thoughts = '', plan = null, arcs = [], notes = {}, roster = [], libraryText = '', planMissing = false, toolMode = false, limit = RECENT_MESSAGE_LIMIT } = {}) {
    const history = historyMessages(chat, limit);
    // Порядок — от стабильного к меняющемуся: правила, саммари, план/арки,
    // заметки, ростер, прогоны, thinking, блоки; история и задание в конце.
    const parts = [
        summariesSection(summaries), planSection(plan), arcsSection(arcs), notesSection(notes), String(libraryText ?? '').trim(),
        rosterSection(roster), runsSection(runs), String(thoughts ?? '').trim(), blocksSection(blocks),
    ].filter(Boolean);
    const systemPrompt = [DECIDER_ROLE, rulesSection(rules)].filter(Boolean).join('\n\n');
    const baseTask = toolMode ? DECIDER_TOOL_TASK : DECIDER_TASK;
    const task = planMissing ? `You have no plan yet. Call set_plan before submit_turn: a direction, not a fixed script.\n\n${baseTask}` : baseTask;
    const messages = [
        { role: 'system', content: systemPrompt },
        ...parts.map(content => ({ role: 'system', content })),
        ...history,
        { role: 'user', content: task },
    ];
    const prompt = [systemPrompt, ...parts, renderHistory(history), task].filter(Boolean).join('\n\n');
    return { systemPrompt, messages, prompt };
}

/**
 * Контекст прозаика: блоки + последние 20 + все саммари + решение текущего
 * хода. Дополнительного `user`-сообщения нет — последним остаётся хвост
 * истории, иначе прозаик ответил бы не на ту реплику.
 */
export function buildWriterContext({ blocks = [], notes = {}, summaries = [], chat = [], decision = '', limit = RECENT_MESSAGE_LIMIT } = {}) {
    const history = historyMessages(chat, limit);
    const allBlocks = [...blocks, ...notesAsBlocks(notes)];
    const parts = [
        WRITER_ROLE,
        summariesSection(summaries),
        blocksSection(allBlocks),
        String(decision ?? '').trim() ? `THE DIRECTOR'S PUSH FOR THIS TURN:\n\n${String(decision).trim()}` : '',
    ].filter(Boolean);
    const messages = [...parts.map(content => ({ role: 'system', content })), ...history];
    return { messages, prompt: [...parts, renderHistory(history)].filter(Boolean).join('\n\n') };
}
