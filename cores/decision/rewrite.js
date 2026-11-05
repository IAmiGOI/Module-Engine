import { buildWriterContext, selectRecentChat } from '../../libraries/core/decision-context.js';
import { lastAcceptedForm, renderCurrentScene } from '../../libraries/core/decision-scene.js';
import { buildWriterLorebook } from '../../libraries/core/decision-lorebook.js';
import { computeWriterPayload } from '../../libraries/core/decision-body.js';
import { assembleSectionFor } from './prompt-sections.js';
import { createWriterProxy } from './writer-proxy.js';
import { createWriterChecker } from './writer-check.js';
import { createKnowledge } from './knowledge.js';
import { buildStorySettingsBlock, resolveGameSettings } from '../../libraries/core/game-settings.js';
import { buildRollLine } from '../../libraries/core/decision-push.js';

/**
 * Тело запроса прозаика. Если у прозаика выбрано подключение ME, запрос
 * уходит туда целиком (writer-proxy) и ST получает готовый Response. Если
 * подключения нет — прежний путь: подменяем тело запроса ST, адрес и ключ
 * остаются ST.
 */
export function createWriterRewrite({ host, call, getSettings, getWorkers, store, getPending, getAssessments = null, banks = null, publishEvent = null }) {
    const writerProxy = createWriterProxy({ host, getSettings, getWorkers });
    const writerChecker = createWriterChecker({ call, getSettings, banks });
    const knowledge = createKnowledge({ call, store, banks });
    return async function rewrite(input = {}) {
        const payload = input.payload ?? input;
        const pending = getPending();
        if (!pending || !payload) return payload;
        const settings = getSettings();
        const summaries = (await call('summary.list')) ?? [];
        const writerId = String(settings.writer?.workerId ?? '').trim();
        const worker = writerId ? getWorkers().find(item => item.id === writerId) : null;
        const model = worker && worker.id !== 'st-main' ? String(worker.model ?? '') : '';
        const writerBlock = (await assembleSectionFor({ sectionId: 'writer', settings, chat: pending.chat, call, model })).messages;
        const bankText = banks ? banks.contextFor({ names: store.roster().active, all: false }).text : '';
        const examples = banks ? banks.examplesForCards() : '';
        const decision = pending.push ?? pending.decision;
        const lorebookText = await writerLorebookText(call, pending.chat, decision, banks);
        // Прозаику — знания только активных: чтобы персонаж в сцене не выдал того, чего не знает.
        const knowledgeText = await knowledge.textFor(store.roster().active);
        // Писателю — где закончился прошлый ответ: кто где стоит и кто ушёл, чтобы новый ответ начинался оттуда.
        const cycles = store.cycles?.() ?? [];
        const currentTurn = Number(cycles.find(cycle => cycle?.runId === pending.runId)?.turn);
        const sceneText = renderCurrentScene({ form: lastAcceptedForm(cycles, { beforeTurn: Number.isFinite(currentTurn) ? currentTurn : null }), roster: store.roster().active, user: banks?.persona?.()?.name || '' })
            .replace('CURRENT SCENE (where the previous turn left things — start from here):', 'WHERE THE PREVIOUS REPLY LEFT THINGS (start from here; the push says what happens next):')
            .split('\n').filter(line => !line.startsWith('- Left the scene in that ending:')).join('\n');
        // Show rolls — «In the chat»: писатель начинает ответ одной строкой броска.
        const game = resolveGameSettings(typeof store.gameSettings === 'function' ? store.gameSettings() : null, settings.gameDefaults);
        const rollLine = game.showRolls === 'chat' && typeof getAssessments === 'function'
            ? buildRollLine({ form: pending.form, assessments: getAssessments() })
            : '';
        const context = buildWriterContext({
            notes: store.notes(), summaries, chat: pending.chat, decision, writerBlock, banksText: bankText,
            examples, lorebookText, knowledgeText, sceneText, rollLine, storySettings: buildStorySettingsBlock('writer', game),
        });
        if (writerId && writerId !== 'st-main') {
            const own = await writerProxy.respond({
                payload, messages: context.messages, signal: input.signal,
                check: writerChecker, push: decision, userMessage: lastUserText(pending.chat),
                resolution: pending.form?.resolution ?? '', user: banks?.persona?.()?.name || 'the user',
                runId: pending.runId, publishEvent,
            });
            if (own) return own;
        }
        return computeWriterPayload(payload, context, { writer: settings.writer, model }) ?? payload;
    };
}

function lastUserText(chat) {
    const list = Array.isArray(chat) ? chat : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index]?.is_user === true) return String(list[index].mes ?? list[index].content ?? '').trim();
    }
    return '';
}

/** Лорбук прозаика как есть; ключи большой книги ищутся в его окне истории и в Push. Ошибка чтения не ломает ход. */
async function writerLorebookText(call, chat, decision, banks = null) {
    try {
        const books = await call('lorebook.books');
        if (!Array.isArray(books) || !books.length) return '';
        const scanText = [...selectRecentChat(chat ?? []).map(message => String(message?.mes ?? '')), String(decision ?? '')].join('\n');
        return buildWriterLorebook((await call('lorebook.entries')) ?? [], { scanText, marks: banks?.marksForLorebook() ?? null }).text;
    } catch { return ''; }
}
