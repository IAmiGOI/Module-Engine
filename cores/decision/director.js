import { readOpening } from './opening.js';
import { withDirectorChecklist, namedInReports } from '../../libraries/core/director-checklist.js';
import { isUserCharacter } from '../../libraries/core/decision-great-bank.js';
import { rpNow } from '../../libraries/core/decision-scene.js';
import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildDirectorToolList } from '../../libraries/core/decision-tools.js';
import { createPsyDesk } from './psy-desk.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { deciderRequestParams, directorWorkerId, godWorkerId, roleRequestParams } from '../../libraries/core/decision-settings.js';
import { statusReport } from '../../libraries/core/decision-status.js';
import { lastDecreeThoughts, lastReports, buildDirectorContext, directorReason } from '../../libraries/core/decision-director.js';
import { dayOf } from '../../libraries/core/decision-counsellor.js';
import { createCycleLive } from './live.js';
import { createDecreeHandler } from './handlers-decree.js';
import { createFileHandlers } from './handlers-files.js';
import { createBankHandlers } from './handlers-bank.js';
import { createRetryRunner } from './retry.js';
import { DIRECTOR_PETITION_STANDS, REPORTS_HEADER } from '../../libraries/core/decision-prompts-director.js';
import { fillPrompt } from '../../libraries/core/decision-prompts.js';

/**
 * Директор (часть 19): полу-слепой, работает по отчётам. Просыпается в фоне
 * после хода на Petition, Телеграмму, Main Cast без Указа, повышение и конец
 * RP-дня; издаёт Указы и снова отдыхает. Телеграмма из закрытого списка
 * держит следующий ход до нового Указа (`waitForDecree`), но не дольше
 * настройки — иначе ход идёт по старому Указу с предупреждением в журнале.
 */

const OPENAI_FORMAT = 'openai';
const text = value => String(value ?? '').trim();

export class DirectorConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DirectorConfigError';
        this.code = 'decision-config';
    }
}

