import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildToolList } from '../../libraries/core/decision-tools.js';
import { staticDirectorLorebook } from '../../libraries/core/decision-lorebook-static.js';
import { deciderRequestParams, DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { libraryLevelsSection, longPlansSection } from '../../libraries/core/decision-library.js';
import { createBoundary, normalizeBoundary, windowTurnCount } from '../../libraries/core/decision-window.js';
import { renderChatBrief } from '../../libraries/core/decision-brief.js';
import { DIRECTOR_CONCRETE, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { estimateTokens } from '../../libraries/core/token-estimate.js';
import { assembleSectionFor } from './prompt-sections.js';
import { createKnowledge } from './knowledge.js';

/** Чужие инструменты, которые директору не отдаются: Secrets директор не использует (решение владельца — отключить). */
const DIRECTOR_EXCLUDED_TOOLS = new Set(['Secrets']);

/** Контекст и запрос директора — вынесено из цикла, чтобы файл цикла оставался циклом. */

export function fallbackDecision(form) {
    const lines = (Array.isArray(form?.characters) ? form.characters : [])
        .filter(character => String(character?.action ?? '').trim())
        .map(character => `${character.name}: ${character.action}`);
    return [String(form?.resolution ?? '').trim(), ...lines].filter(Boolean).join('\n') || 'The turn is decided.';
}

export function wakeFor({ type, label, detail, ...rest }) {
    return { type, label, ...(detail ? { detail } : {}), ...rest };
}

export function turnWake(type) {
    if (type === 'normal') return wakeFor({ type: 'turn', label: 'A new turn has started' });
    return wakeFor({ type, label: `The director runs again (${type})` });
}

export function createCycleContext({ call, store, banks = null, capture = null }) {
    const knowledge = createKnowledge({ call, store, banks });
    async function externalTools() {
        try {
            const tools = await call('generation.tools');
            return Array.isArray(tools) ? tools.filter(tool => !DIRECTOR_EXCLUDED_TOOLS.has(String(tool?.name ?? ''))) : [];
        } catch { return []; }
    }

    /** Пользовательский блок директора — тот же, что раньше брался из `prompts.director`, но собранный из раздела. */
    async function directorBlockFor(settings, chat, worker) {
        const block = await assembleSectionFor({ sectionId: 'director', settings, chat, call, model: worker.model });
        return block.messages;
    }

    /**
     * Лорбук — только директору и статичный: снимок книги берётся один раз и
     * меняется только при переключении окна (`windowBoundary`/сброс снимка).
     * Изменений отдельным блоком больше нет — правки пользователя ждут
     * переключения. Ошибка чтения не ломает ход.
     */
    const LOREBOOK_SNAPSHOT_KEY = 'lorebookSnapshot';
    async function lorebookTextFor(enabled) {
        if (!enabled) return '';
        try {
            const books = await call('lorebook.books');
            if (!Array.isArray(books) || !books.length) return '';
            const saved = await call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: LOREBOOK_SNAPSHOT_KEY, fallback: null });
            const result = staticDirectorLorebook(saved, (await call('lorebook.entries')) ?? [], { marks: banks?.marksForLorebook() ?? null, refreshTokens: Infinity });
            if (result.refreshed) await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: LOREBOOK_SNAPSHOT_KEY, value: result.snapshot });
            return result.head;
        } catch { return ''; }
    }

    /** Граница окна: блоки 4, 6, 7 и 8. Нет сохранённой — снимается один раз и живёт до переключения. */
    async function ensureBoundary() {
        const saved = typeof store.boundary === 'function' ? normalizeBoundary(store.boundary()) : null;
        if (saved) return saved;
        const roster = store.roster().active;
        const fresh = createBoundary({
            roster,
            libraryText: libraryLevelsSection(store.library()),
            plansText: longPlansSection(store.plans(), store.clock().minutes),
            activeBanksText: banks ? banks.contextFor({ names: roster, all: false }).text : '',
            chatBriefText: renderChatBrief(typeof store.chatBrief === 'function' ? store.chatBrief() : null),
            at: Date.now(),
        });
        if (typeof store.saveBoundary === 'function') await store.saveBoundary(fresh);
        return fresh;
    }

    function sceneText(chat) {
        return (Array.isArray(chat) ? chat : [])
            .filter(entry => !entry?.is_system)
            .slice(-8)
            .map(entry => `${entry?.is_user ? 'User' : (entry?.name || 'Character')}: ${String(entry?.mes ?? entry?.content ?? '').trim()}`)
            .filter(Boolean)
            .join('\n');
    }

    function lastUserText(chat) {
        const list = Array.isArray(chat) ? chat : [];
        for (let index = list.length - 1; index >= 0; index -= 1) {
            if (list[index]?.is_user === true) return String(list[index].mes ?? list[index].content ?? '').trim();
        }
        return '';
    }

    /** Текущее сообщение пользователя — последняя (ещё не сохранённая) запись окна. */
    function pendingTurn(entries, currentUser, reroll = false) {
        const body = String(currentUser ?? '').trim();
        if (!body) return [];
        const turn = windowTurnCount(entries) + 1;
        const head = reroll ? `TURN ${turn} — REROLL: your earlier version of this turn was discarded, none of it happened` : `TURN ${turn} (compressed)`;
        return [{ kind: 'turn', turn, at: Date.now(), text: `${head}\nUser: ${body}` }];
    }

    // Переигровка: отброшенная версия хода и всё, что легло после неё, в окно директора не попадают —
    // иначе он видел ход случившимся и следом то же сообщение «новым ходом».
    // Убирается, только если последний ход — это ход с тем же сообщением пользователя: прошлая попытка могла
    // упасть и не записаться, и тогда последний ход в окне — настоящий предыдущий.
    function withoutRejectedTurn(entries, currentUser) {
        const last = entries.map((entry, index) => (entry.kind === 'turn' ? index : -1)).filter(index => index >= 0).at(-1);
        if (last === undefined) return entries;
        const body = String(currentUser ?? '').trim();
        const userLine = String(entries[last].text ?? '').split('\n').find(line => line.startsWith('User: ')) ?? '';
        const firstLine = body.split('\n').map(line => line.trim()).find(Boolean) ?? '';
        const sameMessage = Boolean(firstLine) && userLine.slice('User: '.length).trim().startsWith(firstLine.slice(0, 120));
        return sameMessage ? entries.slice(0, last) : entries;
    }

    function buildContext({ task = '', lorebookText = '', knowledgeText = '', directorBlock = [], banksText = '', boundary = null, currentUser = '', reroll = false }) {
        const safe = boundary ?? { roster: [], libraryText: '', plansText: '', activeBanksText: '', chatBriefText: '' };
        const win = typeof store.window === 'function' ? store.window() : null;
        const all = Array.isArray(win?.entries) ? win.entries : [];
        const entries = reroll ? withoutRejectedTurn(all, currentUser) : all;
        return buildDeciderContext({
            plan: store.plan(), arcs: store.arcs(), notes: store.notes(),
            libraryText: safe.libraryText, plansText: safe.plansText, roster: safe.roster, activeBanksText: safe.activeBanksText,
            chatBriefText: safe.chatBriefText ?? '', planMissing: !store.plan(), directorBlock, lorebookText, knowledgeText, banksText, task,
            windowEntries: [...entries, ...pendingTurn(entries, currentUser, reroll)],
            frozenWindows: typeof store.frozen === 'function' ? store.frozen() : [],
            windowMode: true,
        });
    }

    async function runContext({ settings, chat = [], task = '', lorebook = true, worker, reroll = false }) {
        const [lorebookText, directorBlock, knowledgeText, boundary] = await Promise.all([
            lorebookTextFor(lorebook), directorBlockFor(settings, chat ?? [], worker), knowledge.textFor(null), ensureBoundary(),
        ]);
        const banksText = banks ? banks.contextFor({ all: true }).text : '';
        return buildContext({ task, lorebookText, knowledgeText, directorBlock, banksText, boundary, currentUser: lastUserText(chat), reroll });
    }

    /**
     * `thinkLimit` (токены) — размышление дошло до лимита: запрос обрывается и уходит заново с хвостом размышления
     * и требованием конкретики (PROMPTS §21). Обрыв — один на шаг: повтор думает без лимита, иначе ход не дойдёт до формы.
     */
    function generateFor({ settings, worker, runId, prefix, startedAt, effort = null, signal = null, thinkLimit = 0, onCut = () => {} }) {
        let modelCall = 0;
        return async ({ messages, tools, toolChoice, returnMessage, boost = 1 }) => {
            modelCall += 1;
            const params = deciderRequestParams(settings.decider, { floor: prefix !== '' });
            if (boost > 1 && Number.isFinite(params.maxTokens)) params.maxTokens = Math.min(32768, Math.round(params.maxTokens * boost));
            const request = (requestId, list, requestSignal) => call('model.generate', {
                requestId, ...params,
                ...(effort ? { reasoningEffort: effort } : {}),
                workerId: worker.id,
                messages: list, tools, toolChoice, stream: true, returnMessage,
                ...(requestSignal ? { signal: requestSignal } : {}),
            });
            const requestId = `${runId}:${prefix}${modelCall}:${startedAt}`;
            if (!(thinkLimit > 0) || typeof capture !== 'function') return normalizeGenerateAnswer(await request(requestId, messages, signal));

            const local = new AbortController();
            const forward = () => local.abort(signal?.reason);
            if (signal?.aborted) forward(); else signal?.addEventListener?.('abort', forward, { once: true });
            let cutText = '';
            const watch = capture(requestId, {
                onThinking: text => {
                    if (cutText || estimateTokens(text) < thinkLimit) return;
                    cutText = String(text);
                    local.abort(new Error('thinking limit'));
                },
            });
            try {
                return normalizeGenerateAnswer(await request(requestId, messages, local.signal));
            } catch (error) {
                if (!cutText || signal?.aborted) throw error;
            } finally {
                watch?.stop?.();
                signal?.removeEventListener?.('abort', forward);
            }
            onCut({ tokens: estimateTokens(cutText) });
            const tail = cutText.length > 4000 ? `…${cutText.slice(-4000)}` : cutText;
            const pushed = [...messages, { role: 'user', content: fillPrompt(DIRECTOR_CONCRETE, { thinking: tail }) }];
            return normalizeGenerateAnswer(await request(`${requestId}:c`, pushed, signal));
        };
    }

    async function toolsFor(settings, { background = false, filter = null } = {}) {
        return buildToolList(await externalTools()).filter(tool => {
            if (filter && !filter.includes(tool.name)) return false;
            if (background && tool.name === 'submit_turn') return false;
            if (!settings.turnDraft && tool.name === 'save_draft') return false;
            return true;
        });
    }

    return { buildContext, runContext, generateFor, toolsFor, sceneText };
}
