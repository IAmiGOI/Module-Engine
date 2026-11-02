import { chatToMessages } from './chat-to-messages.js';
import { planSection, arcsSection, notesSection, notesAsBlocks } from './decision-state.js';
import { DIRECTOR_SYSTEM, DIRECTOR_TURN, WRITER_SYSTEM, WRITER_PUSH, fillPrompt } from './decision-prompts.js';

/**
 * Сборка контекстов директора и прозаика — чистые функции над уже
 * прочитанными данными, без DOM, сети и шин. Оба контекста собираются из
 * одних и тех же частей, поэтому порядок и форматирование живут в одном
 * месте.
 *
 * **Порядок — от стабильного к меняющемуся** (кеш префикса у провайдера):
 * правила и саммари меняются редко; заметки о персонажах правит директор
 * каждый ход; история дописывается; задание на ход — последнее. Для
 * `openai`-воркера это `messages`; для `anthropic`/`google` те же части
 * плющатся в `systemPrompt` + `prompt`, потому что multi-turn `model.generate`
 * поддерживает только `openai`.
 *
 * Кастомный блок пользователя вставляется в историю, а не в системный
 * префикс: у директора — на глубину 2 цикла от конца, у прозаика — @5
 * сообщений от конца. Пустой блок не вставляется вовсе.
 */

export const RECENT_MESSAGE_LIMIT = 20;
export const DIRECTOR_BLOCK_CYCLES = 2;
export const WRITER_BLOCK_DEPTH = 5;

function isToolCallEntry(entry) {
    return Array.isArray(entry?.extra?.tool_invocations) && entry.extra.tool_invocations.length > 0;
}

/** Скрытые вставки саммари не должны попасть в историю дважды: саммари идут отдельной частью. */
function isSummaryEntry(entry) {
    return Boolean(entry?.is_system) && String(entry?.name ?? '') === 'Summary';
}

/** Логические единицы: обычное сообщение либо цепочка инструментов вместе с ответом после неё. */
function groupUnits(entries) {
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
    return units;
}

function selectedUnits(chat, limit) {
    const entries = (Array.isArray(chat) ? chat : []).filter(entry => !isSummaryEntry(entry));
    return groupUnits(entries).slice(-Math.max(1, Number(limit) || RECENT_MESSAGE_LIMIT));
}

/**
 * Последние `limit` ЛОГИЧЕСКИХ единиц истории. Единица — обычное сообщение
 * либо серия `isToolCall`-сообщений вместе со следующим за ней настоящим
 * ответом: так пара «вызов инструмента + результат» никогда не разрезается.
 */
export function selectRecentChat(chat, limit = RECENT_MESSAGE_LIMIT) {
    return selectedUnits(chat, limit).flat();
}

function stripPrivateFields(message) {
    return Object.fromEntries(Object.entries(message).filter(([key]) => !key.startsWith('_')));
}

function unitMessages(unit) {
    return chatToMessages(unit, { namesBehavior: 0 }).map(stripPrivateFields);
}

/** Те же API-сообщения, что уходят модели: `assistant + tool_calls` → `tool`-результаты. */
export function historyMessages(chat, limit = RECENT_MESSAGE_LIMIT) {
    return selectedUnits(chat, limit).flatMap(unitMessages);
}

/** Блок пользователя: строка (часть 3) или готовые сообщения раздела (часть 4). */
function blockMessages(block) {
    if (Array.isArray(block)) {
        return block
            .filter(message => String(message?.content ?? '').trim())
            .map(message => ({ role: message?.role ?? 'system', content: String(message.content) }));
    }
    const text = String(block ?? '').trim();
    return text ? [{ role: 'system', content: text }] : [];
}

function insertBlock(messages, block, index) {
    const parts = blockMessages(block);
    if (!parts.length) return messages;
    const at = Math.max(0, Math.min(Number(index) || 0, messages.length));
    return [...messages.slice(0, at), ...parts, ...messages.slice(at)];
}

/** Цикл — реплика пользователя и всё, что идёт до следующей его реплики. */
function groupCycles(units) {
    const cycles = [];
    for (const unit of units) {
        if (unit.some(entry => entry?.is_user === true) || !cycles.length) cycles.push([]);
        cycles.at(-1).push(unit);
    }
    return cycles;
}

