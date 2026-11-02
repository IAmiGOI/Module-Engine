import { DECISION_MEMORY_NAMESPACE } from '../../libraries/core/decision-settings.js';

/**
 * Хранение блоков и записей прогонов директора в памяти чата. Вынесено из
 * самого ядра, чтобы у него осталась только логика хода (и файл не рос за
 * 300 строк). Запись сериализована собственной очередью: `persist()`
 * читает-меняет-пишет и `runs`, и `blocks`, поэтому два одновременных
 * завершения не должны затирать друг друга.
 */
export function createDecisionStore({ call, publishEvent }) {
    let blocks = [];
    let runs = {};
    let tail = Promise.resolve();

    function enqueue(task) {
        const run = tail.then(task, task);
        tail = run.then(() => {}, () => {});
        return run;
    }

    function sanitizeBlocks(value) {
        return (Array.isArray(value) ? value : [])
            .filter(block => block && typeof block === 'object')
            .map((block, index) => ({
                id: String(block.id ?? '').trim() || `blk_recovered_${index}`,
                title: String(block.title ?? '').trim() || 'Untitled',
                text: String(block.text ?? ''),
                updatedAt: Number.isFinite(block.updatedAt) ? block.updatedAt : 0,
            }));
    }

    function sanitizeRuns(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const out = {};
        for (const [mesid, record] of Object.entries(value)) {
            if (!record || typeof record !== 'object') continue;
            if (!String(record.decision ?? '').trim()) continue;
            out[mesid] = { ...record, mesid: String(record.mesid ?? mesid) };
        }
        return out;
    }

    async function reload() {
        const [storedBlocks, storedRuns] = await Promise.all([
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'blocks', fallback: [] }),
            call('storage.chatMemory.get', { namespace: DECISION_MEMORY_NAMESPACE, key: 'runs', fallback: {} }),
        ]);
        blocks = sanitizeBlocks(storedBlocks);
        runs = sanitizeRuns(storedRuns);
        publishEvent('decision.blocks.changed', { count: blocks.length });
        return { blocks, runs };
    }

    function lastRun() {
        const list = Object.values(runs).sort((a, b) => (Number(a.mesid) || 0) - (Number(b.mesid) || 0) || (Number(a.at) || 0) - (Number(b.at) || 0));
        return list.at(-1) ?? null;
    }

    function persist(record) {
        return enqueue(async () => {
            const messages = await call('chatHistory.messages', { limit: 1, includeSystem: true });
            const last = Array.isArray(messages) ? messages.at(-1) : null;
            const mesid = String(last?.mesid ?? Math.max(0, record.chatLength));
            const stored = {
                id: record.runId, mesid, at: Date.now(), type: record.type, decision: record.decision,
                reasoning: record.reasoning ?? '', steps: record.steps ?? [], workerId: record.workerId ?? null,
                warnings: record.warnings ?? [],
            };
            runs = { ...runs, [mesid]: stored };
            await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'runs', value: runs });
            if (record.edits?.length && record.blocksAfter) {
                blocks = record.blocksAfter;
                await call('storage.chatMemory.set', { namespace: DECISION_MEMORY_NAMESPACE, key: 'blocks', value: blocks });
                publishEvent('decision.blocks.changed', { count: blocks.length });
            }
            return stored;
        });
    }

    return { reload, persist, lastRun, blocks: () => blocks, runs: () => runs };
}
