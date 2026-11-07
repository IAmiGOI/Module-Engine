import { splitBankImportance, bankSourcesForChat, findBankSource, createBankRecord, hashText, bankSizeBand, bankIsReady, renderBankSection, renderExampleSection, BANK_BUILDER_VERSION, bankFrameHash } from '../../libraries/core/decision-banks.js';
import { createBankStore } from './bank-store.js';
import { createTimelineAdjust } from './bank-timeline.js';
import { createBankTasks, bankConcurrency } from './bank-tasks.js';
import { createLorebookMarker } from './lorebook-marker.js';
import { createGreatBankLayer } from './bank-great-layer.js';

/**
 * Дата-банки персонажей: два слоя (общий и копия чата), холодный запуск перед
 * первым ходом, короткий банк для нового ростера, инструменты директора.
 * Модель зовётся только субагентом через `bank-tasks.js`.
 */
export function createCharacterBanks({ call, callService, getSettings, getWorkers = () => [], store, researcher, publishEvent, now = () => Date.now() }) {
    const bankStore = createBankStore({ call });
    const tasks = createBankTasks({ getSettings, researcher, publishEvent });
    const marker = createLorebookMarker({ call, getSettings, getWorkers, publishEvent });
    const greatLayer = createGreatBankLayer({ call, store, banks: { records: () => records() }, publishEvent, getSettings });
    let coldStartPromise = null;
    let queueRunning = null; // очередь сборки живёт дольше холодного старта (он отпускает ход по таймауту)
    let sourcesCache = [];
    let markWarnings = [];
    const timelineQueue = new Set();

    const brief = () => (typeof store.chatBrief === 'function' ? store.chatBrief() : null);
    function currentTimeline() { return String(brief()?.timeline ?? '').trim(); }
    function currentGuide() { return String(brief()?.bankGuide ?? '').trim(); }
    function keyOf(name) { return String(name ?? '').trim().toLowerCase(); }
    function matchesName(record, name) {
        const wanted = keyOf(name);
        if (!wanted) return false;
        return [record?.name, record?.canonicalName, ...(record?.aliases ?? [])].some(value => keyOf(value) === wanted);
    }
    const timelineAdjust = createTimelineAdjust({
        call, getSettings, publishEvent, bankStore, records: () => records(), matchesName, currentTimeline, currentGuide, queue: timelineQueue,
    });

    // Нижняя граница важности: главный персонаж карточки, персона, сцена, уровни 1–2 библиотеки.
    // Выше неё важность решает сборщик (строка IMPORTANCE в банке).
    function sizeFor(source, importance = null) {
        const record = Object.values(store.library()).find(item => keyOf(item.name) === keyOf(source.name));
        const floor = bankSizeBand({ level: record?.level, isMain: source.sizeBand === 'key' || ['scene', 'persona'].includes(source.sourceKind) });
        return importance === 'key' ? 'key' : floor;
    }
    const withFloor = source => ({ ...source, sizeBand: sizeFor(source), timeline: currentTimeline(), guide: currentGuide() });

    /** Разметка книг — в `lorebook-marker.js`; здесь только сбор источников и предупреждения. */
    async function markLorebooks(entries, cards) {
        markWarnings = await marker.markBooks({
            entries, cards, marks: bankStore.marks(), saveMarks: next => bankStore.saveMarks(next), now,
        });
        return bankStore.marks();
    }

    async function collectSources() {
        const [cards, persona, entries] = await Promise.all([
            callService('stCharacter.chatCharacters').catch(() => []),
            callService('stCharacter.persona').catch(() => null),
            call('lorebook.entries').catch(() => []),
        ]);
        const lorebookMarks = await markLorebooks(entries, cards);
        sourcesCache = bankSourcesForChat({ cards, persona, lorebookEntries: entries, lorebookMarks });
        return sourcesCache;
    }

    function historySource(name) {
        return {
            sourceKey: `history:${keyOf(name)}`, sourceKind: 'history', name,
            source: `Name: ${name}\nThe character is known only from the story so far.`, sizeBand: 'minor', examples: '',
        };
    }

    async function saveReady(source, answer, epoch = bankStore.epoch()) {
        if (epoch !== bankStore.epoch()) return null; // сборка старого чата: в новый не пишем
        const { text, importance } = splitBankImportance(answer);
        const record = createBankRecord({
            sourceKey: source.sourceKey, sourceKind: source.sourceKind, name: source.name,
            sourceHash: hashText(source.source), text, sizeBand: sizeFor(source, importance), rawSource: source.source,
            examples: source.examples ?? '', aliases: source.aliases ?? [], canonicalName: source.canonicalName ?? '', status: 'ready',
            builderVersion: BANK_BUILDER_VERSION, timelineHash: bankFrameHash(source.timeline, source.guide),
        });
        await bankStore.putBase({ ...record, rawSource: '' });
        await bankStore.putChat(record);
        // Сводка (или указание сборщикам) появилась, пока банк строился, — банк собран не под неё: правка сразу.
        timelineQueue.delete(source.name);
        const frame = bankFrameHash(currentTimeline(), currentGuide());
        if (frame && record.timelineHash !== frame) await timelineAdjust.adjustOne(record, currentTimeline(), '');
        return record;
    }

    async function markError(source, error, epoch = bankStore.epoch()) {
        if (epoch !== bankStore.epoch()) return null;
        const previous = bankStore.chat()[source.sourceKey];
        const record = createBankRecord({
            sourceKey: source.sourceKey, sourceKind: source.sourceKind, name: source.name,
            sourceHash: hashText(source.source), text: previous?.text ?? '', sizeBand: sizeFor(source),
            rawSource: source.source, examples: source.examples ?? '', status: 'error', error: error?.message ?? String(error),
        });
        await bankStore.putChat(record);
        publishEvent('decision.bank.failed', { sourceKey: source.sourceKey, name: source.name, message: record.error });
        return record;
    }

    function progress(extra = {}) {
        const state = bankStore.coldStart();
        const records = Object.values(bankStore.chat());
        return {
            ...state,
            done: records.filter(record => record.status !== 'pending').length,
            total: Math.max(state.total, records.length),
            errors: records.filter(record => record.status === 'error').length,
            ...extra,
        };
    }

    async function runColdStart() {
        const startEpoch = bankStore.epoch();
        const sources = await collectSources();
        if (startEpoch !== bankStore.epoch()) return progress({ stale: true });
        const base = bankStore.base();
        const chat = { ...bankStore.chat() };
        const pending = [];
        for (const source of sources) {
            const hash = hashText(source.source);
            const own = chat[source.sourceKey];
            if (bankIsReady(own) && own.sourceHash === hash) continue;
            const cached = base[source.sourceKey];
            if (bankIsReady(cached) && cached.sourceHash === hash) {
                chat[source.sourceKey] = createBankRecord({ ...cached, rawSource: source.source, examples: source.examples ?? '', status: 'ready' });
                continue;
            }
            // Пока новый банк строится, старый текст остаётся в работе: директор и писатель не теряют персонажа.
            chat[source.sourceKey] = createBankRecord({
                sourceKey: source.sourceKey, sourceKind: source.sourceKind, name: source.name,
                sourceHash: hash, sizeBand: own?.sizeBand ?? sizeFor(source), rawSource: source.source, examples: source.examples ?? '',
                aliases: source.aliases ?? [], canonicalName: source.canonicalName ?? '', status: 'pending',
                text: own?.text ?? cached?.text ?? '',
            });
            pending.push(source);
        }
        await bankStore.saveChat(chat);
        await bankStore.saveColdStart({ status: 'running', builderVersion: BANK_BUILDER_VERSION, total: sources.length, done: progress().done, errors: 0, startedAt: now(), warnings: markWarnings });
        if (!pending.length) {
            await bankStore.saveColdStart({ status: 'ready', done: sources.length, total: sources.length, errors: 0, warnings: markWarnings });
            return progress({ timedOut: false, sources: sources.length });
        }
        const epoch = startEpoch;
        const running = queueRunning = tasks.runQueue(pending.map(withFloor), {
            isCurrent: () => epoch === bankStore.epoch(),
            concurrency: bankConcurrency(getSettings()),
            onDone: async (source, text) => { if (await saveReady(source, text, epoch)) await bankStore.saveColdStart(progress()); },
            onError: async (source, error) => { if (await markError(source, error, epoch)) await bankStore.saveColdStart(progress()); },
        });
        const timeoutMs = Math.max(1, Number(getSettings().bankColdStartTimeoutMs) || 120000);
        let timer = null;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); });
        running.finally(() => { if (queueRunning === running) queueRunning = null; }).catch(() => {});
        const timedOut = await Promise.race([running.then(() => false, () => false), timeout]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
            await bankStore.saveColdStart(progress({ status: 'partial', timedOut: true }));
            publishEvent('decision.bank.timeout', { done: progress().done, total: sources.length, timeoutMs });
            return progress({ timedOut: true, sources: sources.length });
        }
        await bankStore.saveColdStart(progress({ status: 'ready', warnings: markWarnings }));
        return progress({ timedOut: false, sources: sources.length });
    }

    function ensureColdStart() {
        if (coldStartPromise) return coldStartPromise;
        if (queueRunning) return Promise.resolve(progress()); // банки ещё строятся в этой вкладке — второй очереди не нужно
        const state = bankStore.coldStart();
        // Новая версия сборщика: старый холодный старт не считается — банки пересоберутся один раз.
        const current = Number(state.builderVersion) === BANK_BUILDER_VERSION;
        // Банки, упавшие только из-за занятых сборщиков (старая ошибка), пересобираются сами.
        const busyFailed = records().some(record => record.status === 'error' && /busy/i.test(String(record.error ?? '')));
        // «pending» без живой очереди в этой вкладке — сборка оборвалась (перезагрузка, таймаут холодного старта): продолжить.
        const unfinished = records().some(record => record.status === 'pending' || record.status === 'short');
        if (current && !busyFailed && !unfinished && (state.status === 'ready' || state.status === 'partial')) return Promise.resolve(progress());
        coldStartPromise = runColdStart().finally(() => { coldStartPromise = null; });
        return coldStartPromise;
    }

    /** Новый персонаж в ростере: короткий банк сразу, полный — фоновой задачей. */
    async function ensureName(name) {
        const clean = String(name ?? '').trim();
        if (!clean) return null;
        const sources = sourcesCache.length ? sourcesCache : await collectSources();
        const source = findBankSource(sources, clean) ?? historySource(clean);
        const chat = bankStore.chat();
        const existing = chat[source.sourceKey] ?? records().find(record => matchesName(record, clean));
        if (bankIsReady(existing) && existing.sourceHash === hashText(source.source)) return existing;
        const shortText = `***${source.name || clean}***\n${source.source.slice(0, 1200)}`;
        const short = createBankRecord({
            sourceKey: source.sourceKey, sourceKind: source.sourceKind, name: source.name || clean,
            sourceHash: hashText(source.source), text: shortText, sizeBand: sizeFor(source),
            rawSource: source.source, examples: source.examples ?? '', aliases: source.aliases ?? [],
            canonicalName: source.canonicalName ?? '', status: 'short',
        });
        await bankStore.putChat(short);
        publishEvent('decision.bank.short', { sourceKey: source.sourceKey, name: short.name });
        { const epoch = bankStore.epoch(); tasks.build(withFloor(source)).then(text => saveReady(source, text, epoch)).catch(error => markError(source, error, epoch)); }
        return short;
    }

    async function noteRosterAdded(names) {
        for (const name of Array.isArray(names) ? names : []) await ensureName(name);
    }

    function records() { return Object.values(bankStore.chat()); }
    function recordsFor(names) {
        const wanted = Array.isArray(names) ? names : [];
        return records().filter(record => wanted.some(name => matchesName(record, name)));
    }
    function primary(kind) { return records().find(record => record.sourceKind === kind) ?? null; }

    async function read({ name } = {}) {
        return name ? records().filter(record => matchesName(record, name)) : records();
    }

    async function write({ name, text: bankText } = {}) {
        const clean = String(name ?? '').trim();
        const value = String(bankText ?? '').trim();
        if (!clean || !value) return { ok: false, error: 'A bank needs a name and text.' };
        const existing = records().find(record => matchesName(record, clean));
        const record = createBankRecord({
            ...(existing ?? { sourceKey: `manual:${keyOf(clean)}`, sourceKind: 'manual', name: clean, sourceHash: hashText(value), examples: '' }),
            text: value, status: 'ready', error: null, name: existing?.name ?? clean, builderVersion: BANK_BUILDER_VERSION,
            sourceHash: existing?.sourceHash ?? hashText(value),
        });
        await bankStore.putChat(record);
        publishEvent('decision.bank.edited', { sourceKey: record.sourceKey, name: record.name });
        return { ok: true, bank: record };
    }

    async function rebuild({ name } = {}) {
        const clean = String(name ?? '').trim();
        if (!sourcesCache.length) await collectSources();
        const source = findBankSource(sourcesCache, clean) ?? historySource(clean);
        { const epoch = bankStore.epoch(); tasks.build(withFloor(source)).then(text => saveReady(source, text, epoch)).catch(error => markError(source, error, epoch)); }
        return { ok: true, queued: true, sourceKey: source.sourceKey, name: source.name };
    }

    async function reload() {
        coldStartPromise = null;
        queueRunning = null;
        sourcesCache = [];
        const loaded = await bankStore.load();
        // Банки из набора другого чата или собранные до сводки — догнать под рамку этого чата, в фоне.
        if (bankFrameHash(currentTimeline(), currentGuide())) timelineAdjust.applyTimeline({ timelineBanks: brief()?.timelineBanks ?? [] }).catch(() => {});
        return loaded;
    }

    async function reset() {
        coldStartPromise = null;
        queueRunning = null;
        sourcesCache = [];
        await bankStore.saveColdStart({ status: 'idle', total: 0, done: 0, errors: 0, startedAt: 0 });
    }

    function contextFor({ names = [], all = false } = {}) {
        const wanted = Array.isArray(names) ? names : [];
        const chosen = records().filter(record => all || wanted.some(name => matchesName(record, name)) || record.sourceKind === 'persona' || record.sourceKind === 'scene');
        return { text: renderBankSection(chosen), examples: renderExampleSection(chosen.filter(record => record.sourceKind === 'card')), records: chosen };
    }

    /** Готовый набор банков (сохранённый bootstrap прошлого чата) — сразу в чат, как собранные. */
    async function applySet(set) {
        const chat = { ...bankStore.chat() };
        let applied = 0;
        for (const [sourceKey, bank] of Object.entries(set?.banks ?? {})) {
            if (!String(bank?.text ?? '').trim()) continue;
            chat[sourceKey] = createBankRecord({ ...bank, sourceKey, status: 'ready', error: null, builderVersion: BANK_BUILDER_VERSION });
            applied += 1;
        }
        await bankStore.saveChat(chat);
        publishEvent('decision.bank.edited', { sourceKey: '', name: '', applied });
        return applied;
    }

    function examplesForCards() { return renderExampleSection(records().filter(record => record.sourceKind === 'card')); }


    return {
        reload, reset, ensureColdStart, ensureName, noteRosterAdded, applyTimeline: timelineAdjust.applyTimeline,
        contextFor, examplesForCards,
        farContext: greatLayer.farContext, nearContext: greatLayer.nearContext, edit: greatLayer.edit, decreeFor: greatLayer.decreeFor,
        writerContext: names => greatLayer.writerContext(names, {
            sceneText: () => renderBankSection(records().filter(record => record.sourceKind === 'scene')),
        }),
        great: greatLayer.great,
        read, write, rebuild, progress,
        records, recordsFor,
        applySet,
        hasAnyText: () => records().some(record => String(record?.text ?? '').trim()),
        marksForLorebook: () => bankStore.marks(),
        scene: () => primary('scene'),
        persona: () => primary('persona'),
        examplesFor: names => recordsFor(names).map(record => record.examples).filter(Boolean),
    };
}
