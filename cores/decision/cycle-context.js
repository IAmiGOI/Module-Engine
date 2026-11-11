import { buildDeciderContext } from '../../libraries/core/decision-context.js';
import { normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildToolList, buildTurnToolList } from '../../libraries/core/decision-tools.js';
import { TURN_TOOLS } from '../../libraries/core/decision-agent.js';
import { staticDirectorLorebook } from '../../libraries/core/decision-lorebook-static.js';
import { deciderRequestParams, DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { libraryLevelsSection, longPlansSection } from '../../libraries/core/decision-library.js';
import { createBoundary, normalizeBoundary, lastTurnNumber, BOUNDARY_BANKS_FORMAT } from '../../libraries/core/decision-window.js';
import { renderChatBrief } from '../../libraries/core/decision-brief.js';
import { DIRECTOR_CONCRETE, DIRECTOR_TURN, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { estimateTokens } from '../../libraries/core/token-estimate.js';
import { buildStorySettingsBlock, resolveGameSettings } from '../../libraries/core/game-settings.js';
import { lastAcceptedForm, renderAlreadySaid, renderCurrentScene, renderHiddenTruth, lastActedTurns } from '../../libraries/core/decision-scene.js';
import { assembleSectionFor } from './prompt-sections.js';
import { createKnowledge } from './knowledge.js';
import { createRetryRunner } from './retry.js';

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

export function createCycleContext({ call, store, banks = null, creation = null, capture = null, getGameSettings = null, getSettings = () => ({}), publishEvent = () => {} }) {
    const knowledge = createKnowledge({ call, store, banks });
    const retry = createRetryRunner({ publishEvent, getSettings });
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

    /**
     * Граница окна: блоки 4, 6, 7 и 8. Нет сохранённой — снимается один раз и
     * живёт до переключения. Дальняя компактная проекция Great Bank снимается
     * здесь же: она меняется только на сломе контекста, и кеш верха цел.
     */
    async function ensureBoundary() {
        const saved = typeof store.boundary === 'function' ? normalizeBoundary(store.boundary()) : null;
        // Граница прежнего формата (карточки вместо разделов) переснимается один раз: иначе компактной проекции не будет.
        if (saved && saved.banks === BOUNDARY_BANKS_FORMAT) return saved;
        const roster = store.roster().active;
        const fresh = createBoundary({
            roster,
            libraryText: libraryLevelsSection(store.library()),
            plansText: longPlansSection(store.plans(), store.clock().minutes),
            activeBanksText: banks ? await banks.farContext().catch(() => '') : '',
            chatBriefText: renderChatBrief(typeof store.chatBrief === 'function' ? store.chatBrief() : null),
            banks: BOUNDARY_BANKS_FORMAT,
            at: Date.now(),
        });
        if (typeof store.saveBoundary === 'function') await store.saveBoundary(fresh);
        return fresh;
    }

    /**
     * Контекст резолвера: дальняя компактная проекция — в границе окна, Указ действующих — на @10,
     * ближней полной проекции у него нет (она директора). Пока Great Bank не собран, строки нет.
     */
    async function decreeTextFor() {
        if (!banks?.decreeFor) return '';
        // Пустой ростер (первый ход): персонаж входит в сцену этим же ходом — Указы всех, у кого они есть.
        const active = store.roster().active ?? [];
        return banks.decreeFor(active.length ? active : null).catch(() => '');
    }

    /**
     * Мироздание (фаза 5) — стабильная часть контекста резолвера, рядом с
     * дальними банками: снимок Creation, обновляется только на переключении
     * окна. Открытия между снимками идут коротким блоком у задания.
     */
    async function creationTextFor() {
        if (!creation?.resolverText) return '';
        return creation.resolverText().catch(() => '');
    }

    function creationDiscoveries() {
        if (!creation?.discoveries) return '';
        try { return creation.discoveries(); } catch { return ''; }
    }

    /**
     * Телеграмма из закрытого списка ставит флаг «ход ждёт Указа». Само ожидание включится в фазе 4;
     * здесь флаг только доходит до резолвера строкой, чтобы он знал, почему сцена не идёт дальше.
     */
    function decreeWaitText() {
        const papers = typeof store.papers === 'function' ? store.papers() : null;
        const waiting = papers?.awaitingDecree;
        if (!waiting?.why) return '';
        return `AWAITING A DECREE — a telegram said: ${String(waiting.why).trim()}. No decree plan is issued yet (phase 4): hold the scene where it is and do not move the urgent matter further.`;
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
    function pendingTurn(entries, currentUser, reroll = false, number = null) {
        const body = String(currentUser ?? '').trim();
        if (!body) return [];
        const turn = Number.isFinite(Number(number)) && Number(number) > 0 ? Number(number) : lastTurnNumber(entries) + 1;
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
        if (!sameMessage) return entries;
        // Уходит только сам отброшенный ход и факты его цикла (они идут сразу за ним). Сообщения директору и фоновые
        // циклы после него остаются: так пропадал редкон, написанный директору между ходом и его переигровкой.
        let end = last + 1;
        while (end < entries.length && entries[end].kind === 'fact') end += 1;
        return [...entries.slice(0, last), ...entries.slice(end)];
    }

    // Переигровка: «что сейчас» — по ходу ДО отброшенного (сам отброшенный в журнале помечен rejected после свайпа).
    function currentSceneText({ beforeTurn = null } = {}) {
        const cycles = typeof store.cycles === 'function' ? store.cycles() : [];
        const user = String(banks?.persona?.()?.name ?? '').trim();
        const scene = renderCurrentScene({
            form: lastAcceptedForm(cycles, { beforeTurn }),
            roster: typeof store.roster === 'function' ? store.roster().active ?? [] : [],
            user, lastActed: lastActedTurns(cycles), turn: beforeTurn,
        });
        // Сказанное — сразу за сценой, у самого задания: следующий шаг героя сверяется со списком, а не с памятью модели.
        return [scene, renderHiddenTruth(cycles, { beforeTurn, user }), renderAlreadySaid(cycles, { beforeTurn, user })].filter(Boolean).join('\n\n');
    }

    /** Настройки игры этого чата: без них — Classic. Блок меняется только при смене настроек. */
    function storySettingsText(settings = null) {
        const game = typeof getGameSettings === 'function'
            ? getGameSettings()
            : resolveGameSettings(typeof store.gameSettings === 'function' ? store.gameSettings() : null, settings?.gameDefaults ?? null);
        return buildStorySettingsBlock('director', game);
    }

    function buildContext({ task = '', lorebookText = '', knowledgeText = '', directorBlock = [], banksText = '', boundary = null, currentUser = '', reroll = false, storySettings = '', turn = null, nearBanks = '', decreeText = '', creationText = '', decreeWait = '' }) {
        const safe = boundary ?? { roster: [], libraryText: '', plansText: '', activeBanksText: '', chatBriefText: '' };
        const win = typeof store.window === 'function' ? store.window() : null;
        const all = Array.isArray(win?.entries) ? win.entries : [];
        const entries = reroll ? withoutRejectedTurn(all, currentUser) : all;
        return buildDeciderContext({
            plan: store.plan(), arcs: store.arcs(), notes: store.notes(), storySettings,
            libraryText: safe.libraryText, plansText: safe.plansText, roster: safe.roster, activeBanksText: safe.activeBanksText,
            chatBriefText: safe.chatBriefText ?? '', planMissing: !store.plan(), directorBlock, lorebookText, knowledgeText, banksText, task,
            nearBanksText: nearBanks, decreeText, creationText, decreeWait, resolverTurn: true,
            windowEntries: [...entries, ...pendingTurn(entries, currentUser, reroll, turn)],
            sceneText: currentSceneText({ beforeTurn: reroll && entries.length < all.length ? Number(all.filter(entry => entry.kind === 'turn').at(-1)?.turn) : null }),
            frozenWindows: typeof store.frozen === 'function' ? store.frozen() : [],
            windowMode: true,
        });
    }

    async function runContext({ settings, chat = [], task = '', lorebook = true, worker, reroll = false, turn = null, scalesHint = '' }) {
        const [lorebookText, directorBlock, knowledgeText, boundary, decree, creationText] = await Promise.all([
            lorebookTextFor(lorebook), directorBlockFor(settings, chat ?? [], worker), knowledge.textFor(null), ensureBoundary(), decreeTextFor(), creationTextFor(),
        ]);
        // Резолверу — дальняя компактная проекция (в границе окна) и Указ действующих на @10. Ближняя полная проекция
        // здесь не нужна: она директора. Creation — в стабильной части; новые открытия и карточки затронутых систем — в хвосте задания.
        const discoveries = creationDiscoveries();
        // Хвост подсказки не должен подменять собой шаблон хода: без режимов и переигровки задание приходит пустым.
        const base = String(task ?? '').trim() || (String(scalesHint ?? '').trim() ? DIRECTOR_TURN : '');
        return buildContext({
            task: [base, discoveries, String(scalesHint ?? '').trim()].filter(Boolean).join('\n\n'),
            lorebookText, knowledgeText, directorBlock, boundary, decreeText: decree, creationText,
            currentUser: lastUserText(chat), reroll, turn, storySettings: storySettingsText(settings), decreeWait: decreeWaitText(),
        });
    }

    /**
     * `thinkLimit` (токены) — размышление дошло до лимита: запрос обрывается и уходит заново с хвостом размышления
     * и требованием конкретики (PROMPTS §21). Обрыв — один на шаг: повтор думает без лимита, иначе ход не дойдёт до формы.
     */
    function generateFor({ settings, worker, runId, prefix, startedAt, effort = null, signal = null, thinkLimit = 0, onCut = () => {}, budget = null }) {
        let modelCall = 0;
        const send = ({ list, tools, toolChoice, returnMessage, requestSignal, boost = 1, lowerReasoning = false, backupWorkerId = '', tag = '' }) => {
            modelCall += 1;
            const params = deciderRequestParams(settings.decider, { floor: prefix !== '' });
            if (boost > 1 && Number.isFinite(params.maxTokens)) params.maxTokens = Math.min(32768, Math.round(params.maxTokens * boost));
            const baseId = `${runId}:${prefix}${modelCall}:${startedAt}`;
            return call('model.generate', {
                requestId: tag === 'cut' ? `${baseId}:c` : baseId, ...params,
                // Ризонинг ниже на повторе пустого ответа: он и съел лимит.
                ...(lowerReasoning ? { reasoningEffort: 'low' } : (effort ? { reasoningEffort: effort } : {})),
                workerId: backupWorkerId || worker.id,
                messages: list, tools, toolChoice, stream: true, returnMessage,
                ...(requestSignal ? { signal: requestSignal } : {}),
            });
        };
        const run = ({ list, tools, toolChoice, returnMessage, requestSignal, tag = '' }) => retry.run({
            role: 'resolver', budget: budget ?? 'turn', signal: requestSignal, normalize: normalizeGenerateAnswer,
            request: options => send({ list, tools, toolChoice, returnMessage, requestSignal, tag, ...options }),
        });
        return async ({ messages, tools, toolChoice, returnMessage }) => {
            if (!(thinkLimit > 0) || typeof capture !== 'function') {
                return run({ list: messages, tools, toolChoice, returnMessage, requestSignal: signal });
            }

            const local = new AbortController();
            const forward = () => local.abort(signal?.reason);
            if (signal?.aborted) forward(); else signal?.addEventListener?.('abort', forward, { once: true });
            let cutText = '';
            const watch = capture(`${runId}:${prefix}${modelCall + 1}:${startedAt}`, {
                onThinking: text => {
                    if (cutText || estimateTokens(text) < thinkLimit) return;
                    cutText = String(text);
                    local.abort(new Error('thinking limit'));
                },
            });
            try {
                return await run({ list: messages, tools, toolChoice, returnMessage, requestSignal: local.signal });
            } catch (error) {
                if (!cutText || signal?.aborted) throw error;
                if (error && typeof error === 'object') error.code = error.code ?? 'thinking-cut';
            } finally {
                watch?.stop?.();
                signal?.removeEventListener?.('abort', forward);
            }
            onCut({ tokens: estimateTokens(cutText) });
            const tail = cutText.length > 4000 ? `…${cutText.slice(-4000)}` : cutText;
            const pushed = [...messages, { role: 'user', content: fillPrompt(DIRECTOR_CONCRETE, { thinking: tail }) }];
            return run({ list: pushed, tools, toolChoice, returnMessage, requestSignal: signal, tag: 'cut' });
        };
    }

    async function toolsFor(settings, { background = false, filter = null, turn = false } = {}) {
        // Ход резолвера — один шаблон и assess: фоновые циклы берут полный набор без шаблона,
        // ход — только `assess` и `inscribe` (планы и записи на ходу закрыты).
        if (turn) return buildTurnToolList();
        return buildToolList(await externalTools()).filter(tool => {
            if (filter && !filter.includes(tool.name)) return false;
            if (background && TURN_TOOLS.includes(tool.name)) return false;
            if (!settings.turnDraft && tool.name === 'save_draft') return false;
            return true;
        });
    }

    return { buildContext, runContext, generateFor, toolsFor, sceneText };
}
