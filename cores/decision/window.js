import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { DIRECTOR_WINDOW_SUMMARY, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { libraryLevelsSection, longPlansSection } from '../../libraries/core/decision-library.js';
import {
    buildCorrection, buildCycleDigest, buildFact, buildFrozenRecord, createBoundary,
    normalizeWindow, renderWindow, splitWindow, windowTurnCount,
} from '../../libraries/core/decision-window.js';

/**
 * Плавающее окно директора: дописывает сжатые циклы, факты и поправки,
 * переключается на 50 циклах или на конце арки, пишет сводку выпавших
 * циклов (PROMPTS.md, раздел 12) и обновляет границу блоков 4/6/7/8.
 * Состояние — в памяти чата (`store.window/frozen/boundary`).
 */
export function createTurnWindow({ store, banks = null, call, getSettings, deciderWorker, publishEvent, now = () => Date.now() }) {
    let switching = null;

    function current() {
        const value = typeof store.window === 'function' ? store.window() : null;
        const win = normalizeWindow(value);
        // Первое окно в старом чате: старые закрытые арки не должны
        // переключать его сразу.
        return win.createdAt ? win : { ...win, createdAt: now(), lastSwitchAt: win.lastSwitchAt || now() };
    }

    function save(win) {
        return typeof store.saveWindow === 'function' ? store.saveWindow(win) : Promise.resolve(win);
    }

    async function append(entry) {
        if (!entry?.text) return current();
        const win = current();
        const next = { ...win, entries: [...win.entries, entry] };
        await save(next);
        publishEvent('decision.window.appended', { kind: entry.kind, turn: entry.turn, key: entry.key });
        return next;
    }

    function lastCycleFor(runId) {
        const cycles = typeof store.cycles === 'function' ? store.cycles() : [];
        for (let index = cycles.length - 1; index >= 0; index -= 1) {
            if (cycles[index]?.runId === runId) return cycles[index];
        }
        return null;
    }

    function lastUserText(chat) {
        const list = Array.isArray(chat) ? chat : [];
        for (let index = list.length - 1; index >= 0; index -= 1) {
            const entry = list[index];
            if (entry?.is_user === true) return String(entry.mes ?? entry.content ?? '').trim();
        }
        return '';
    }

    async function recordTurn({ pending = null, stored = null } = {}) {
        const cycle = lastCycleFor(pending?.sourceRunId ?? stored?.id ?? pending?.runId);
        if (!cycle) return false;
        const turn = Number(cycle.turn) || windowTurnCount(current().entries) + 1;
        const entry = buildCycleDigest(cycle, {
            kind: 'turn', turn, userText: lastUserText(pending?.chat),
            writerText: stored?.writerText ?? '', index: windowTurnCount(current().entries), now,
        });
        await append(entry);
        await maybeSwitch();
        return true;
    }

    async function recordBackground(cycle) {
        if (!cycle || String(cycle.event ?? '') === 'typing') return false;
        const kind = String(cycle.event) === 'message' ? 'message' : 'passive';
        const entry = buildCycleDigest(cycle, {
            kind, turn: Number(cycle.turn) || windowTurnCount(current().entries), index: windowTurnCount(current().entries), now,
        });
        await append(entry);
        await maybeSwitch();
        return true;
    }

    async function addFact(textBody, { turn = null } = {}) {
        const turnNumber = Number.isFinite(Number(turn)) ? Number(turn) : windowTurnCount(current().entries);
        await append(buildFact(textBody, { turn: turnNumber, at: now() }));
    }

    function openArcTitle() {
        const arcs = typeof store.arcs === 'function' ? store.arcs() : [];
        return String((Array.isArray(arcs) ? arcs.find(arc => arc.status === 'open') : null)?.title ?? '');
    }

    function closedArcSince(win) {
        const arcs = typeof store.arcs === 'function' ? store.arcs() : [];
        return (Array.isArray(arcs) ? arcs : [])
            .filter(arc => arc.status === 'closed' && Number(arc.closedAt) > Number(win.lastSwitchAt || 0))
            .sort((a, b) => Number(b.closedAt) - Number(a.closedAt))[0] ?? null;
    }

    async function maybeSwitch() {
        if (switching) return switching;
        switching = doMaybeSwitch().finally(() => { switching = null; });
        return switching;
    }

    async function doMaybeSwitch() {
        const win = current();
        const settings = getSettings();
        const limit = Number(settings.windowLimit) || 50;
        if (windowTurnCount(win.entries) >= limit) return switchWindow({ reason: '50 cycles', arc: openArcTitle() });
        const closed = closedArcSince(win);
        if (closed) return switchWindow({ reason: 'the arc ended', arc: closed.title });
        return false;
    }

    async function refreshBoundary() {
        if (typeof store.saveBoundary !== 'function') return null;
        const roster = store.roster().active;
        const boundary = createBoundary({
            roster,
            libraryText: libraryLevelsSection(store.library()),
            plansText: longPlansSection(store.plans(), store.clock().minutes),
            activeBanksText: banks ? banks.contextFor({ names: roster, all: false }).text : '',
            at: now(),
        });
        await store.saveBoundary(boundary);
        return boundary;
    }

    async function summarize(dropped, { reason, arc }) {
        const settings = getSettings();
        try {
            const worker = deciderWorker(settings);
            const prompt = fillPrompt(DIRECTOR_WINDOW_SUMMARY, { cycles: renderWindow(dropped), arc: String(arc ?? ''), reason });
            return String(await call('model.generate', {
                workerId: worker.id, prompt, maxTokens: Number(settings.windowSummaryMaxTokens) || 1200, temperature: 0, stream: false,
            }) ?? '').trim();
        } catch (error) {
            publishEvent('decision.window.warning', { reason: `window summary failed: ${error?.message ?? error}` });
            return '';
        }
    }

    async function switchWindow({ reason = '50 cycles', arc = '' } = {}) {
        const win = current();
        const share = Number(getSettings().windowDropShare) || 0.6;
        const { dropped, kept } = splitWindow(win.entries, { share });
        if (!dropped.length) return false;
        let summary = await summarize(dropped, { reason, arc });
        const fallback = !summary;
        if (fallback) {
            summary = dropped.map(entry => entry.text).join('\n\n');
            publishEvent('decision.window.warning', { reason: 'the window switched without a model summary', dropped: dropped.length });
        }
        const record = buildFrozenRecord({
            text: summary, reason, arc, at: now(), fallback,
            key: `window_${now()}_${dropped.length}`,
        });
        if (typeof store.saveFrozen === 'function') await store.saveFrozen([...(typeof store.frozen === 'function' ? store.frozen() : []), record]);
        await save({ ...win, entries: kept, lastSwitchAt: now() });
        // Полные циклы выпавших ходов уходят в архив; в журнале остаётся окно.
        const droppedTurns = new Set(dropped.filter(entry => entry.kind === 'turn').map(entry => Number(entry.turn)));
        if (droppedTurns.size && typeof store.cycles === 'function' && typeof store.saveLog === 'function') {
            const cycles = store.cycles();
            const keepCycles = cycles.filter(cycle => !droppedTurns.has(Number(cycle.turn)));
            const archived = cycles.filter(cycle => droppedTurns.has(Number(cycle.turn)));
            await store.saveLog(keepCycles, { archived, archiveLimitTokens: Number(getSettings().archiveLimitTokens) || 0 });
        }
        await refreshBoundary();
        try {
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'lorebookSnapshot', value: null });
        } catch { /* the next cycle rebuilds the book if it can */ }
        publishEvent('decision.window.switched', { reason, arc: String(arc ?? ''), dropped: dropped.length, kept: kept.length, fallback });
        return true;
    }

    /** Свайп и перегенерация меняют только последний цикл окна. */
    async function removeLastTurn() {
        const win = current();
        const last = win.entries.map((entry, index) => (entry.kind === 'turn' ? index : -1)).filter(index => index >= 0).at(-1);
        if (last === undefined) return false;
        await save({ ...win, entries: win.entries.slice(0, last) });
        return true;
    }

    /** Удаление или правка старого сообщения: строка-поправка в конец окна. */
    async function noteCorrection({ mesid, action = 'deleted' } = {}) {
        const run = (typeof store.runs === 'function' ? store.runs() : {})[String(mesid)];
        if (!run?.id) return false;
        const runId = run.sourceRunId ?? run.id;
        const match = current().entries.find(entry => Array.isArray(entry.runIds) && entry.runIds.includes(runId));
        if (!match) return false;
        await append(buildCorrection(`turn ${match.turn}: message ${action} by the user`, { turn: match.turn, at: now() }));
        return true;
    }

    async function rebuildBoundary() {
        return refreshBoundary();
    }

    return {
        recordTurn, recordBackground, addFact, maybeSwitch, switchWindow,
        removeLastTurn, noteCorrection, refreshBoundary, rebuildBoundary,
        entries: () => current().entries, frozen: () => (typeof store.frozen === 'function' ? store.frozen() : []),
    };
}
