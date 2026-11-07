import { chatToMessages } from './chat-to-messages.js';
import { planSection, arcsSection, notesSection, notesAsBlocks } from './decision-state.js';
import { DIRECTOR_REASONING, DIRECTOR_SYSTEM, DIRECTOR_TURN, RESOLVER_THINK_TURN, RESOLVER_THINK_AFTER, WRITER_SYSTEM, WRITER_INSCRIPTION, fillPrompt } from './decision-prompts.js';
import {
    compressedDigestMessages, fullTurnMessages, renderCompressedDigests, renderFullTurns,
} from './decision-turn-digest.js';
import { frozenWindowMessages, renderFrozenWindows, renderWindow, windowMessages } from './decision-window.js';

/**
 * Сборка контекстов директора и прозаика — чистые функции над уже
 * прочитанными данными, без DOM, сети и шин. Оба контекста собираются из
 * одних и тех же частей, поэтому порядок и форматирование живут в одном
 * месте.
 *
 * **Порядок — от неизменного к меняющемуся** (кеш префикса у провайдера):
 * system, дата-банки и лорбук почти не меняются; сжатые ходы только
 * дописываются в конец; два последних хода идут полностью; план, заметки,
 * ростер, библиотека, саммари и отчёты правятся каждый ход. Для
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

function notesText(notes) {
    const blocks = notesAsBlocks(notes);
    if (!blocks.length) return '';
    return `CHARACTER NOTES (the most the writer needs to know):\n\n${blocks.map(block => `### ${block.title}\n${block.text}`).join('\n\n')}`;
}

/**
 * Блок пользователя внутри плавающего окна: перед последними двумя циклами
 * хода. Окно — уже сообщения, поэтому вставка идёт по индексу записи.
 */
export function windowHistory(entries, block, keepTurns = DIRECTOR_BLOCK_CYCLES) {
    const list = Array.isArray(entries) ? entries : [];
    const messages = windowMessages(list);
    const turns = list.map((entry, index) => (entry?.kind === 'turn' ? index : -1)).filter(index => index >= 0);
    const at = turns.length >= keepTurns ? turns[turns.length - keepTurns] : 0;
    return insertBlock(messages, block, at);
}

/** Ближняя полная проекция Great Bank: столько сообщений от конца контекста директора. */
export const NEAR_BANKS_DEPTH = 20;

/** Указ действующих персонажей — столько сообщений от конца контекста резолвера. */
export const DECREE_DEPTH = 10;

/**
 * Контекст директора части 10: защищённая часть (банки → лорбук → арки →
 * библиотека → замороженные окна → длинные планы → ростер → дубли банков)
 * → плавающее окно → изменения активных (знания и заметки) → план на @2 →
 * задание. Блок 9 (окно) только дописывается; прежний путь части 9
 * (`digests` + `turns` + история) остаётся до w2.
 *
 * Ближняя полная проекция Great Bank встаёт на @20 от конца: правки видны
 * сразу, а дальняя компактная снята в границе окна и кеш верха не ломает.
 */
