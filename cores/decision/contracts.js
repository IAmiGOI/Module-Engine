/** Контракты ядра «директор + прозаик». Только регистрация; логика — в index.js. */
export function registerDecisionContracts(host, {
    getSettings, configure, store, researcher, banks, cycle, cardTurn, decide, rewrite, reload, preview, decideContract, rewriteContract,
}) {
    const settings = () => {
        const value = getSettings();
        return {
            ...value, decider: { ...value.decider }, writer: { ...value.writer }, prompts: { ...value.prompts },
            promptSections: structuredClone(value.promptSections ?? {}),
        };
    };
    return [
        host.own.register('decision.settings', settings),
        host.own.register('decision.configure', params => configure(params?.patch ?? {})),
        host.own.register('decision.preview', params => preview(params ?? {})),
        host.own.register('decision.runs', () => ({ ...store.runs() })),
        host.own.register('decision.lastRun', () => store.lastRun()),
        host.own.register('decision.roster', () => store.roster()),
        host.own.register('decision.log', () => store.cycles()),
        host.own.register('decision.archive', () => store.archive()),
        host.own.register('decision.digests', () => store.frozen()),
        host.own.register('decision.window', () => store.window()),
        host.own.register('decision.frozen', () => store.frozen()),
        host.own.register('decision.plan', () => store.plan()),
        host.own.register('decision.arcs', () => store.arcs()),
        host.own.register('decision.notes', () => store.notes()),
        host.own.register('decision.library', () => store.library()),
        host.own.register('decision.plans', () => store.plans()),
        host.own.register('decision.clock', () => store.clock()),
        host.own.register('decision.bank', () => store.bank()),
        host.own.register('decision.forcedMemory', params => cycle.judgeForcedMemory(params)),
        host.own.register('decision.research', () => researcher.tasks()),
        host.own.register('decision.names', () => store.names()),
        host.own.register('decision.draft', () => store.draft()),
        host.own.register('decision.banks', () => banks.records()),
        host.own.register('decision.bankProgress', () => banks.progress()),
        host.own.register('decision.bankWrite', params => banks.write(params ?? {})),
        host.own.register('decision.bankRebuild', params => banks.rebuild(params ?? {})),
        host.own.register('decision.message', params => cycle.sendMessage(params ?? {})),
        host.own.register('decision.reload', () => reload()),
        host.own.register('decision.cardTurn', params => cardTurn(params)),
        host.own.register(decideContract, params => decide(params)),
        host.own.register(rewriteContract, params => rewrite(params)),
    ];
}
