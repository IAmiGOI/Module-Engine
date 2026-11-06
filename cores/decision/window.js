import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';
import { DIRECTOR_WINDOW_SUMMARY, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { libraryLevelsSection, longPlansSection } from '../../libraries/core/decision-library.js';
import { renderChatBrief } from '../../libraries/core/decision-brief.js';
import {
    buildCorrection, buildCycleDigest, buildFact, buildFrozenRecord, createBoundary,
    normalizeWindow, renderWindow, splitWindow, windowTurnCount, lastTurnNumber,
} from '../../libraries/core/decision-window.js';

const FALLBACK_CHARS = 8000;

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
        const cycle = lastCycleFor(pending?.sourceRunId ?? stored?.sourceRunId ?? stored?.id ?? pending?.runId);
        if (!cycle) return false;
        const turn = Number(cycle.turn) || lastTurnNumber(current().entries) + 1;
        const entry = buildCycleDigest(cycle, {
            kind: 'turn', turn, userText: lastUserText(pending?.chat),
            writerText: stored?.writerText ?? '', index: windowTurnCount(current().entries), now,
        });
        // Свайп/регенерация: успешный новый цикл заменяет прежний цикл того же
        // хода. Если генерация сорвалась, старый цикл остаётся в окне.
        // Заменяется только ПОСЛЕДНИЙ ход окна и только при том же номере. Раньше искался любой ход с этим номером,
        // и сброшенный после перезагрузки счётчик («ход 1») обрезал окно до первого хода — история стиралась.
        const win = current();
        const lastTurn = win.entries.map((item, index) => (item.kind === 'turn' ? index : -1)).filter(index => index >= 0).at(-1);
        if (lastTurn !== undefined && Number(win.entries[lastTurn].turn) === turn) await save({ ...win, entries: win.entries.slice(0, lastTurn) });
        await append(entry);
        await maybeSwitch();
        return true;
    }

    async function recordBackground(cycle) {
        if (!cycle || String(cycle.event ?? '') === 'typing') return false;
        const kind = String(cycle.event) === 'message' ? 'message' : 'passive';
        const entry = buildCycleDigest(cycle, {
            kind, turn: Number(cycle.turn) || lastTurnNumber(current().entries), index: windowTurnCount(current().entries), now,
        });
        await append(entry);
        await maybeSwitch();
        return true;
    }

    async function addFact(textBody, { turn = null } = {}) {
        const turnNumber = Number.isFinite(Number(turn)) ? Number(turn) : lastTurnNumber(current().entries);
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
            chatBriefText: renderChatBrief(typeof store.chatBrief === 'function' ? store.chatBrief() : null),
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
            // Без ризонинга: у DeepSeek он съедал весь лимит, сводка приходила пустой, и в контекст ложились все выпавшие ходы целиком.
            const ask = maxTokens => call('model.generate', {
                workerId: worker.id, prompt, maxTokens, temperature: 0, stream: false,
                reasoningMode: 'disabled', reasoningEffort: 'low', reasoningBudget: 0,
            }).then(answer => String(answer ?? '').trim());
            const limit = Math.max(Number(settings.windowSummaryMaxTokens) || 0, 3000);
            return (await ask(limit)) || (await ask(limit * 2));
        } catch (error) {
            publishEvent('decision.window.warning', { reason: `window summary failed: ${error?.message ?? error}` });
            return '';
        }
    }

    /**
     * Запас без сводки — коротко: строка пользователя и начало ответа писателя на ход, не больше FALLBACK_CHARS.
     * Раньше сюда ложились все выпавшие ходы целиком (100–180 тыс. символов на окно) и уходили в каждый запрос директора.
     */
    function compactFallback(dropped) {
        const lines = dropped.map(entry => {
            const rows = String(entry.text ?? '').split('\n');
            const head = rows[0] ?? '';
            const user = rows.find(row => row.startsWith('User: ')) ?? '';
            const writer = rows.find(row => row.startsWith('Writer: ')) ?? '';
            return [head, user.slice(0, 300), writer.slice(0, 300)].filter(Boolean).join('\n');
        });
        const body = lines.join('\n\n');
        return body.length > FALLBACK_CHARS ? body.slice(body.length - FALLBACK_CHARS) : body;
    }

    /** Старые запасные записи (`fallback`) пересказываются заново; не вышло — сжимаются до короткого запаса. */
    async function repairFrozen() {
        const records = typeof store.frozen === 'function' ? store.frozen() : [];
        const bloated = record => record?.fallback && String(record.text ?? '').length > FALLBACK_CHARS;
        if (!Array.isArray(records) || !records.some(bloated)) return false;
        const next = [];
        for (const record of records) {
            if (!bloated(record)) { next.push(record); continue; }
            const entries = String(record.text ?? '').split(/\n\n(?=TURN |PASSIVE CYCLE|MESSAGE TO THE DIRECTOR|FACT)/).map(text => ({ text }));
            const summary = await summarize(entries, { reason: record.reason ?? '50 cycles', arc: record.arc ?? '' });
            next.push(summary ? { ...record, text: summary, fallback: false } : { ...record, text: compactFallback(entries) });
        }
        if (typeof store.saveFrozen === 'function') await store.saveFrozen(next);
        publishEvent('decision.window.rebuilt', { frozen: next.length });
        return true;
    }

    async function switchWindow({ reason = '50 cycles', arc = '' } = {}) {
        const win = current();
        const share = Number(getSettings().windowDropShare) || 0.6;
        const { dropped, kept } = splitWindow(win.entries, { share });
        if (!dropped.length) return false;
        let summary = await summarize(dropped, { reason, arc });
        const fallback = !summary;
        if (fallback) {
            summary = compactFallback(dropped);
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

    /**
     * Ремонт окна, стёртого старой ошибкой (сброшенный счётчик ходов обрезал окно до «хода 1»): ходы собираются заново
     * из записей `runs` (Push и форма принятой версии каждого ответа) и текста чата. Только если окно не переключалось
     * и ходов в нём меньше, чем ответов с записью; без загруженного чата — не трогаем.
     */
    async function rebuildFromRuns() {
        const runs = typeof store.runs === 'function' ? store.runs() : {};
        const keys = Object.keys(runs).filter(key => String(runs[key]?.push ?? '').trim()).sort((a, b) => Number(a) - Number(b));
        const win = current();
        const turns = win.entries.filter(entry => entry.kind === 'turn');
        if (!keys.length || turns.length >= keys.length) return false;
        if ((typeof store.frozen === 'function' ? store.frozen() : []).length) return false;
        const messages = await call('chatHistory.messages', { limit: 100000 }).catch(() => []);
        const list = Array.isArray(messages) ? messages : [];
        const byId = new Map(list.map(message => [String(message.mesid), message]));
        if (!keys.every(key => byId.has(String(key)))) return false;
        const userBefore = mesid => {
            for (let index = Number(mesid) - 1; index >= 0; index -= 1) {
                const message = byId.get(String(index));
                if (message?.isUser) return String(message.text ?? '');
            }
            return '';
        };
        const firstTurn = win.entries.findIndex(entry => entry.kind === 'turn');
        const head = firstTurn >= 0 ? win.entries.slice(0, firstTurn) : win.entries;
        const rebuilt = keys.map((key, index) => buildCycleDigest(
            { push: runs[key].push, form: runs[key].form, turn: index + 1 },
            { kind: 'turn', turn: index + 1, userText: userBefore(key), writerText: String(byId.get(String(key))?.text ?? ''), index, now },
        ));
        await save({ ...win, entries: [...head, ...rebuilt] });
        publishEvent('decision.window.rebuilt', { turns: rebuilt.length, before: turns.length });
        return true;
    }

    /**
     * Записи хода, сохранённые без ответа писателя (`chatHistory.messages` отдаёт `text`, а читалось `mes`):
     * ответ берётся из чата по записи хода, Push из записи убирается. Директор видел только свои Push и копировал их.
     */
    async function fillWriterText() {
        const runs = typeof store.runs === 'function' ? store.runs() : {};
        const win = current();
        const missing = win.entries.filter(entry => entry.kind === 'turn' && !/\nWriter: /.test(entry.text) && entry.runIds.length);
        if (!missing.length) return false;
        const mesidByRun = new Map();
        for (const [key, run] of Object.entries(runs ?? {})) {
            for (const id of [run?.id, run?.sourceRunId]) if (id) mesidByRun.set(String(id), String(run?.mesid ?? key));
        }
        const messages = await call('chatHistory.messages', { limit: 100000 }).catch(() => []);
        const byId = new Map((Array.isArray(messages) ? messages : []).map(message => [String(message.mesid), message]));
        let changed = 0;
        const entries = win.entries.map(entry => {
            if (!missing.includes(entry)) return entry;
            const mesid = entry.runIds.map(id => mesidByRun.get(id)).find(Boolean);
            const reply = String(byId.get(String(mesid))?.text ?? '').trim();
            if (!mesid || !reply || byId.get(String(mesid))?.isUser) return entry;
            changed += 1;
            const lines = entry.text.split('\n');
            const start = lines.indexOf('PUSH:');
            const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && (/^[a-z]+(?:_[a-z]+)+: /.test(line) || line === 'CHANGES:'));
            const kept = start < 0 ? lines : [...lines.slice(0, start), ...(end < 0 ? [] : lines.slice(end))];
            const body = [...kept, `Writer: ${reply}`].join('\n');
            return { ...entry, text: body, tokens: Math.ceil(body.length / 4) };
        });
        if (!changed) return false;
        await save({ ...win, entries });
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
        recordTurn, recordBackground, addFact, maybeSwitch, switchWindow, rebuildFromRuns, fillWriterText, repairFrozen,
        removeLastTurn, noteCorrection, refreshBoundary, rebuildBoundary,
        entries: () => current().entries, frozen: () => (typeof store.frozen === 'function' ? store.frozen() : []),
    };
}