export function buildDeciderContext({
    plan = null, arcs = [], notes = {}, roster = [],
    banksText = '', lorebookText = '', chatBriefText = '', libraryText = '', plansText = '', activeBanksText = '',
    nearBanksText = '', decreeText = '', creationText = '', decreeWait = '', frozenWindows = [], windowEntries = [], windowMode = false, knowledgeText = '', sceneText = '',
    planMissing = false, directorBlock = '', storySettings = '', task = '', resolverTurn = false, afterTurn = false,
    digests = [], turns = [], chat = [], summaries = [], researchText = '', bankText = '', lorebookChanges = '', limit = RECENT_MESSAGE_LIMIT,
} = {}) {
    const usingWindow = windowMode || (Array.isArray(windowEntries) && windowEntries.length > 0);
    const history = usingWindow
        ? windowHistory(windowEntries, directorBlock)
        : directorHistory(chat, limit, directorBlock);
    const head = [
        // Мироздание (фаза 5) — в стабильной части, рядом с дальними банками; до фазы 5 строки нет.
        String(creationText ?? '').trim(),
        String(banksText ?? '').trim(), String(lorebookText ?? '').trim(), arcsSection(arcs),
        String(chatBriefText ?? '').trim(), String(libraryText ?? '').trim(),
    ].filter(Boolean);
    const middle = [
        ...frozenWindowMessages(frozenWindows),
        String(plansText ?? '').trim(),
        rosterSection(roster),
        String(activeBanksText ?? '').trim(),
    ].filter(Boolean);
    const middleMessages = middle.map(entry => (typeof entry === 'string' ? { role: 'system', content: entry } : entry));
    const windowPart = usingWindow ? [] : [...compressedDigestMessages(digests), ...fullTurnMessages(turns)];
    // «Что сейчас» — в изменяемом хвосте, последним перед планом: ближе к заданию, и кеш до окна не трогает.
    const state = [String(knowledgeText ?? '').trim(), notesSection(notes), String(sceneText ?? '').trim(), String(decreeWait ?? '').trim()].filter(Boolean);
    // Резолверу план не нужен: на ходу планы закрыты (спека части 17 убрала их), а свой план ведёт директор.
    const planContent = resolverTurn ? '' : (planSection(plan) || 'YOUR PLAN: none yet — call set_plan.');
    const baseTask = String(task ?? '').trim() || DIRECTOR_TURN;
    const missingPlan = planMissing && !resolverTurn;
    const taskText = missingPlan ? `You have no plan yet. Call set_plan in a background cycle: a direction, not a fixed script.\n\n${baseTask}` : baseTask;
    // CoT резолвера — в самом конце, ближе всего к генерации: без него модель засоряет ризонинг даже с инструментами.
    const turnTask = `${taskText}\n\n${resolverTurn ? RESOLVER_THINK_TURN : (afterTurn ? RESOLVER_THINK_AFTER : DIRECTOR_REASONING)}`;
    // Настройки игры — сразу после system: защищённая часть, меняется только при смене настроек.
    const settingsBlock = String(storySettings ?? '').trim();
    const messages = [
        { role: 'system', content: DIRECTOR_SYSTEM },
        ...(settingsBlock ? [{ role: 'system', content: settingsBlock }] : []),
        ...head.map(content => ({ role: 'system', content })),
        ...middleMessages,
        ...windowPart,
        ...history,
        ...state.map(content => ({ role: 'system', content })),
        ...(planContent ? [{ role: 'system', content: planContent }] : []),
        { role: 'user', content: turnTask },
    ];
    // Указ действующих — на @10 от конца: он меняется, когда директор издаёт новый, и должен быть близко.
    const withDecree = insertBlock(messages, String(decreeText ?? '').trim(), Math.max(1, messages.length - DECREE_DEPTH));
    // Ближняя полная проекция Great Bank — на @20 от конца: меняется после каждой правки, поэтому за окном и
    // изменяемым хвостом. План остаётся вторым сообщением от конца, задание — последним. В коротком контексте
    // блок не встаёт перед системным промптом.
    // В коротком контексте Указ уже на месте — второй блок не ставим.
    const withNear = String(nearBanksText ?? '').trim()
        ? insertBlock(withDecree, String(nearBanksText).trim(), Math.max(1, withDecree.length - NEAR_BANKS_DEPTH))
        : withDecree;
    const prompt = [
        DIRECTOR_SYSTEM, settingsBlock, ...head, renderFrozenWindows(frozenWindows),
        String(plansText ?? '').trim(), rosterSection(roster), String(activeBanksText ?? '').trim(),
        usingWindow ? renderWindow(windowEntries) : `${renderCompressedDigests(digests)}\n${renderFullTurns(turns)}`,
        renderHistory(history), String(nearBanksText ?? '').trim(), String(decreeText ?? '').trim(), ...state, planContent, turnTask,
    ].filter(Boolean).join('\n\n');
    return { systemPrompt: DIRECTOR_SYSTEM, messages: withNear, prompt };
}

/**
 * Контекст прозаика: заметки о персонажах + история с блоком @5 + Push в
 * хвосте. Push идёт после истории, как написано во встроенном промпте.
 * `banksText` — полные банки активного ростера; `decreeText` — Указы всех
 * персонажей, прямо перед последним сообщением (Push): с ними писатель играет
 * персонажей.
 */
export function buildWriterContext({ notes = {}, summaries = [], chat = [], decision = '', writerBlock = '', banksText = '', examples = '', lorebookText = '', knowledgeText = '', sceneText = '', decreeText = '', storySettings = '', limit = RECENT_MESSAGE_LIMIT } = {}) {
    const history = writerHistory(chat, limit, writerBlock);
    // История прозаика — скользящее окно, поэтому кешируется только то, что стоит ДО неё: туда — редко меняющееся
    // (система, примеры, банки активных, саммари). Лорбук по ключам и заметки меняются почти каждый ход — они после
    // истории, рядом с Push, чтобы не обрывать кеш в начале запроса.
    const parts = [WRITER_SYSTEM, String(storySettings ?? '').trim(), String(examples ?? '').trim(), String(banksText ?? '').trim(), summariesSection(summaries)].filter(Boolean);
    const tail = [String(lorebookText ?? '').trim(), notesText(notes), String(knowledgeText ?? '').trim(), String(sceneText ?? '').trim(), String(decreeText ?? '').trim()].filter(Boolean);
    const push = String(decision ?? '').trim() ? fillPrompt(WRITER_INSCRIPTION, { inscription: String(decision).trim() }) : '';
    const messages = [
        ...parts.map(content => ({ role: 'system', content })),
        ...history,
        ...tail.map(content => ({ role: 'system', content })),
        ...(push ? [{ role: 'system', content: push }] : []),
    ];
    return { messages, prompt: [...parts, renderHistory(history), ...tail, push].filter(Boolean).join('\n\n') };
}
