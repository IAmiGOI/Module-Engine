import { buildRecord, restoreGraph, parseImportedRecord, checkLibraryLimits, lorebookFingerprint, summarizeRecord } from '../graph-snapshot.js';

/**
 * Библиотека графов (MEMORY_GRAPH_TYPES_PLAN.md, этап 9): сохранить граф вне чата и открыть в любом чате. Хранит сервис
 * `graphLibrary.*` (indexedDB), формат записи и лимиты — `graph-snapshot.js`; здесь — операции над живым графом. «Открыть» =
 * копировать: запись не меняется, два чата не портят один граф. `ctx` — доступ к состоянию Ядра, см. `core-ops.js`, плюс
 * `graphState()` / `replaceGraph()` / `persistAll()` / `bootstrapActive`.
 */
export function createLibraryOps(ctx) {
    const service = (contract, params) => ctx.callService(contract, params);

    async function currentSource() {
        const character = await service('stCharacter.current');
        const entries = await ctx.call('lorebook.find', {});
        return {
            characterName: character.ok ? character.value?.name ?? null : null,
            chatName: null,
            lorebookFingerprint: entries.ok ? await lorebookFingerprint(entries.value) : null,
        };
    }

    const idOf = () => `graph_${ctx.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const changed = () => ctx.publishEvent('memoryGraph.library.changed', {});

    async function list() {
        const result = await service('graphLibrary.list');
        return result.ok ? (result.value ?? []).sort((a, b) => b.updatedAt - a.updatedAt) : [];
    }

    async function putRecord(record, { replacingId = null } = {}) {
        const limits = checkLibraryLimits(await list(), record.size, replacingId);
        if (!limits.ok) return limits;
        const result = await service('graphLibrary.put', { record });
        if (!result.ok) return { ok: false, error: `Could not save: ${result.error?.message ?? 'storage error'}` };
        changed();
        return { ok: true, id: record.id };
    }

    function recordOfCurrent({ id, name, thumbnail, source, createdAt }) {
        return buildRecord({ id, name, mode: ctx.graphMeta.mode, now: ctx.now(), source, thumbnail, graph: ctx.graphState(), createdAt });
    }

    /** Сохранить текущий граф как новую запись. */
    async function save({ name, thumbnail = null } = {}) {
        return ctx.enqueueWrite(async () => {
            if (!Object.keys(ctx.nodes).length) return { ok: false, error: 'The graph is empty — nothing to save.' };
            const epoch = ctx.epoch;
            const source = await currentSource();
            if (!ctx.stillSameChat(epoch)) return { ok: false, error: 'The chat changed.' };
            const label = String(name ?? '').trim() || `${source.characterName ?? 'Graph'} — ${new Date(ctx.now()).toISOString().slice(0, 10)}`;
            const result = await putRecord(recordOfCurrent({ id: idOf(), name: label, thumbnail, source }));
            if (result.ok) { ctx.applyGraphMeta({ ...ctx.graphMeta, libraryId: result.id }); await ctx.persistGraphMeta(); }
            return result;
        });
    }

    /** Перезаписать запись, из которой граф открыт (или сохранён) — по `graphMeta.libraryId`. */
    async function saveBack({ thumbnail = null } = {}) {
        return ctx.enqueueWrite(async () => {
            const id = ctx.graphMeta.libraryId;
            if (!id) return { ok: false, error: 'This graph was not opened from the library — use Save current graph.' };
            const existing = await service('graphLibrary.get', { id });
            if (!existing.ok || !existing.value) return { ok: false, error: 'The library entry this graph came from no longer exists.' };
            const source = await currentSource();
            return putRecord(recordOfCurrent({ id, name: existing.value.name, thumbnail: thumbnail ?? existing.value.thumbnail, source, createdAt: existing.value.savedAt }), { replacingId: id });
        });
    }

    /**
     * Открыть запись в текущем чате. Непустой граф заменяется только с `confirmed: true` — перед заменой автоснимок
     * «<имя> (before open)». Во время бутстрапа — отказ. `warning` — граф собран из другого лорбука.
     */
    async function open({ id, confirmed = false } = {}) {
        return ctx.enqueueWrite(async () => {
            if (ctx.bootstrapActive) return { ok: false, error: 'A graph is being built right now — wait for it to finish.' };
            const found = await service('graphLibrary.get', { id });
            if (!found.ok || !found.value) return { ok: false, error: 'That graph is no longer in the library.' };
            const record = found.value;
            const nonEmpty = Object.keys(ctx.nodes).length > 0;
            if (nonEmpty && !confirmed) return { ok: false, needsConfirmation: true, error: 'Opening replaces the graph of this chat.' };
            const epoch = ctx.epoch;
            const source = await currentSource();
            if (!ctx.stillSameChat(epoch)) return { ok: false, error: 'The chat changed.' };
            if (nonEmpty) {
                const backup = await putRecord(recordOfCurrent({ id: idOf(), name: `${record.name} (before open)`, source }));
                if (!backup.ok) return backup;
            }
            ctx.replaceGraph(restoreGraph(record, ctx.turnCounter));
            ctx.applyGraphMeta({ mode: record.mode, createdAt: ctx.now(), libraryId: record.id, bootstrapCoreCount: Object.values(ctx.nodes).filter(node => node.core || node.protectedNode).length });
            await ctx.persistAll();
            ctx.publishEvent('memoryGraph.loaded', { libraryId: record.id, mode: record.mode });
            const fingerprint = record.source?.lorebookFingerprint;
            const different = Boolean(fingerprint && source.lorebookFingerprint && fingerprint !== source.lorebookFingerprint);
            return { ok: true, mode: record.mode, ...(different ? { warning: 'This graph was built from a different lorebook.' } : {}) };
        });
    }

    async function rename({ id, name } = {}) {
        return ctx.enqueueWrite(async () => {
            const found = await service('graphLibrary.get', { id });
            const label = String(name ?? '').trim();
            if (!found.ok || !found.value) return { ok: false, error: 'That graph is no longer in the library.' };
            if (!label) return { ok: false, error: 'The name cannot be empty.' };
            return putRecord({ ...found.value, name: label, updatedAt: ctx.now() }, { replacingId: id });
        });
    }

    async function duplicate({ id } = {}) {
        return ctx.enqueueWrite(async () => {
            const found = await service('graphLibrary.get', { id });
            if (!found.ok || !found.value) return { ok: false, error: 'That graph is no longer in the library.' };
            return putRecord({ ...found.value, id: idOf(), name: `${found.value.name} (copy)`, updatedAt: ctx.now() });
        });
    }

    async function remove({ id } = {}) {
        return ctx.enqueueWrite(async () => {
            const result = await service('graphLibrary.delete', { id });
            if (result.ok) changed();
            return { ok: result.ok };
        });
    }

    async function exportRecord({ id } = {}) {
        const found = await service('graphLibrary.get', { id });
        if (!found.ok || !found.value) return { ok: false, error: 'That graph is no longer in the library.' };
        const filename = `${String(found.value.name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'memory-graph'}.json`;
        const result = await service('file.download', { filename, content: JSON.stringify(found.value) });
        return { ok: result.ok, filename };
    }

    /** Импорт из текста файла: чужой формат — отказ; запись с уже существующим `id` не перезаписывается, создаётся копия. */
    async function importRecord({ text } = {}) {
        return ctx.enqueueWrite(async () => {
            const parsed = parseImportedRecord(text);
            if (!parsed.ok) return parsed;
            const taken = new Set((await list()).map(item => item.id));
            const record = taken.has(parsed.record.id) ? { ...parsed.record, id: idOf(), name: `${parsed.record.name} (imported)` } : parsed.record;
            return putRecord(record);
        });
    }

    /** Есть ли в библиотеке граф, собранный из ТЕКУЩЕГО лорбука (подсказка перед бутстрапом): сводка записи или `null`. */
    async function findByLorebook() {
        const source = await currentSource();
        if (!source.lorebookFingerprint) return null;
        const match = (await list()).find(item => item.source?.lorebookFingerprint === source.lorebookFingerprint);
        return match ? summarizeRecord(match) : null;
    }

    return { list, save, saveBack, open, rename, duplicate, remove, exportRecord, importRecord, findByLorebook };
}
