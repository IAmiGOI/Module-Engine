import { readOpening } from './opening.js';
import { godFileForm, fileKey } from '../../libraries/core/god-file-form.js';
import { rpNow } from '../../libraries/core/decision-scene.js';
import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildGodToolList } from '../../libraries/core/decision-tools.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { roleRequestParams, godWorkerId } from '../../libraries/core/decision-settings.js';
import { buildGodContext, godReason, godMaterial, renderPrayers } from '../../libraries/core/decision-god.js';
import { dayOf } from '../../libraries/core/decision-counsellor.js';
import { createCycleLive } from './live.js';
import { createCreationStore } from './creation.js';
import { createCreationHandlers } from './handlers-creation.js';
import { createFileLayer } from './files-layer.js';
import { createCreationProvider } from './files-creation.js';
import { createFileHandlers } from './handlers-files.js';
import { createRetryRunner } from './retry.js';
import { renderCreation } from '../../libraries/core/decision-creation.js';
import { statusReport } from '../../libraries/core/decision-status.js';

const INTERRUPTED = 'In progress — if this note stays after a reload, the run was interrupted.';

/**
 * God (фаза 5): строит Creation из лорбука и мировых частей карт, потом
 * замолкает и просыпается только по Молитвам и Декларации. Полу-слепой, как
 * Director: истории чата не видит. Работает в общей очереди пробуждений —
 * с Director одновременно не идёт, ход их вытесняет.
 */

const OPENAI_FORMAT = 'openai';
const text = value => String(value ?? '').trim();

export class GodConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GodConfigError';
        this.code = 'decision-config';
    }
}

