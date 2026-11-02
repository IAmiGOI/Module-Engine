import { bankSourcesForChat, findBankSource, createBankRecord, hashText, bankSizeBand, bankIsReady, renderBankSection, renderExampleSection, planLorebookMarking } from '../../libraries/core/decision-banks.js';
import { createBankStore } from './bank-store.js';
import { createBankTasks } from './bank-tasks.js';
import { createLorebookMarker } from './lorebook-marker.js';

/**
 * Дата-банки персонажей: два слоя (общий и копия чата), холодный запуск перед
 * первым ходом, короткий банк для нового ростера, инструменты директора.
 * Модель зовётся только субагентом через `bank-tasks.js`.
 */
export function createCharacterBanks({ call, callService, getSettings, getWorkers = () => [], store, researcher, publishEvent, now = () => Date.now() }) {
    const bankStore = createBankStore({ call });
    const tasks = createBankTasks({ getSettings, researcher, publishEvent });
    const marker = createLorebookMarker({ call, getSettings, getWorkers, publishEvent });
    let coldStartPromise = null;
    let sourcesCache = [];
    let markWarnings = [];

    function keyOf(name) { return String(name ?? '').trim().toLowerCase(); }
    function matchesName(record, name) {
        const wanted = keyOf(name);
        if (!wanted) return false;
        return [record?.name, record?.canonicalName, ...(record?.aliases ?? [])].some(value => keyOf(value) === wanted);
    }

    function sizeFor(source) {
        const record = Object.values(store.library()).find(item => keyOf(item.name) === keyOf(source.name));
        return bankSizeBand({ level: record?.level, isMain: !['scene', 'persona'].includes(source.sourceKind) && source.sizeBand === 'key' });
    }

    async function markLorebooks(entries, cards) {
        markWarnings = [];
        const stored = bankStore.marks();
        const byBook = new Map();
        for (const entry of Array.isArray(entries) ? entries : []) {
            const book = String(entry?.book ?? '').trim() || 'Lorebook';
            if (!byBook.has(book)) byBook.set(book, []);
            byBook.get(book).push(entry);
        }
        const cardHint = (Array.isArray(cards) ? cards : []).map(card => [card.name, ...(card.tags ?? [])].filter(Boolean).join(' — ')).filter(Boolean).join('; ');
        for (const [book, list] of byBook) {
            const plan = planLorebookMarking(stored[book], list);
            const record = marks => ({ sourceHash: plan.sourceHash, entryHashes: plan.entryHashes, marks, at: now() });
            if (!plan.toMark.length) {
                // Ничего нового: удалённые записи просто теряют отметки, запрос не нужен.
                if (stored[book]?.sourceHash !== plan.sourceHash || !stored[book]?.entryHashes) await bankStore.saveMarks({ ...bankStore.marks(), [book]: record(plan.kept) });
                continue;
            }
            try {
                const result = await marker.mark({ book, entries: plan.toMark, sectionsFrom: list, cardHint });
                await bankStore.saveMarks({ ...bankStore.marks(), [book]: record([...plan.kept, ...result.marks]) });
            } catch (error) {
                const message = `Lorebook "${book}" was not marked (${error?.message ?? error}); using sections.`;
                markWarnings.push(message);
                publishEvent('decision.bank.warning', { book, message });
            }
        }
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

    async function saveReady(source, text) {
        const record = createBankRecord({
            sourceKey: source.sourceKey, sourceKind: source.sourceKind, name: source.name,
            sourceHash: hashText(source.source), text, sizeBand: sizeFor(source), rawSource: source.source,
            examples: source.examples ?? '', aliases: source.aliases ?? [], canonicalName: source.canonicalName ?? '', status: 'ready',
        });
        await bankStore.putBase({ ...record, rawSource: '' });
        await bankStore.putChat(record);
        return record;
    }

    async function markError(source, error) {
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
        const sources = await collectSources();
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
            chat[source.sourceKey] = createBankRecord({
                sourceKey: source.sourceKey, sourceKind: source.sourceKind, name: source.name,
                sourceHash: hash, sizeBand: sizeFor(source), rawSource: source.source, examples: source.examples ?? '',
                aliases: source.aliases ?? [], canonicalName: source.canonicalName ?? '', status: 'pending',
            });
            pending.push(source);
        }
        await bankStore.saveChat(chat);
        await bankStore.saveColdStart({ status: 'running', total: sources.length, done: progress().done, errors: 0, startedAt: now(), warnings: markWarnings });
        if (!pending.length) {
            await bankStore.saveColdStart({ status: 'ready', done: sources.length, total: sources.length, errors: 0, warnings: markWarnings });
            return progress({ timedOut: false, sources: sources.length });
        }
        const running = tasks.runQueue(pending, {
            concurrency: 2,
            onDone: async (source, text) => { await saveReady(source, text); await bankStore.saveColdStart(progress()); },
            onError: async (source, error) => { await markError(source, error); await bankStore.saveColdStart(progress()); },
        });
        const timeoutMs = Math.max(1, Number(getSettings().bankColdStartTimeoutMs) || 120000);
        let timer = null;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); });
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
        const state = bankStore.coldStart();
        if (state.status === 'ready' || state.status === 'partial') return Promise.resolve(progress());
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
        tasks.build(source).then(text => saveReady(source, text)).catch(error => markError(source, error));
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
            text: value, status: 'ready', error: null, name: existing?.name ?? clean,
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
        tasks.build(source).then(text => saveReady(source, text)).catch(error => markError(source, error));
        return { ok: true, queued: true, sourceKey: source.sourceKey, name: source.name };
    }

    async function reload() {
        coldStartPromise = null;
        sourcesCache = [];
        return bankStore.load();
    }

    async function reset() {
        coldStartPromise = null;
        sourcesCache = [];
        await bankStore.saveColdStart({ status: 'idle', total: 0, done: 0, errors: 0, startedAt: 0 });
    }

    function contextFor({ names = [], all = false } = {}) {
        const wanted = Array.isArray(names) ? names : [];
        const chosen = records().filter(record => all || wanted.some(name => matchesName(record, name)) || record.sourceKind === 'persona' || record.sourceKind === 'scene');
        return { text: renderBankSection(chosen), examples: renderExampleSection(chosen.filter(record => record.sourceKind === 'card')), records: chosen };
    }

    function examplesForCards() { return renderExampleSection(records().filter(record => record.sourceKind === 'card')); }

    return {
        reload, reset, ensureColdStart, ensureName, noteRosterAdded,
        contextFor, examplesForCards,
        read, write, rebuild, progress,
        records, recordsFor,
        marksForLorebook: () => bankStore.marks(),
        scene: () => primary('scene'),
        persona: () => primary('persona'),
        examplesFor: names => recordsFor(names).map(record => record.examples).filter(Boolean),
    };
}
