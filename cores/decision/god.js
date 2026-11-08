import { runDecisionCycle, normalizeGenerateAnswer } from '../../libraries/core/decision-agent.js';
import { buildGodToolList } from '../../libraries/core/decision-tools.js';
import { createCycleRecord } from '../../libraries/core/decision-log.js';
import { deciderRequestParams, godWorkerId } from '../../libraries/core/decision-settings.js';
import { buildGodContext, godReason, godMaterial, renderPrayers } from '../../libraries/core/decision-god.js';
import { dayOf } from '../../libraries/core/decision-counsellor.js';
import { createCycleLive } from './live.js';
import { createCreationStore } from './creation.js';
import { createCreationHandlers } from './handlers-creation.js';
import { createFileLayer } from './files-layer.js';
import { createCreationProvider } from './files-creation.js';
import { createFileHandlers } from './handlers-files.js';
import { createRetryRunner } from './retry.js';

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
    call, callTool, store, getSettings, getWorkers, publishEvent,
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
        return { ...legacy, view: files.view, edit: files.edit, create: files.create };
    }

    async function loadMaterial() {
        try {
            const [entries, cards] = await Promise.all([
                call('lorebook.entries').catch(() => []),
                call('stCharacter.chatCharacters').catch(() => []),
            ]);
            const marks = typeof layout?.marksForLorebook === 'function' ? layout.marksForLorebook() : null;
            return godMaterial({ lorebookEntries: entries ?? [], cards: cards ?? [], marks });
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
                const params = deciderRequestParams(settings.decider, { floor: true });
                if (boost > 1 && Number.isFinite(params.maxTokens)) params.maxTokens = Math.min(32768, Math.round(params.maxTokens * boost));
                if (lowerReasoning) params.reasoningEffort = 'low';
                return call('model.generate', {
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
        const material = info.kind === 'prayer' || info.kind === 'declaration' ? '' : await loadMaterial();
        const context = buildGodContext({
            material, creation: state, kind: info.kind, prayers: info.prayers,
            declaration: info.declaration, rpTime: clockLabel(store.clock().minutes),
            questions: (typeof store.papers === 'function' ? store.papers()?.god?.questions ?? [] : []).filter(item => !text(item.answer)),
            maxQuestions: Number(settings.god?.maxQuestions) || 5,
        });
        const handlerState = {
            rpLabel: clockLabel(store.clock().minutes), turn: currentTurn(), questionLimit: Number(settings.god?.maxQuestions) || 5,
            written: [], systems: [], questionsAsked: 0,
        };
        const captured = typeof capture === 'function'
            ? capture(`${runId}:`, { onThinking: value => publishEvent('decision.cycle.thinking', { runId, text: value }) })
            : null;
        live.started({ runId, event: info.kind === 'prayer' ? 'god_prayer' : (info.kind === 'declaration' ? 'god_declaration' : 'god_build'), wake: info.wake, at: startedAt });
        let result;
        try {
            result = await runDecisionCycle({
                messages: context.messages,
                tools: buildGodToolList(),
                generate: generateFor({ settings, worker, runId, startedAt }),
                // Мир — файлами Creation/… (view / edit / create, часть 21); ask — вопрос Советнику.
                handlers: godHandlers(handlerState),
                callTool,
                maxSteps: Math.max(1, Number(settings.god?.maxSteps) || 20),
                implicitAwait: true,
                emptyRetry: false,
                now,
                ...live.hooks({ runId, thinking: () => captured?.value ?? '' }),
            });
        } finally {
            captured?.stop();
        }
        const endedAt = now();
        const event = info.kind === 'prayer' ? 'god_prayer' : (info.kind === 'declaration' ? 'god_declaration' : 'god_build');
        const cycle = createCycleRecord({
            runId, event, messages: context.messages.slice(0), toolCalls: result.trace,
            thinking: captured?.value ?? '', warnings: result.warnings ?? [], usage: captured?.usage ?? null,
            at: startedAt, endedAt, durationMs: endedAt - startedAt,
            wake: { ...info.wake, detail: [info.wake.detail, handlerState.written.length ? `Sections: ${handlerState.written.join(', ')}` : '', handlerState.systems.length ? `Systems: ${handlerState.systems.join(', ')}` : ''].filter(Boolean).join('; ') },
            turn: currentTurn(), clockMinutes: store.clock().minutes, workerId: worker.id,
        });
        await store.appendCycle(cycle).catch(() => null);
        live.finished({ cycle });
        const failed = result.type === 'error';
        if (!failed) {
            // Прочитанные Молитвы и доставленная Декларация больше не будят God.
            const ids = (info.prayers ?? []).map(item => item.id).filter(Boolean);
            if (ids.length) await store.markPrayersRead?.(now(), ids).catch(() => null);
            if (info.kind === 'declaration') await store.consumeDeclaration?.(now()).catch(() => null);
            await store.saveGod?.({ lastRunAt: now(), lastReason: info.wake.detail }).catch(() => null);
        }
        publishEvent('decision.god.finished', { runId, kind: info.kind, sections: handlerState.written.length, systems: handlerState.systems.length });
        return { ok: !failed, kind: info.kind, type: result.type, written: handlerState.written, systems: handlerState.systems, cycle };
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
        return track(enqueue(() => run({ runId, reason: info })));
    }

    return {
        run, maybeRun, reasonNow, currentTurn, workerFor,
        creation: creationStore,
        setLayout: value => { layout = value; },
        isRunning: () => Boolean(running),
    };
}
