import { findEntityCandidates } from '../entity-candidates.js';

const MAX_HINTS = 2;              // сколько раз имя подсказывается модели; не создала — больше не предлагаем
const MAX_REJECTED = 200;         // сколько отклонённых имён помнить
const STUB_MARK = ' — mentioned in ';   // шаблон первой версии: «<Слово> — mentioned in N records…»

/**
 * Повторяющиеся имена без ноды («Nyx» в семи записях и ни одной ноды Nyx) — подсказка ОБЫЧНОМУ вызову извлечения, без отдельного
 * вызова модели. Детектор (`entity-candidates.js`) чистый и только предлагает; решает модель, которая и так читает сцену: если это
 * герой, место, группа или предмет сюжета, она создаёт сущность и использует её в `subjects`, а заголовки, обычные слова и даты
 * игнорирует. Подсказка идёт не больше `MAX_HINTS` раз на имя: не создала — имя уходит в отклонённые (переживает перезагрузку).
 * Ноды сами по себе здесь не создаются никогда. `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createEntityOps(ctx) {
    const rejected = () => ctx.graphMeta.entityRejected ?? [];
    const hinted = () => ctx.graphMeta.entityHinted ?? {};

    /** Имена для подсказки промпту извлечения (до `entityMaxPerSweep`); считает показы и отклоняет те, что не прижились. */
    async function recurringNames() {
        if (!ctx.features.kinds) return [];
        const found = findEntityCandidates(ctx.nodes, { minMentions: ctx.settings.entityMinMentions, maxCandidates: ctx.settings.entityMaxPerSweep, ignore: rejected() });
        const counts = { ...hinted() };
        const names = [];
        let denied = [];
        for (const candidate of found) {
            const key = candidate.name.toLowerCase();
            const shown = counts[key] ?? 0;
            if (shown >= MAX_HINTS) { denied.push(key); delete counts[key]; continue; }
            counts[key] = shown + 1;
            names.push(candidate.name);
        }
        // Показанные раньше, но уже получившие ноду (или пропавшие из кандидатов), из счётчика уходят — он не растёт без границы.
        const live = new Set(found.map(candidate => candidate.name.toLowerCase()));
        for (const key of Object.keys(counts)) if (!live.has(key)) delete counts[key];
        if (denied.length || JSON.stringify(counts) !== JSON.stringify(hinted())) {
            ctx.graphMeta.entityHinted = counts;
            if (denied.length) ctx.graphMeta.entityRejected = [...rejected(), ...denied].slice(-MAX_REJECTED);
            await ctx.persistGraphMeta();
        }
        return names;
    }

    /** Убирает заглушки первой версии («<Слово> — mentioned in N records…»): в них попадали заголовки и обычные слова. Настоящие имена модель создаст сама по подсказке. */
    async function sweepEntities() {
        if (!ctx.features.kinds) return { retired: 0 };
        return ctx.enqueueWrite(async () => {
            const stale = Object.values(ctx.nodes).filter(node => node.source === 'mentions' && String(node.content ?? '').includes(STUB_MARK));
            for (const node of stale) ctx.removeNode(node.id);
            if (stale.length) await Promise.all([ctx.persistNodes(), ctx.persistRegions(), ctx.persistStaging(), ctx.persistMergeQueue(), ctx.persistReconsolidationQueue()]);
            return { retired: stale.length };
        });
    }

    return { recurringNames, sweepEntities };
}
