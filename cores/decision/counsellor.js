import { isUserCharacter, USER_CHARACTER_NOTE } from '../../libraries/core/decision-great-bank.js';
import { writtenBanks } from '../../libraries/core/decision-director.js';
import { rpNow } from '../../libraries/core/decision-scene.js';
import { promptText } from '../../libraries/core/prompt-overrides.js';
import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildCounsellorToolList, COUNSELLOR_STOP_TOOLS } from '../../libraries/core/decision-tools.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { roleRequestParams, counsellorWorkerId } from '../../libraries/core/decision-settings.js';
import { ledgerLines } from '../../libraries/core/decision-ledger.js';
import { libraryLevelsSection } from '../../libraries/core/decision-library.js';
import {
    COUNSELLOR_SYSTEM, COUNSELLOR_REVIEW, COUNSELLOR_DAY, COUNSELLOR_MESSAGE, COUNSELLOR_GOD, COUNSELLOR_STATUS,
    LEDGER_HEADER, DECREE_HEADER, QUEUES_HEADER, COUNSELLOR_CHAT_HEADER, RP_TIME_HEADER,
    NO_NEW_LEDGER, NO_DECREE_YET, GOD_ASKS_HEADER, WRITTEN_BANKS_HEADER, fillPrompt,
} from '../../libraries/core/decision-prompts.js';
import {
    dayOf, dayChanged, shouldReview, makePetition, ensureDayPetitions, decreeNames,
    renderQueues, renderConversation, queueSummary, strongStreaks,
} from '../../libraries/core/decision-counsellor.js';
import { openGodQuestions, renderGodQuestions } from '../../libraries/core/decision-god-queue.js';
import { createCycleLive } from './live.js';
import { createRetryRunner } from './retry.js';

/**
 * Советник (фаза 3): читает Ведомость резолвера, пишет Petition директору и
 * Prayer Богу, отвечает пользователю. Своё подключение (по умолчанию —
 * подключение резолвера), свой короткий контекст и своя очередь пробуждений
 * (каждые N ходов и конец RP-дня).
 */

export class CounsellorConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CounsellorConfigError';
        this.code = 'decision-config';
    }
}

const OPENAI_FORMAT = 'openai';
const text = value => String(value ?? '').trim();