function clockLabel(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    return `Day ${dayOf(total) + 1}, ${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function createGod({
    call, callTool, callService = null, store, getSettings, getWorkers, publishEvent,
    capture = null, creation = null, enqueue = job => job(), now = () => Date.now(),
}) {
    const live = createCycleLive({ publishEvent, getTurn: () => currentTurn(), getClock: () => store.clock().minutes });
    const retry = createRetryRunner({ publishEvent, getSettings });
    const creationStore = creation ?? createCreationStore({ call, store, publishEvent, now });
    let running = null;
    let layout = null;

    function currentTurn() {
        const entries = Array.isArray(store.window?.()?.entries) ? store.window().entries : [];
        const turns = entries.filter(entry => entry.kind === 'turn');
        if (turns.length) return Number(turns.at(-1).turn) || 0;
        return Math.max(0, ...(typeof store.cycles === 'function' ? store.cycles() : [])
            .filter(cycle => ['turn', 'regenerate', 'swipe'].includes(cycle?.event) && !cycle?.rejected && cycle?.form)
            .map(cycle => Number(cycle.turn) || 0));
    }

    function workerFor(settings) {
        const id = godWorkerId(settings);
        if (!id) throw new GodConfigError('Decision core: no God connection is configured — choose a God connection in the Director / Writer card.');
        const worker = (getWorkers() ?? []).find(item => item.id === id);
        if (!worker) throw new GodConfigError(`Decision core: the God connection "${id}" is not available — choose an existing connection in the Director / Writer card.`);
        if (worker.format !== OPENAI_FORMAT) throw new GodConfigError(`Decision core: God needs an "openai" worker with tools; "${worker.id}" is "${worker.format}".`);
        return worker;
    }

    /** Материал мира читается один раз за запуск: лорбук не персонажи плюс мировые части карт. */
    function godHandlers(handlerState) {
        const legacy = createCreationHandlers({ creation: creationStore, store, state: handlerState, publishEvent, now });
        const layer = createFileLayer({ banks: null });
        layer.addProvider(createCreationProvider({ creation: creationStore, state: handlerState }));
        const files = createFileHandlers({ state: handlerState, publishEvent, by: 'god', layer });
        // Свой await: без него вызов уходил в общий маршрут и падал, а движок писал «answered without a tool call».
        // Форма по файлу — сразу после каждой записи, по списку именно этого файла; финальная — то, что видно по всему миру.
        // Открытое возвращается Богу; при построении await принимается, когда каждый файл проверен после последней правки.
        // Форма динамическая: собирается из самого файла после записи — пункт на каждый подраздел, после правки — только на изменённые.
        const readText = async path => { const file = await layer.read(path).catch(() => null); return file?.ok === false ? null : (file?.text ?? null); };
        handlerState.unreviewed ??= new Map();
        const formFor = async (path, previous) => {
            const items = godFileForm(path, await readText(path) ?? '', previous);
            const key = fileKey(path);
            const pending = [...(handlerState.unreviewed.get(key) ?? []), ...items.filter(item => !(handlerState.unreviewed.get(key) ?? []).includes(item))];
            if (pending.length) { handlerState.unreviewed.set(key, pending); handlerState.reviewed = false; }
            return pending;
        };
        const create = async args => {
            const inCreation = /^creation\//.test(fileKey(args?.path));
            const previous = inCreation ? await readText(args.path) : null;
            const result = await files.create(args);
            if (result?.ok === false || !inCreation) return result;
            const form = await formFor(args.path, previous);
            return form.length ? { ...result, review: { file: args.path, form }, note: 'Fill review_file for this file now, item by item, from the file as it is.' } : result;
        };
        const editFiles = async args => {
            const paths = [...new Set((Array.isArray(args?.edits) ? args.edits : []).map(edit => String(edit?.path ?? '')).filter(path => /^creation\//.test(fileKey(path))))];
            const before = new Map();
            for (const path of paths) before.set(fileKey(path), await readText(path));
            const result = await files.edit(args);
            const changed = (result?.files ?? []).filter(item => item.ok && !item.unchanged && /^creation\//.test(fileKey(item.path))).map(item => item.path);
            const review = [];
            for (const path of changed) {
                const form = await formFor(path, before.get(fileKey(path)) ?? null);
                if (form.length) review.push({ file: path, form });
            }
            return review.length ? { ...result, review, note: 'Fill review_file for each of these files now — only the items listed.' } : result;
        };
        const reviewFile = args => {
            const items = Array.isArray(args?.items) ? args.items : [];
            const key = fileKey(args?.file);
            const form = handlerState.unreviewed.get(key) ?? [];
            if (!items.length || items.length < form.length) return { ok: false, error: `Answer every item of this file's form, in order (${form.length} items).`, form };
            const open = items.filter(item => item?.done !== true).map(item => `${item.item}${String(item?.missing ?? '').trim() ? ` — ${String(item.missing).trim()}` : ''}`);
            // Открытыми остаются только неготовые пункты: следующая форма — они плюс то, что изменит правка.
            const left = form.length ? form.filter((_, index) => items[index]?.done !== true) : [];
            if (open.length && left.length) handlerState.unreviewed.set(key, left); else if (!open.length) handlerState.unreviewed.delete(key);
            return open.length
                ? { ok: true, clean: false, file: args?.file, open, note: 'Fix these with edit; the edit returns the form for what changed.' }
                : { ok: true, clean: true, file: args?.file };
        };
        const review = args => {
            const open = [
                ...(Array.isArray(args?.references) ? args.references : []).filter(item => item?.exists === false).map(item => `${item.file}: referenced but not written`),
                ...(String(args?.material ?? '').trim() ? [`material not covered: ${String(args.material).trim()}`] : []),
            ];
            handlerState.reviewed = open.length === 0;
            return open.length
                ? { ok: true, clean: false, open, note: 'Fix every open item with create or edit, then fill review_creation again.' }
                : { ok: true, clean: true, note: 'Nothing is open. You may rest.' };
        };
        const building = ['declaration', 'build', 'first'].includes(handlerState.kind);
        const rest = args => {
            if (!building) return { ok: true, reason: String(args?.reason ?? '') };
            if (handlerState.unreviewed.size) return { ok: false, error: `Not yet: these files changed and are not reviewed — fill review_file for each: ${[...handlerState.unreviewed.keys()].join(', ')}.` };
            if (!handlerState.reviewed) return { ok: false, error: 'Not yet: fill review_creation — the files the others point to and the material still uncovered. await is accepted after a review with nothing open.' };
            return { ok: true, reason: String(args?.reason ?? '') };
        };
        return { ...legacy, view: files.view, edit: editFiles, create, review_file: reviewFile, review_creation: review, await: rest };
    }

    async function loadMaterial() {
        try {
            const [entries, cards, opening] = await Promise.all([
                call('lorebook.entries').catch(() => []),
                // Карточки — сервис, не ядро: через `call` запрос уходил в шину ядер, ошибка глоталась, и Бог видел пустой материал.
                (callService ?? call)('stCharacter.chatCharacters').catch(() => []),
                readOpening(callService ?? call),
            ]);
            const marks = typeof layout?.marksForLorebook === 'function' ? layout.marksForLorebook() : null;
            return godMaterial({ lorebookEntries: entries ?? [], cards: cards ?? [], marks, opening });
        } catch { return ''; }
    }

    async function reasonNow({ allowBuild = true } = {}) {
        const state = await creationStore.load();
        const papers = typeof store.papers === 'function' ? store.papers() : {};
        return godReason({
            creation: state,
            prayers: papers?.prayers ?? [],
            declaration: papers?.god?.declaration ?? null,
            questions: papers?.god?.questions ?? [],
            allowBuild,
            // Изучал ли God материал и спрашивал ли: старый мир без этой отметки считается изученным.
            studied: Boolean(papers?.god?.studiedAt) || Boolean(papers?.god?.lastRunAt) || (papers?.god?.questions ?? []).length > 0,
        });
    }

    function generateFor({ settings, worker, runId, startedAt }) {
        let callIndex = 0;
        return async ({ messages, tools, toolChoice }) => retry.run({
            role: 'god',
            budget: 'background',
            normalize: normalizeGenerateAnswer,
            request: async ({ boost, lowerReasoning, backupWorkerId }) => {
                callIndex += 1;
                const params = roleRequestParams(settings, 'god');
                if (boost > 1 && Number.isFinite(params.maxTokens)) params.maxTokens = Math.min(32768, Math.round(params.maxTokens * boost));
                if (lowerReasoning) params.reasoningEffort = 'low';
                return call('model.generate', { purpose: 'god',
                    requestId: `${runId}:g${callIndex}:${startedAt}`, ...params,
                    workerId: backupWorkerId || worker.id, messages, tools, toolChoice, stream: true, returnMessage: true,
                });
            },
        });
    }

    async function run({ runId, reason = null } = {}) {
        const settings = getSettings();
        const info = reason ?? await reasonNow({ allowBuild: true });
        if (!info) return { skipped: true };
        let worker;
        try { worker = workerFor(settings); } catch (error) {
            live.failed({ runId, message: error.message });
            throw error;
        }
        const startedAt = now();
        const state = await creationStore.load();
        const bare = !renderCreation(state);
        const material = info.kind === 'prayer' || (info.kind === 'declaration' && !bare) ? '' : await loadMaterial();
        const context = buildGodContext({
            material, creation: state, kind: info.kind, prayers: info.prayers,
            // До первого хода часов нет: «Day 1, 00:00» — пустые часы движка, Бог принял их за момент старта (полночь).
            declaration: info.declaration, rpTime: currentTurn() > 0 ? rpNow(store, clockLabel) : '',
            questions: (typeof store.papers === 'function' ? store.papers()?.god?.questions ?? [] : []).filter(item => !text(item.answer)),
            maxQuestions: Number(settings.god?.maxQuestions) || 5,
        });
        const handlerState = {
            rpLabel: clockLabel(store.clock().minutes), turn: currentTurn(), questionLimit: Number(settings.god?.maxQuestions) || 5,
            written: [], systems: [], questionsAsked: 0, kind: info.kind, reviewed: false,
        };
        const captured = typeof capture === 'function'
            ? capture(`${runId}:`, { onThinking: value => publishEvent('decision.cycle.thinking', { runId, text: value }) })
            : null;
        live.started({ runId, event: info.kind === 'prayer' ? 'god_prayer' : (info.kind === 'declaration' ? 'god_declaration' : 'god_build'), wake: info.wake, at: startedAt });
        const event = info.kind === 'prayer' ? 'god_prayer' : (info.kind === 'declaration' ? 'god_declaration' : (info.kind === 'study' ? 'god_study' : 'god_build'));
        // Цикл пишется в журнал сразу и после каждого вызова: перезагрузка посреди долгого построения не стирает историю.
        const cycleId = `cyc_${startedAt.toString(36)}_${runId.slice(-6)}`;
        const calls = [];
        const record = ({ endedAt = null, warnings = [INTERRUPTED], toolCalls = calls } = {}) => createCycleRecord({
            id: cycleId, runId, event, messages: context.messages.slice(0), toolCalls,
            thinking: captured?.value ?? '', warnings, usage: captured?.usage ?? null,
            at: startedAt, endedAt, durationMs: endedAt ? endedAt - startedAt : null,
            wake: { ...info.wake, detail: [info.wake.detail, handlerState.written.length ? `Sections: ${handlerState.written.join(', ')}` : '', handlerState.systems.length ? `Systems: ${handlerState.systems.join(', ')}` : ''].filter(Boolean).join('; ') },
            turn: currentTurn(), clockMinutes: store.clock().minutes, workerId: worker.id,
        });
        const savePartial = () => (typeof store.upsertCycle === 'function' ? store.upsertCycle(record()).catch(() => null) : null);
        await savePartial();
        const handlers = Object.fromEntries(Object.entries(godHandlers(handlerState)).map(([name, handler]) => [name, async (...args) => {
            const value = await handler(...args);
            calls.push({ name, args: args[0] ?? {}, comment: String(args[0]?.comment ?? ''), result: value, at: now() });
            await savePartial();
            return value;
        }]));
        let result;
        try {
            result = await runDecisionCycle({
                messages: context.messages,
                tools: buildGodToolList(),
                generate: generateFor({ settings, worker, runId, startedAt }),
                // Мир — файлами Creation/… (view / edit / create, часть 21); ask — вопрос Советнику.
                handlers,
                callTool,
                // Построение мира с формой проверки — больше шагов, и ответ текстом не считается отдыхом: только чистая форма и await.
                maxSteps: Math.max(1, Number(settings.god?.maxSteps) || 20) * (['declaration', 'build', 'first'].includes(info.kind) ? 6 : 1),
                implicitAwait: !['declaration', 'build', 'first'].includes(info.kind),
                emptyRetry: false,
                now,
                ...live.hooks({ runId, thinking: () => captured?.value ?? '' }),
            });
        } catch (error) {
            // Сбой посреди построения — тоже запись: что успело, остаётся видно, и ошибка рядом.
            result = { type: 'error', reason: error?.message ?? String(error), trace: calls, warnings: [`God stopped: ${error?.message ?? error}`] };
        } finally {
            captured?.stop();
        }
        const endedAt = now();
        const cycle = record({ endedAt, warnings: result.warnings ?? [], toolCalls: result.trace ?? calls });
        await (typeof store.upsertCycle === 'function' ? store.upsertCycle(cycle) : store.appendCycle(cycle)).catch(() => null);
        live.finished({ cycle });
        const failed = result.type === 'error';
        if (!failed) {
            // Прочитанные Молитвы и доставленная Декларация больше не будят God.
            const ids = (info.prayers ?? []).map(item => item.id).filter(Boolean);
            if (ids.length) await store.markPrayersRead?.(now(), ids).catch(() => null);
            if (info.kind === 'declaration') await store.consumeDeclaration?.(now()).catch(() => null);
            await store.saveGod?.({ lastRunAt: now(), lastReason: info.wake.detail, ...(info.kind === 'study' ? { studiedAt: now() } : {}) }).catch(() => null);
        }
        // Отчёт Советнику: на какие Молитвы и ответы Бог ответил и что изменил — тот пересказывает пользователю.
        const handled = info.kind === 'prayer' ? (info.prayers ?? []).map(item => item.text) : (info.kind === 'declaration' ? ['The answers to God\'s questions (the Declaration).'] : []);
        const report = statusReport({ role: 'God', handled, toolCalls: cycle.toolCalls, failed });
        publishEvent('decision.god.finished', { runId, kind: info.kind, sections: handlerState.written.length, systems: handlerState.systems.length, report });
        return { ok: !failed, kind: info.kind, type: result.type, written: handlerState.written, systems: handlerState.systems, asked: Number(handlerState.questionsAsked) || 0, cycle };
    }

    function track(job) {
        running = Promise.resolve(job).finally(() => { running = null; });
        return running;
    }

    /**
     * После хода God будится только Молитвами и Декларацией: достройка
     * Creation — повод при открытии чата, иначе он просыпался бы каждый ход.
     */
    async function maybeRun({ allowBuild = false } = {}) {
        if (running) return { skipped: true, running: true };
        const info = await reasonNow({ allowBuild }).catch(() => null);
        if (!info) return { skipped: true };
        const runId = `god_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const done = await track(enqueue(() => run({ runId, reason: info })));
        // Материал ответил на всё и вопросов нет — мир строится сразу, не дожидаясь следующего открытия чата.
        if (done?.ok && done.kind === 'study' && !done.asked) return maybeRun({ allowBuild: true });
        return done;
    }

    return {
        run, maybeRun, reasonNow, currentTurn, workerFor,
        creation: creationStore,
        setLayout: value => { layout = value; },
        isRunning: () => Boolean(running),
    };
}