function clockLabel(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    return `Day ${dayOf(total) + 1}, ${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function createDirector({
    call, callTool, callService = null, store, banks = null, getSettings, getWorkers, publishEvent,
    capture = null, enqueue = job => job(), now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), creation = null,
}) {
    const live = createCycleLive({ publishEvent, getTurn: () => currentTurn(), getClock: () => store.clock().minutes });
    const retry = createRetryRunner({ publishEvent, getSettings, sleep, now });
    let running = null;
    const waiters = new Set();

    function currentTurn() {
        const entries = Array.isArray(store.window?.()?.entries) ? store.window().entries : [];
        const turns = entries.filter(entry => entry.kind === 'turn');
        if (turns.length) return Number(turns.at(-1).turn) || 0;
        return Math.max(0, ...(typeof store.cycles === 'function' ? store.cycles() : [])
            .filter(cycle => ['turn', 'regenerate', 'swipe'].includes(cycle?.event) && !cycle?.rejected && cycle?.form)
            .map(cycle => Number(cycle.turn) || 0));
    }

    function workerFor(settings) {
        const id = directorWorkerId(settings);
        if (!id) throw new DirectorConfigError('Decision core: no Director connection is configured — choose the resolver connection in the Director / Writer card.');
        const worker = (getWorkers() ?? []).find(item => item.id === id);
        if (!worker) throw new DirectorConfigError(`Decision core: the Director connection "${id}" is not available — choose an existing connection in the Director / Writer card.`);
        if (worker.format !== OPENAI_FORMAT) throw new DirectorConfigError(`Decision core: the Director needs an "openai" worker with tools; "${worker.id}" is "${worker.format}".`);
        return worker;
    }

    async function bankState() {
        // Great Bank догоняет записи банков перед чтением: иначе до первого хода он пуст, и Main Cast не видно.
        try { await banks?.great?.sync?.(); return banks?.great?.load ? await banks.great.load() : {}; } catch { return {}; }
    }

    /** History и The User in the World из Creation — точка таймлайна и кто уже в мире. */
    async function worldAtStart() {
        if (!creation) return '';
        try {
            await creation.load();
            return ['History', 'The User in the World'].map(title => creation.section?.(title)).filter(section => String(section?.text ?? '').trim())
                .map(section => `### ${section.title}\n${String(section.text).trim()}`).join('\n\n');
        } catch { return ''; }
    }

    async function reasonNow() {
        if (!banks?.great?.load) return null;
        const papers = typeof store.papers === 'function' ? store.papers() : {};
        // Банки Main Cast пишутся по готовому миру: пока Бог строит Creation, директор их не начинает.
        const worldReady = !godWorkerId(getSettings()) || !creation || Boolean(await creation.load().then(() => creation.complete()).catch(() => true));
        return directorReason({ petitions: papers.petitions ?? [], telegrams: papers.telegrams ?? [], banks: await bankState(), worldReady });
    }

    function requestRecord(workerId, settings, runId, prefix, attempt) {
        const params = roleRequestParams(settings, 'director');
        const requestId = `${runId}:${prefix}${attempt}:${now()}`;
        return { requestId, ...params, workerId };
    }

    function generateFor({ settings, worker, runId, startedAt }) {
        let callIndex = 0;
        return async ({ messages, tools, toolChoice }) => retry.run({
            role: 'director',
            budget: 'background',
            normalize: normalizeGenerateAnswer,
            request: async ({ attempt, boost, lowerReasoning, backupWorkerId }) => {
                callIndex += 1;
                const params = requestRecord(backupWorkerId || worker.id, settings, runId, 'd', callIndex);
                if (boost > 1 && Number.isFinite(params.maxTokens)) params.maxTokens = Math.min(32768, Math.round(params.maxTokens * boost));
                if (lowerReasoning) params.reasoningEffort = 'low';
                return call('model.generate', {
                    ...params, messages, tools, toolChoice, stream: true, returnMessage: true,
                });
            },
        });
    }

    function handlersFor(state, checklist = null, desk = null) {
        const base = {
            ...createBankHandlers({ banks, state }),
            ...createDecreeHandler({ banks, state, publishEvent }),
            // Указ и банки — файлами: view / edit / create (часть 21).
            ...createFileHandlers({
                banks, state, publishEvent, by: 'director',
                // Психолог за столом проверяет строку до записи; без сессии — прежний порядок.
                beforeWrite: desk ? ({ path, target, before, after, comment }) => desk.check({ path, part: target?.part, name: target?.name, before, after, comment }) : null,
            }),
            // Без своего await вызов уходил в общий маршрут и падал («no tool named await»), а движок писал «answered without a tool call».
            await: args => ({ ok: true, reason: String(args?.reason ?? '') }),
        };
        return checklist ? withDirectorChecklist(base, checklist) : base;
    }

    /** Форма перед действием: кого называют повод и отчёты (по тексту задания), у кого есть Указ, кто какой важности. */
    function checklistFor(bank, messages, onForm = null) {
        const characters = Object.values(bank ?? {}).filter(character => character?.name);
        // Кого называют: задание (повод) и сами отчёты. Блок файлов — не основание: там бывают и задетые лишь по имени.
        const task = (Array.isArray(messages) ? messages : []).filter(message => message?.role === 'user' || String(message?.content ?? '').startsWith(REPORTS_HEADER)).map(message => String(message.content ?? '')).join('\n');
        const find = name => characters.find(character => character.name.toLowerCase() === String(name ?? '').trim().toLowerCase()) ?? null;
        const filled = character => Object.values(character?.decree ?? {}).some(lines => Array.isArray(lines) && lines.some(line => String(line ?? '').trim()));
        return {
            allowed: namedInReports(task, characters.map(character => ({ name: character.name, aliases: character.aliases ?? [] }))),
            everyone: characters.filter(filled).map(character => character.name),
            importanceOf: name => find(name)?.importance ?? null,
            decreeOf: name => (find(name) ? Object.values(find(name).decree ?? {}).flat().map(line => String(line ?? '')).join('\n') : null),
            bankWritten: name => (find(name) ? ['material', 'spiritual'].every(part => Object.values(find(name)[part] ?? {}).some(lines => Array.isArray(lines) && lines.some(line => String(line ?? '').trim()))) : null),
            onForm,
        };
    }

    async function run({ runId, reason = null } = {}) {
        const settings = getSettings();
        const info = reason ?? await reasonNow();
        if (!info) return { skipped: true };
        let worker;
        try { worker = workerFor(settings); } catch (error) {
            live.failed({ runId, message: error.message });
            throw error;
        }
        const startedAt = now();
        const papers = typeof store.papers === 'function' ? store.papers() : {};
        // Только прочитанные сейчас Petition: новая, пришедшая во время работы, останется поводом.
        const petitionIds = (papers.petitions ?? []).map(item => item.id).filter(Boolean);
        const fresh = (papers.petitions ?? []).filter(item => item.status !== 'read');
        const bank = await bankState();
        const context = buildDirectorContext({
            banks: bank,
            library: store.library(),
            characters: info.characters,
            reports: lastReports({ petitions: papers.petitions ?? [], telegrams: papers.telegrams ?? [] }),
            thoughts: lastDecreeThoughts(typeof store.cycles === 'function' ? store.cycles() : []),
            rpTime: rpNow(store, clockLabel),
            reason: info.wake.detail,
            world: await worldAtStart(),
            opening: await readOpening(callService),
        });
        const state = { role: 'director', decreeIssued: false, decreeNames: [] };
        // Психолог за тем же столом: включается формой с write_bank, иначе молчит.
        const desk = createPsyDesk({
            call, getSettings, getWorkers, publishEvent, great: banks?.great ?? null,
            world: async () => {
                const built = await worldAtStart();
                if (text(built)) return built;
                try { return String(store?.chatBrief?.()?.timeline ?? '').trim(); } catch { return ''; }
            },
        });
        const users = Object.values(bank ?? {}).filter(isUserCharacter).map(character => character.name);
        const captured = typeof capture === 'function'
            ? capture(`${runId}:`, { onThinking: value => publishEvent('decision.cycle.thinking', { runId, text: value }) })
            : null;
        live.started({ runId, event: 'decree', wake: info.wake, at: startedAt });
        let result;
        // Одна форма на весь запуск, и на возврат Петиции тоже.
        const checklistHandlers = handlersFor(state, checklistFor(bank, context.messages, form => {
            const names = (Array.isArray(form?.characters) ? form.characters : []).filter(item => item.write_bank).map(item => item.name);
            if (!names.length) return;
            desk.activate({ names, users });
            banks.holdPsyche?.(desk.targets());
        }), desk);
        const cycleParams = messages => ({
            messages,
            tools: buildDirectorToolList(),
            generate: generateFor({ settings, worker, runId, startedAt }),
            handlers: checklistHandlers,
            // Старый вызов `decree` (совместимость) кончает цикл сразу; файловые правки кончаются на await.
            stopAfter: ['decree'],
            callTool,
            maxSteps: Math.max(1, Number(settings.director?.maxSteps) || 10),
            implicitAwait: true,
            emptyRetry: false,
            now,
            ...live.hooks({ runId, thinking: () => captured?.value ?? '' }),
        });
        try {
            result = await runDecisionCycle(cycleParams(context.messages));
            // Петиция без единой правки Указа: один раз вернуть задачу. Директор отвечал «всё уже учтено», не открыв файлов, и Указ Emilia оставался утренним.
            // Только те, у кого Указ есть: у побочного без Указа менять нечего.
            const hasDecree = name => Object.values(bank ?? {}).some(character => String(character?.name ?? '').toLowerCase() === name.toLowerCase()
                && Object.values(character?.decree ?? {}).some(lines => Array.isArray(lines) && lines.length));
            const untouched = [...new Set(fresh.map(item => String(item.character ?? '').trim()).filter(Boolean))]
                .filter(name => hasDecree(name) && !(state.decreeNames ?? []).some(done => String(done).toLowerCase() === name.toLowerCase()));
            // След в журнале: вернул ли движок Петицию и почему нет — вживую возврат однажды не сработал без видимой причины.
            const petitioned = [...new Set(fresh.map(item => String(item.character ?? '').trim()).filter(Boolean))];
            const note = petitioned.length
                ? (untouched.length ? `petition handed back: ${untouched.join(', ')}` : `petition not handed back: ${petitioned.map(name => `${name} (${hasDecree(name) ? 'Decree changed' : 'no Decree'})`).join(', ')}`)
                : '';
            if (result.type !== 'error' && untouched.length) {
                const again = await runDecisionCycle(cycleParams([...result.messages, { role: 'user', content: fillPrompt(DIRECTOR_PETITION_STANDS, { names: untouched.join(', ') }) }]));
                result = { ...again, trace: [...(result.trace ?? []), ...(again.trace ?? [])], warnings: [...(result.warnings ?? []), ...(again.warnings ?? [])] };
            }
            if (note) result = { ...result, warnings: [...(result.warnings ?? []), note] };
        } finally {
            captured?.stop?.();
            // Конец сессии: psyche.md пишет Психолог-сосед, уже с историей сессии.
            let session = null;
            try {
                session = await desk.finish({ state: await bankState() });
            } catch (error) {
                session = { warnings: [`the Psychologist could not finish the session: ${error?.message ?? String(error)}`] };
            } finally {
                banks.releasePsyche?.(desk.targets());
            }
            if (session?.warnings?.length && result) {
                result = { ...result, warnings: [...(result.warnings ?? []), ...session.warnings] };
            }
        }
        const endedAt = now();
        const cycle = createCycleRecord({
            runId, event: 'decree', messages: context.messages.slice(0), toolCalls: result.trace,
            thinking: captured?.value ?? '', warnings: result.warnings ?? [], usage: captured?.usage ?? null,
            at: startedAt, endedAt, durationMs: endedAt - startedAt,
            wake: { ...info.wake, detail: [info.wake.detail, state.decreeIssued ? `Decree: ${state.decreeNames.join(', ')}` : 'no new Decree'].filter(Boolean).join('; ') },
            turn: currentTurn(), clockMinutes: store.clock().minutes, workerId: worker.id,
        });
        await store.appendCycle(cycle).catch(() => null);
        live.finished({ cycle });
        const failed = result.type === 'error';
        if (!failed) {
            // Director прочитал очередь: те же Petition и Телеграммы больше его не будят.
            await store.markPetitionsRead?.(now(), petitionIds).catch(() => null);
            await store.markTelegramsRead?.(now()).catch(() => null);
            if (state.decreeIssued) await store.saveAwaitingDecree?.(null).catch(() => null);
            await store.saveDirector?.({ lastRunAt: now(), lastReason: info.wake.detail }).catch(() => null);
        }
        // Отчёт Советнику: какие Петиции директор прочёл и что изменил в банках и Указах.
        const handled = (papers.petitions ?? []).filter(item => petitionIds.includes(item.id)).map(item => `Petition about ${item.character}: ${item.problem}`);
        const report = statusReport({ role: 'The Director', handled, toolCalls: cycle.toolCalls, failed });
        publishEvent('decision.director.finished', { runId, decrees: state.decreeNames.length, issued: state.decreeIssued, report });
        return { ok: !failed, type: result.type, issued: state.decreeIssued, characters: state.decreeNames, cycle };
    }

    function track(job) {
        running = Promise.resolve(job)
            .finally(() => { running = null; for (const resolve of waiters) resolve(); waiters.clear(); });
        return running;
    }

    async function maybeRun() {
        if (running) return { skipped: true, running: true };
        const info = await reasonNow().catch(() => null);
        if (!info) return { skipped: true };
        const runId = `director_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return track(enqueue(() => run({ runId, reason: info })));
    }

    /**
     * Телеграмма ждёт здесь, а не в общей очереди: если Советник ещё
     * работает, Указ всё равно должен успеть до хода.
     */
    async function startNow() {
        if (running) return running;
        const info = await reasonNow().catch(() => null);
        if (!info) return { skipped: true };
        const runId = `director_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        return track(run({ runId, reason: info }));
    }

    /**
     * Телеграмма держит следующий ход: ждём новый Указ не дольше настройки.
     * Не дождались — ход идёт по старому Указу, а в журнале остаётся строка.
     */
    async function waitForDecree({ timeoutMs = null } = {}) {
        const papers = typeof store.papers === 'function' ? store.papers() : {};
        if (!papers?.awaitingDecree) return { ok: true, waited: false };
        const settings = getSettings();
        const limit = Math.max(1000, Number(timeoutMs) || Number(settings.director?.decreeTimeoutMs) || 120000);
        const startedAt = now();
        const waiting = new Promise(resolve => waiters.add(resolve));
        startNow().catch(() => {});
        let timedOut = false;
        let timer = null;
        let waited = null;
        await Promise.race([
            waiting,
            new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, limit); }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut && running) {
            // Ждать ответа не бросаем: если он придёт позже, Указ всё равно запишется.
            waited = now() - startedAt;
        }
        const cleared = !(typeof store.papers === 'function' ? store.papers() : {}).awaitingDecree;
        if (!cleared) {
            const at = now();
            const record = createCycleRecord({
                event: 'warning', at, endedAt: at, durationMs: waited ?? (at - startedAt),
                wake: {
                    type: 'warning', label: 'The turn waited for a Decree and did not get one',
                    detail: `Waited ${Math.round((waited ?? (at - startedAt)) / 1000)} s. The turn goes on with the old Decree.`,
                },
                turn: currentTurn(), clockMinutes: store.clock().minutes,
                workerId: directorWorkerId(getSettings()) || null,
            });
            await store.appendCycle(record).catch(() => null);
            await store.saveAwaitingDecree?.(null).catch(() => null);
        }
        return { ok: cleared, waited: true, timedOut: !cleared, ms: waited ?? (now() - startedAt) };
    }

    return { run, maybeRun, waitForDecree, reasonNow, currentTurn, workerFor };
}
