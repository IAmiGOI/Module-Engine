import { migrateNodesToStructured } from '../modes.js';
import { isCore } from '../kinds.js';

/**
 * Режим графа (MEMORY_GRAPH_TYPES_PLAN.md, этап 0): выбор режима пустого графа и конвертация legacy → structured.
 * `ctx` — доступ к состоянию Ядра, см. `core-ops.js`; `ctx.setNodes` подменяет карту нод (конвертация создаёт новый объект).
 */
export function createModeOps(ctx) {
    /**
     * Режим НОВОГО (пустого) графа выбирает пользователь до первого бутстрапа (этап 0, п. 5). Когда ноды уже есть, режим
     * меняется только конвертацией или открытием графа из библиотеки — иначе данные остались бы в формате не того режима.
     */
    async function setModeForEmptyGraph(mode) {
        return ctx.enqueueWrite(async () => {
            if (!['legacy', 'structured'].includes(mode)) return { ok: false, error: `Unknown mode "${mode}".` };
            if (Object.keys(ctx.nodes).length) return { ok: false, error: 'The mode of a graph that already has nodes can only change by upgrading it.' };
            ctx.applyGraphMeta({ ...ctx.graphMeta, mode, createdAt: ctx.graphMeta.createdAt ?? ctx.now() });
            await ctx.persistGraphMeta();
            ctx.publishEvent('memoryGraph.modeChanged', { mode: ctx.graphMeta.mode });
            return { ok: true, mode: ctx.graphMeta.mode };
        });
    }

    /**
     * Конвертация legacy → structured (этап 0, п. 7): (а) СНИМОК прежних данных — без него конвертация не выполняется;
     * (б) режим и `convertedFrom`; (в) миграция структуры (`migrateNodesToStructured`). Обратной конвертации нет — виды, события
     * и Core теряли бы смысл; вернуть можно только из снимка. Пока нет библиотеки графов (этап 9), снимок лежит в памяти чата
     * одним ключом (`graphBackupBeforeUpgrade`) — библиотека потом заменит его. Повторная конвертация — no-op.
     */
    async function convertToStructured() {
        return ctx.enqueueWrite(async () => {
            if (ctx.graphMeta.mode === 'structured') return { ok: true, unchanged: true, mode: 'structured' };
            const { nodes, regions, staging, mergeQueue, reconsolidationQueue } = ctx;
            const backup = await ctx.call('storage.chatMemory.set', {
                namespace: ctx.namespace, key: ctx.backupKey,
                value: { savedAt: ctx.now(), mode: 'legacy', nodes, regions, staging, mergeQueue, reconsolidationQueue },
            });
            if (!backup.ok) return { ok: false, error: `Could not back up the graph first: ${backup.error?.message ?? 'unknown error'}` };
            ctx.setNodes(migrateNodesToStructured(nodes));
            ctx.applyGraphMeta({ ...ctx.graphMeta, mode: 'structured', convertedFrom: 'legacy', bootstrapCoreCount: Object.values(ctx.nodes).filter(isCore).length });
            await Promise.all([ctx.persistNodes(), ctx.persistGraphMeta()]);
            ctx.publishEvent('memoryGraph.modeChanged', { mode: 'structured', convertedFrom: 'legacy' });
            return { ok: true, mode: 'structured', converted: Object.keys(ctx.nodes).length };
        });
    }

    return { setModeForEmptyGraph, convertToStructured };
}
