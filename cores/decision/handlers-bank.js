/**
 * Исполнители инструментов Great Bank: правка одним вызовом и уровень
 * важности. Знания — существующая система, поэтому правка раздела Knowledge
 * идёт её же инструментом, а не второй дорогой в тот же банк.
 */
export function createBankHandlers({ banks = null, knowledge = null, state = {} } = {}) {
    return {
        bank_edit: async args => {
            if (!banks?.edit) return { ok: false, error: 'The Great Bank is not available.' };
            const result = await banks.edit({ comment: args.comment, edits: args.edits }, { by: state.role ?? 'director' });
            const changes = result.changes ?? [];
            const knowledgeEdits = changes.filter(change => change.kind === 'knowledge');
            const recorded = [];
            for (const change of knowledgeEdits) {
                if (!knowledge?.handlers?.character_knowledge || !String(change.new ?? '').trim()) continue;
                const added = await knowledge.handlers.character_knowledge({ op: 'add', character: change.character, fact: change.new, comment: args.comment });
                recorded.push({ character: change.character, fact: change.new, ok: added.ok !== false, ...(added.error ? { error: added.error } : {}) });
            }
            const sectionChanges = changes.filter(change => change.kind !== 'knowledge');
            return {
                ok: true, at: result.at, changes: sectionChanges, created: result.created ?? [],
                ...(recorded.length ? { knowledge: recorded } : {}),
                ...(knowledgeEdits.length && !recorded.length ? { knowledge: 'Record knowledge with character_knowledge; it has its own ops and ids.' } : {}),
                ...(sectionChanges.some(change => change.pending) ? { pending: 'Spiritual edits from the resolver are kept as a proposal for the Director. Decree edits wait for the Decree tool.' } : {}),
            };
        },

        set_bank_importance: async args => {
            if (!banks?.great) return { ok: false, error: 'The Great Bank is not available.' };
            return banks.great.setImportance({ character: args.character, importance: args.importance });
        },
    };
}