/** История директора с блоком перед последними двумя циклами. */
export function directorHistory(chat, limit, block) {
    const units = selectedUnits(chat, limit);
    const cycles = groupCycles(units);
    const before = Math.max(0, cycles.length - DIRECTOR_BLOCK_CYCLES);
    const index = cycles.slice(0, before).flat().reduce((sum, unit) => sum + unitMessages(unit).length, 0);
    return insertBlock(units.flatMap(unitMessages), block, index);
}

/** История прозаика с блоком за пять сообщений от конца. */
export function writerHistory(chat, limit, block) {
    const messages = historyMessages(chat, limit);
    return insertBlock(messages, block, messages.length - WRITER_BLOCK_DEPTH);
}

/** Плоский текст для `anthropic`/`google` и Text Completion, где multi-turn `messages` нет. */
export function renderHistory(messages) {
    return (messages ?? []).map(message => {
        if (message?.role === 'tool') return `Tool result: ${message.content}`;
        if (message?.role === 'system') return `System: ${String(message?.content ?? '')}`;
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

function notesText(notes) {
    const blocks = notesAsBlocks(notes);
    if (!blocks.length) return '';
    return `CHARACTER NOTES (the most the writer needs to know):\n\n${blocks.map(block => `### ${block.title}\n${block.text}`).join('\n\n')}`;
}

/**
 * Контекст директора. `messages` — для `openai`/`st-main`; `systemPrompt` +
 * `prompt` — эквивалент для `anthropic`/`google`. `task` заменяет задание на
 * ход (пассивный цикл и заготовка), по умолчанию — начало хода.
 */
export function buildDeciderContext({
    summaries = [], chat = [], runs = {}, thoughts = '', thoughtMessages = [], plan = null, arcs = [], notes = {},
    roster = [], libraryText = '', lorebookText = '', banksText = '', planMissing = false, directorBlock = '', task = '', limit = RECENT_MESSAGE_LIMIT,
} = {}) {
    const history = directorHistory(chat, limit, directorBlock);
    const parts = [
        String(lorebookText ?? '').trim(), summariesSection(summaries), planSection(plan), arcsSection(arcs), notesSection(notes), String(banksText ?? '').trim(), String(libraryText ?? '').trim(),
        rosterSection(roster), runsSection(runs), String(thoughts ?? '').trim(),
    ].filter(Boolean);
    const thoughtList = (Array.isArray(thoughtMessages) ? thoughtMessages : [])
        .filter(message => String(message?.content ?? '').trim())
        .map(message => ({ role: 'system', content: String(message.content) }));
    const baseTask = String(task ?? '').trim() || DIRECTOR_TURN;
    const turnTask = planMissing ? `You have no plan yet. Call set_plan before submit_turn: a direction, not a fixed script.\n\n${baseTask}` : baseTask;
    const messages = [
        { role: 'system', content: DIRECTOR_SYSTEM },
        ...parts.map(content => ({ role: 'system', content })),
        ...thoughtList,
        ...history,
        { role: 'user', content: turnTask },
    ];
    const prompt = [DIRECTOR_SYSTEM, ...parts, ...thoughtList.map(message => message.content), renderHistory(history), turnTask].filter(Boolean).join('\n\n');
    return { systemPrompt: DIRECTOR_SYSTEM, messages, prompt };
}

/**
 * Контекст прозаика: заметки о персонажах + история с блоком @5 + Push в
 * хвосте. Push идёт после истории, как написано во встроенном промпте.
 */
export function buildWriterContext({ notes = {}, summaries = [], chat = [], decision = '', writerBlock = '', banksText = '', examples = '', lorebookText = '', limit = RECENT_MESSAGE_LIMIT } = {}) {
    const history = writerHistory(chat, limit, writerBlock);
    const parts = [WRITER_SYSTEM, String(examples ?? '').trim(), String(banksText ?? '').trim(), String(lorebookText ?? '').trim(), summariesSection(summaries), notesText(notes)].filter(Boolean);
    const push = String(decision ?? '').trim() ? fillPrompt(WRITER_PUSH, { push: String(decision).trim() }) : '';
    const messages = [
        ...parts.map(content => ({ role: 'system', content })),
        ...history,
        ...(push ? [{ role: 'system', content: push }] : []),
    ];
    return { messages, prompt: [...parts, renderHistory(history), push].filter(Boolean).join('\n\n') };
}
