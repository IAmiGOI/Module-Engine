/**
 * Сборка разделов промптов для Ядра директора: готовые факты, предзагрузка
 * значений трекера и макросов, сохранение кулдаунов, предпросмотр. Здесь
 * единственное место, где чистые библиотеки встречаются с контрактами.
 */
import { assemblePromptSection } from '../../libraries/core/decision-prompt-assemble.js';
import { systemLines } from '../../libraries/core/decision-prompt-model.js';
import { previewRows } from '../../libraries/core/decision-prompt-preview.js';
import { DIRECTOR_TURN, WRITER_INSCRIPTION } from '../../libraries/core/decision-prompts.js';
import { directorHistory, writerHistory, RECENT_MESSAGE_LIMIT } from '../../libraries/core/decision-context.js';
import { windowTurnCount } from '../../libraries/core/decision-window.js';
import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

const COOLDOWN_KEY = 'promptCooldowns';
const entryText = entry => String(entry?.mes ?? entry?.text ?? entry?.content ?? '');
const isUser = entry => entry?.is_user === true;

/** Значения макросов из чата: имена берутся у последних реплик, реплики — как есть. */
export function macroValues(chat, model = '') {
    const list = Array.isArray(chat) ? chat : [];
    const lastUser = [...list].reverse().find(isUser);
    const lastChar = [...list].reverse().find(entry => !isUser(entry) && entryText(entry).trim());
    const last = list.at(-1);
    return {
        user: String(lastUser?.name ?? ''), char: String(lastChar?.name ?? ''),
        lastMessage: entryText(last), lastChatMessage: entryText(last),
        lastUserMessage: entryText(lastUser), lastCharMessage: entryText(lastChar),
        input: entryText(lastUser), model: String(model ?? ''),
    };
}

/** Новые сообщения первыми — так условия читают «последние N». */
export function conditionMessages(chat) {
    return (Array.isArray(chat) ? chat : []).slice().reverse().map(entry => ({
        role: isUser(entry) ? 'user' : 'assistant', text: entryText(entry),
    }));
}

function collectTrackerKeys(nodes, out = new Map()) {
    const inCondition = condition => {
        if (!condition) return;
        if (condition.type === 'tracker' && condition.trackerId && condition.field) {
            out.set(`${condition.trackerId}:${condition.field}`, { trackerId: condition.trackerId, fieldName: condition.field });
        }
        if (condition.type === 'not') inCondition(condition.item);
        for (const item of condition.items ?? []) inCondition(item);
    };
    for (const node of nodes ?? []) {
        inCondition(node.condition);
        collectTrackerKeys(node.children ?? [], out);
    }
    return out;
}

async function trackerValues(call, section) {
    const keys = [...collectTrackerKeys(section?.tree ?? []).values()];
    const pairs = await Promise.all(keys.map(async key => {
        const value = await call('tracking.value', key);
        return [`${key.trackerId}:${key.fieldName}`, value];
    }));
    return new Map(pairs);
}

async function loadCooldowns(call) {
    const value = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: COOLDOWN_KEY, fallback: {} });
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Факты для условий и макросов. Ошибки источников не ломают ход: условия просто не срабатывают. */
export async function promptFacts({ section, chat, call, model = '' }) {
    const [trackers, macros, timed] = await Promise.all([
        trackerValues(call, section).catch(() => new Map()),
        call('macros.snapshot').then(value => (value && typeof value === 'object' ? value : {})).catch(() => ({})),
        loadCooldowns(call).catch(() => ({})),
    ]);
    return {
        values: macroValues(chat, model), macros, timed,
        tracker: (trackerId, field) => trackers.get(`${trackerId}:${field}`),
        messages: conditionMessages(chat), chatLength: Array.isArray(chat) ? chat.length : 0,
    };
}

export async function assembleSectionFor({ sectionId, settings, chat, call, model = '' }) {
    const section = settings?.promptSections?.[sectionId];
    if (!section) return { messages: [], text: '', report: [], unresolved: [], usedRandom: false };
    const facts = await promptFacts({ section, chat, call, model });
    const before = JSON.stringify(facts.timed);
    const block = assemblePromptSection(section, facts);
    if (JSON.stringify(facts.timed) !== before) {
        try {
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: COOLDOWN_KEY, value: facts.timed });
        } catch { /* the cooldown will simply fire again next turn */ }
    }
    return block;
}

/** Сколько сообщений истории останется до и после блока на его глубине. */
export function historyPlacement(chat, sectionId) {
    const sentinel = [{ role: 'system', content: '__decision_block__' }];
    const list = sectionId === 'director'
        ? directorHistory(chat, RECENT_MESSAGE_LIMIT, sentinel)
        : writerHistory(chat, RECENT_MESSAGE_LIMIT, sentinel);
    const index = list.findIndex(message => message.content === '__decision_block__');
    return { before: index < 0 ? 0 : index, after: index < 0 ? 0 : list.length - index - 1 };
}

function noteCount(notes) {
    return Object.values(notes ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function bankCount(bank) {
    return Object.values(bank ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

export async function previewSection({ input = {}, settings, call, store }) {
    const sectionId = input.section === 'writer' ? 'writer' : 'director';
    const chat = (await call('chatHistory.messages', { limit: 40 })) ?? [];
    return previewFor({ sectionId, settings, chat, call, store });
}

export async function previewFor({ sectionId, settings, chat, call, store }) {
    const block = await assembleSectionFor({ sectionId, settings, chat, call });
    const placement = historyPlacement(chat, sectionId);
    const summaries = await call('summary.list').catch(() => []);
    const summaryCount = Array.isArray(summaries) ? summaries.length : 0;
    const historyBefore = { label: 'History before the block', detail: `${placement.before} message${placement.before === 1 ? '' : 's'}` };
    const historyAfter = { label: 'History after the block', detail: `${placement.after} message${placement.after === 1 ? '' : 's'}` };
    const before = [];
    let tail = null;
    if (sectionId === 'director') {
        const lorebook = await call('lorebook.entries').catch(() => []);
        before.push(
            { label: 'Character banks', detail: `${bankCount(store.bank())} records in the prefix` },
            { label: 'Lorebook', detail: Array.isArray(lorebook) && lorebook.length ? `${lorebook.length} entries` : 'empty' },
            { label: 'Floating window', detail: `${windowTurnCount(store.window?.()?.entries ?? [])} cycles, append-only` },
            { label: 'Frozen window history', detail: `${(store.frozen?.() ?? []).length} summaries` },
            { label: 'Director plan', detail: store.plan() ? 'present' : 'missing — the director will have to create one' },
            { label: 'Arcs', detail: `${store.arcs().length}` },
            { label: 'Character notes and knowledge', detail: `${noteCount(store.notes())} notes` },
            { label: 'Active roster', detail: `${store.roster().active.length}` },
            { label: 'Library and plans', detail: `${Object.keys(store.library()).length} characters · ${store.plans().length} plans · ${bankCount(store.bank())} bank records` },
            historyBefore,
        );
        tail = { label: 'Turn task', detail: 'sent as the last user message' };
    } else {
        before.push({ label: 'Long-term summaries', detail: `${summaryCount}` }, { label: 'Character notes', detail: `${noteCount(store.notes())}` }, historyBefore);
        tail = { label: 'Push', detail: 'filled with the director decision' };
    }
    return previewRows({
        sectionId, systems: systemLines(sectionId), before, after: [historyAfter], block,
        tail: { ...tail, text: sectionId === 'director' ? DIRECTOR_TURN : WRITER_INSCRIPTION }, tree: settings?.promptSections?.[sectionId]?.tree ?? [],
    });
}