function clockLabel(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    return `Day ${dayOf(total) + 1}, ${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Разговор с пользователем (сообщение или вопросы Бога) — без Ведомости и без отметки разбора. */
const talk = mode => mode === 'message' || mode === 'god' || mode === 'status';

export function createCounsellor({ call, callTool, store, banks = null, getSettings, getWorkers, publishEvent, capture = null, enqueue = job => job(), now = () => Date.now() }) {
    const live = createCycleLive({ publishEvent, getTurn: () => currentTurn(), getClock: () => store.clock().minutes });
    const retry = createRetryRunner({ publishEvent, getSettings });

    function currentTurn() {
        const entries = typeof store.window === 'function' ? store.window()?.entries ?? [] : [];
        const turns = (Array.isArray(entries) ? entries : []).filter(entry => entry.kind === 'turn');
        if (turns.length) return Number(turns.at(-1).turn) || 0;
        const cycles = typeof store.cycles === 'function' ? store.cycles() : [];
        return Math.max(0, ...(Array.isArray(cycles) ? cycles : [])
            .filter(cycle => ['turn', 'regenerate', 'swipe'].includes(cycle?.event) && !cycle?.rejected && cycle?.form)
            .map(cycle => Number(cycle.turn) || 0));
    }

    function workerFor(settings) {
        const id = counsellorWorkerId(settings);
        if (!id) throw new CounsellorConfigError('Decision core: no Counsellor connection is configured — choose the resolver connection in the Director / Writer card.');
        const worker = (getWorkers() ?? []).find(item => item.id === id);
        if (!worker) throw new CounsellorConfigError(`Decision core: the Counsellor connection "${id}" is not available — choose an existing connection in the Director / Writer card.`);
        if (worker.format !== OPENAI_FORMAT) throw new CounsellorConfigError(`Decision core: the Counsellor needs an "openai" worker with tools; "${worker.id}" is "${worker.format}".`);
        return worker;
    }

    /** Указы: имена персонажей с заполненным полем и текст только по ним. */
    async function decreeText() {
        if (!banks?.decreeFor) return NO_DECREE_YET;
        let names = [];
        try { names = decreeNames(await banks.great?.load?.()); } catch { names = []; }
        if (!names.length) return NO_DECREE_YET;
        return banks.decreeFor(names).catch(() => NO_DECREE_YET);
    }

    /** Контекст Советника: Ведомость с прошлого разбора, уровни, Указы, очереди, RP-время. Истории чата нет. */
    async function contextFor({ mode, text: message = '' }) {
        const rows = talk(mode) ? [] : (typeof store.unreviewedLedger === 'function' ? store.unreviewedLedger() : []);
        const body = ledgerLines(rows);
        // Два strong подряд считаются по всей Ведомости: прошлую строку Советник мог уже разобрать в прошлый раз.
        const streaks = talk(mode) ? [] : strongStreaks(typeof store.ledger === 'function' ? store.ledger() : rows);
        const openQuestions = openGodQuestions(typeof store.god === 'function' ? (store.god()?.questions ?? []) : []);
        const messages = [{ role: 'system', content: promptText(COUNSELLOR_SYSTEM) }];
        // Разговор с пользователем не тащит Ведомость: у него свой короткий контекст (c4).
        if (!talk(mode)) {
            messages.push({ role: 'system', content: `${LEDGER_HEADER}\n\n${body || NO_NEW_LEDGER}${streaks.length ? `\n\nStrong conflict two turns in a row: ${streaks.join(', ')}.` : ''}` });
        }
        // Вопросы Бога — в любом разборе: ответить можно, пока не закрыты все.
        if (openQuestions.length) {
            messages.push({ role: 'system', content: `${GOD_ASKS_HEADER}\n\n${renderGodQuestions(openQuestions)}` });
        }
        // У кого банк написан — данные Советнику; к кому идёт история, он видит по Ведомости и решает сам.
        const written = talk(mode) || !banks?.great?.load ? null : writtenBanks(await banks.great.load().catch(() => ({})));
        if (written) messages.push({ role: 'system', content: `${WRITTEN_BANKS_HEADER}\n${written.length ? written.map(name => `- ${name}`).join('\n') : '- nobody yet'}` });
        messages.push(
            { role: 'system', content: `${DECREE_HEADER}\n\n${libraryLevelsSection(store.library()) || 'CHARACTER LIBRARY: no levels yet.'}\n\n${await decreeText()}` },
            { role: 'system', content: `${RP_TIME_HEADER} ${rpNow(store, clockLabel)}` },
        );
        if (talk(mode)) {
            messages.push(
                { role: 'system', content: `${QUEUES_HEADER}\n\n${renderQueues({ petitions: store.petitions?.() ?? [], prayers: store.prayers?.() ?? [] })}` },
                { role: 'system', content: `${COUNSELLOR_CHAT_HEADER}\n\n${renderConversation(store.conversation?.() ?? [])}` },
            );
        }
        const task = mode === 'day'
            ? COUNSELLOR_DAY
            : mode === 'god'
                ? COUNSELLOR_GOD
                : mode === 'status'
                    ? fillPrompt(COUNSELLOR_STATUS, { report: message })
                : mode === 'message'
                    ? fillPrompt(COUNSELLOR_MESSAGE, { message })
                : fillPrompt(COUNSELLOR_REVIEW, { turns: Math.max(1, currentTurn() - (store.counsellor?.().lastReviewTurn ?? 0)) });
        messages.push({ role: 'user', content: task });
        return messages;
    }

    /** Имя — персонаж пользователя (персона)? По имени, псевдониму или первому слову полного имени. */
    async function isUserName(name) {
        const wanted = text(name).toLowerCase();
        if (!wanted) return false;
        const state = await banks?.great?.load?.().catch(() => null);
        return Object.values(state ?? {}).filter(isUserCharacter).some(character => [character.name, ...(character.aliases ?? [])]
            .map(value => text(value).toLowerCase()).filter(Boolean).some(value => value === wanted || wanted.split(/\s+/)[0] === value));
    }

    function handlersFor({ state, turn }) {
        return {
            petition: async args => {
                // Персонаж пользователя не повышается: Директор обещал в форме положение, движок отказывал, await не пускал.
                const userCharacter = args?.promote ? await isUserName(args.character) : false;
                const petition = makePetition({ ...args, ...(userCharacter ? { promote: null } : {}), turn, at: now(), day: state.day });
                if (!petition) return { ok: false, error: 'A petition needs a character and a problem.' };
                await store.addPetition(petition);
                state.petitioned.add(petition.character.toLowerCase());
                state.decided = true;
                publishEvent('decision.counsellor.petition', { character: petition.character, promote: petition.promote?.level ?? null, day: petition.day });
                return { ok: true, id: petition.id, status: petition.status, ...(userCharacter ? { note: `${petition.character} ${USER_CHARACTER_NOTE} The promotion was dropped; the rest of the Petition stands.` } : {}) };
            },
            nothing_yet: async args => {
                state.decided = true;
                state.nothing = text(args.reason);
                publishEvent('decision.counsellor.nothing', { reason: state.nothing });
                return { ok: true, status: 'nothing' };
            },
            reply: async args => {
                const body = text(args.text);
                if (!body) return { ok: false, error: 'A reply needs text.' };
                await store.addConversation({ role: 'counsellor', text: body, at: now() });
                state.reply = body;
                publishEvent('decision.counsellor.reply', { text: body });
                return { ok: true };
            },
            prayer: async args => {
                const body = text(args.text);
                if (!body) return { ok: false, error: 'A prayer needs text.' };
                await store.addPrayer({ at: now(), turn, text: body, source: 'counsellor', status: 'queued' });
                state.prayers += 1;
                publishEvent('decision.counsellor.prayer', { text: body });
                return { ok: true, status: 'queued' };
            },
            god_answer: async args => {
                const answer = text(args.answer);
                if (!answer) return { ok: false, error: 'An answer to God needs text.' };
                if (typeof store.answerGod !== 'function') return { ok: false, error: 'God is not available.' };
                const result = await store.answerGod({ id: text(args.id), answer, at: now() });
                state.decided = true;
                state.godAnswers = (state.godAnswers ?? 0) + 1;
                publishEvent('decision.counsellor.god_answer', { id: text(args.id), answer, closed: Boolean(result?.closed) });
                return { ok: true, closed: Boolean(result?.closed), declaration: Boolean(result?.declaration) };
            },
            await: args => ({ ok: true, reason: text(args.reason) }),
        };
    }

    /** Разбор Ведомости, конец дня или ответ пользователю. Возвращает сводку, не бросая на сбое модели. */
    async function run({ runId, mode = 'review', text: message = '' } = {}) {
        const settings = getSettings();
        const turn = currentTurn();
        const startedAt = now();
        const event = mode === 'day' ? 'counsellor_day' : 'counsellor';
        const labels = { review: 'The Counsellor read the Ledger', day: 'The Counsellor closes the RP day', message: 'The Counsellor answers the user', god: 'The Counsellor puts God\'s questions to the user', status: 'The Counsellor tells the user what was done' };
        const state = { petitioned: new Set(), decided: false, nothing: '', reply: '', prayers: 0, day: mode === 'day' };
        let worker;
        try { worker = workerFor(settings); } catch (error) {
            live.failed({ runId, message: error.message });
            throw error;
        }
        const wake = { type: event, label: labels[mode] ?? labels.review };
        live.started({ runId, event, wake, at: startedAt });
        const captured = typeof capture === 'function' ? capture(`${runId}:`, { onThinking: value => publishEvent('decision.cycle.thinking', { runId, text: value }) }) : null;
        const messages = await contextFor({ mode, text: message });
        const contextLength = messages.length;
        const generation = roleRequestParams(settings, 'counsellor');
        let modelCall = 0;
        const generate = async ({ messages: list, tools, toolChoice, returnMessage }) => retry.run({
            role: 'counsellor', budget: 'background', normalize: normalizeGenerateAnswer,
            request: async ({ boost, lowerReasoning, backupWorkerId }) => {
                modelCall += 1;
                const params = { ...generation, ...(boost > 1 && Number.isFinite(generation.maxTokens) ? { maxTokens: Math.min(32768, Math.round(generation.maxTokens * boost)) } : {}) };
                if (lowerReasoning) params.reasoningEffort = 'low';
                const requestId = `${runId}:${modelCall}:${startedAt}`;
                return call('model.generate', { purpose: 'counsellor',
                    requestId, ...params, workerId: backupWorkerId || worker.id, messages: list, tools, toolChoice, stream: true, returnMessage,
                });
            },
        });
        let result;
        try {
            result = await runDecisionCycle({
                messages,
                tools: buildCounsellorToolList(),
                generate,
                handlers: handlersFor({ state, turn }),
                callTool,
                maxSteps: Math.max(1, Number(settings.counsellor?.maxSteps) || 12),
                implicitAwait: true,
                emptyRetry: false,
                stopAfter: [...COUNSELLOR_STOPS],
                now,
                ...live.hooks({ runId, thinking: () => captured?.value ?? '' }),
            });
        } finally {
            captured?.stop?.();
        }

        // Конец дня: Petition обязателен по каждому персонажу с Указом — недостающие пишет движок.
        if (mode === 'day' && banks?.great?.load) {
            let names = [];
            try { names = decreeNames(await banks.great.load()); } catch { names = []; }
            if (names.length) {
                const rows = typeof store.unreviewedLedger === 'function' ? store.unreviewedLedger() : [];
                const ensured = ensureDayPetitions({ entries: store.petitions?.() ?? [], characters: names, rows, turn, at: now(), petitioned: [...state.petitioned] });
                for (const petition of ensured.added) {
                    await store.addPetition(petition);
                    state.petitioned.add(petition.character.toLowerCase());
                }
                state.decided = true;
            }
        }

        if (!talk(mode) && state.decided && typeof store.markLedgerReviewed === 'function') {
            await store.markLedgerReviewed(now()).catch(() => null);
        }
        if (!talk(mode) && typeof store.saveCounsellor === 'function') {
            // Сбой модели в обычном разборе не съедает слот: следующий ход попробует снова.
            const reviewed = mode === 'day' || result.type !== 'error';
            await store.saveCounsellor({
                ...(reviewed ? { lastReviewTurn: turn, lastReviewAt: now() } : {}),
                day: dayOf(store.clock().minutes),
            }).catch(() => null);
        }

        const summary = queueSummary({ petitions: store.petitions?.() ?? [], prayers: store.prayers?.() ?? [] });
        wake.detail = [
            mode === 'day' ? 'Petitions made for the new day.' : state.nothing ? `nothing_yet: ${state.nothing}` : `${state.petitioned.size} petition(s), ${state.prayers} prayer(s).`,
            `Queued: ${summary.petitions.length} petition(s), ${summary.prayers.length} prayer(s).`,
        ].join(' ');
        wake.queues = summary;
        const endedAt = now();
        const cycle = createCycleRecord({
            runId, event, messages: result.messages.slice(contextLength), toolCalls: result.trace,
            thinking: captured?.value ?? '', warnings: result.warnings ?? [], usage: captured?.usage ?? null,
            at: startedAt, endedAt, durationMs: endedAt - startedAt, wake, turn,
            clockMinutes: store.clock().minutes, workerId: worker.id,
        });
        await store.appendCycle(cycle).catch(() => null);
        live.finished({ cycle });
        publishEvent('decision.counsellor.finished', { runId, mode, petitions: summary.petitions.length, prayers: summary.prayers.length });
        return {
            ok: result.type !== 'error', mode, type: result.type, turn,
            petitions: [...state.petitioned], reply: state.reply, nothing: state.nothing, queued: summary,
        };
    }

    async function maybeRun({ turn = null } = {}) {
        const settings = getSettings();
        const clock = store.clock();
        const day = dayOf(clock.minutes);
        const state = typeof store.counsellor === 'function' ? store.counsellor() : { lastReviewTurn: 0, day: null };
        const seen = state.day !== null && state.day !== undefined && Number.isFinite(Number(state.day));
        const first = !seen;
        // Первое наблюдение дня только запоминается: иначе первый же ход в новом чате считался бы концом дня.
        if (first && typeof store.saveCounsellor === 'function') await store.saveCounsellor({ day }).catch(() => null);
        // `turn` не передан — ход берём сами: `Number(null)` равно 0, и Советник вечно считал, что идёт ход 0 (разбор Ведомости не наступал ни разу).
        const number = turn !== null && turn !== undefined && Number.isFinite(Number(turn)) ? Number(turn) : currentTurn();
        // Вопрос Бога важнее счётчика: пока мироздание ждёт ответа, Советник тоже не спит.
        const openQuestion = typeof store.god === 'function' ? (store.god()?.questions ?? []).some(item => !String(item.answer ?? '').trim()) : false;
        const mode = openQuestion && !first ? 'review' : shouldReview({
            turn: number, lastTurn: state.lastReviewTurn,
            everyTurns: Number(settings.counsellor?.everyTurns) || 3,
            dayEnded: !first && dayChanged(state.day, day),
        });
        if (!mode) return { skipped: true, turn: number };
        const runId = `counsellor_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return enqueue(() => run({ runId, mode }));
    }

    /** Сообщение пользователя Советнику: запись в журнал, короткая переписка, затем разбор. */
    async function sendMessage({ text: value } = {}) {
        const clean = text(value);
        if (!clean) return { ok: false, error: 'An empty message is not sent.' };
        const at = now();
        const record = createCycleRecord({
            event: 'message', message: { text: clean, at }, at, endedAt: at, durationMs: 0,
            wake: { type: 'message', label: 'A message to the Counsellor', detail: clean },
            turn: currentTurn(), clockMinutes: store.clock().minutes,
            workerId: counsellorWorkerId(getSettings()) || null,
        });
        try { await store.appendCycle(record); } catch { /* the reply still runs */ }
        await store.addConversation({ role: 'user', text: clean, at }).catch(() => null);
        publishEvent('decision.message.added', { record });
        const runId = `counsellor_msg_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        enqueue(() => run({ runId, mode: 'message', text: clean }))
            .catch(error => live.failed({ runId, message: error?.message ?? String(error) }));
        return { ok: true, record };
    }

    /** Вопросы Бога — пользователю сразу, одним сообщением; несколько вопросов подряд — один запуск. */
    let relaying = null;
    function relayGodQuestions() {
        if (relaying) return relaying;
        const runId = `counsellor_god_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        relaying = Promise.resolve().then(() => enqueue(() => run({ runId, mode: 'god' })))
            .catch(error => live.failed({ runId, message: error?.message ?? String(error) }))
            .finally(() => { relaying = null; });
        return relaying;
    }

    /** Бог или директор ответили на отправленное — Советник пересказывает пользователю по их записи. */
    function relayStatus(report) {
        const body = text(report);
        if (!body) return Promise.resolve({ skipped: true });
        const runId = `counsellor_status_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return enqueue(() => run({ runId, mode: 'status', text: body }))
            .catch(error => live.failed({ runId, message: error?.message ?? String(error) }));
    }

    return { run, maybeRun, sendMessage, relayGodQuestions, relayStatus, currentTurn, workerFor };
}

/** Инструмент, который заканчивает разбор: «важного нет». */
const COUNSELLOR_STOPS = COUNSELLOR_STOP_TOOLS;
