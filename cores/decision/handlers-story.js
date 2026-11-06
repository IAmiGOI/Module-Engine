/**
 * `update_story`: все записи хода одним вызовом. Каждая часть идёт через свой обычный обработчик
 * (character_knowledge, character_note, set_character_plan, set_plan) — правила те же, меньше запросов модели.
 */
export function createUpdateStoryHandler(handlers) {
    return async (args = {}) => {
        const comment = String(args.comment ?? '').trim();
        const results = [];
        const errors = [];
        const run = async (tool, list) => {
            for (const item of Array.isArray(list) ? list : []) {
                if (!item || typeof item !== 'object') continue;
                const result = await handlers[tool]?.({ ...item, comment }).catch(error => ({ ok: false, error: error?.message ?? String(error) }));
                const label = `${tool} ${item.character ?? ''}`.trim();
                if (result?.ok === false) errors.push(`${label}: ${result.error ?? (result.missing ?? []).join('; ')}`);
                else results.push({ tool, character: item.character ?? null, ...(result?.id ? { id: result.id } : {}), ...(result?.replaced ? { replaced: result.replaced } : {}) });
            }
        };
        await run('character_knowledge', args.knowledge);
        await run('character_note', args.notes);
        await run('set_character_plan', args.characterPlans);
        if (args.plan && typeof args.plan === 'object') await run('set_plan', [args.plan]);
        // Ошибки отдельных частей не отменяют остальное: записанное записано, модель видит, что не прошло.
        return { ok: true, done: results.length, results, ...(errors.length ? { errors } : {}) };
    };
}
