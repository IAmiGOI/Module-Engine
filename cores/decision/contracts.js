/** Контракты ядра «директор + прозаик». Только регистрация; логика — в index.js. */
export function registerDecisionContracts(host, {
    getSettings, configure, store, researcher, banks, cycle, cardTurn, decide, rewrite, reload, preview, decideContract, rewriteContract, bootstrap = null,
    gameSettings = null, messageRolls = null, regenOnce = null,
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
        // Кнопки перегенерации в полосе ввода: следующая перегенерация — директор и писатель или только писатель, мимо общей настройки.
        ...(regenOnce ? [host.own.register('decision.regenOnce', params => regenOnce(params?.mode))] : []),
        // Настройки игры (часть 13): текущий чат, умолчание новых чатов, сброс.
        // Строка броска над сообщением: источник — запись хода этого mesid.
        ...(messageRolls ? [host.own.register('decision.messageRolls', params => messageRolls(params?.mesid))] : []),
        ...(gameSettings ? [
            host.own.register('decision.gameSettings', () => gameSettings.get()),
            host.own.register('decision.gameSettings.set', params => gameSettings.set(params?.patch ?? {})),
            host.own.register('decision.gameSettings.useDefault', () => gameSettings.useDefault()),
            host.own.register('decision.gameSettings.reset', () => gameSettings.reset()),
            host.own.register('decision.gameSettings.saveMix', params => gameSettings.saveMix(params ?? {})),
            host.own.register('decision.gameSettings.renameMix', params => gameSettings.renameMix(params ?? {})),
            host.own.register('decision.gameSettings.removeMix', params => gameSettings.removeMix(params ?? {})),
            host.own.register('decision.gameSettings.updateMix', params => gameSettings.updateMix(params ?? {})),
            host.own.register('decision.gameSettings.applyMix', params => gameSettings.applyMix(params ?? {})),
        ] : []),
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
        // The Court, «Files»: Great Bank целиком и правка разделов от имени пользователя (часть 21).
        host.own.register('decision.greatBank', async () => { await banks.great.sync(); return banks.great.load(); }),
        host.own.register('decision.greatBankEdit', params => banks.edit(params ?? {}, { by: 'user' })),
        host.own.register('decision.bankProgress', () => banks.progress()),
        host.own.register('decision.bankWrite', params => banks.write(params ?? {})),
        host.own.register('decision.bankRebuild', params => banks.rebuild(params ?? {})),
        host.own.register('decision.message', params => cycle.sendMessage(params ?? {})),
        host.own.register('decision.bootstrap', () => bootstrap?.state?.() ?? null),
        host.own.register('decision.bootstrapRetry', () => bootstrap?.retry?.() ?? { ok: false, error: 'The bootstrap is not available.' }),
        host.own.register('decision.question', () => cycle.question?.() ?? null),
        host.own.register('decision.answerQuestion', params => cycle.answerQuestion(params ?? {})),
        host.own.register('decision.reload', () => reload()),
        host.own.register('decision.cardTurn', params => cardTurn(params)),
        host.own.register(decideContract, params => decide(params)),
        host.own.register(rewriteContract, params => rewrite(params)),
    ];
}

/** Этап прозаика на `generation.payload`: последний в fold-цепочке. */
export function decisionRewriteStage({ id, contract }) {
    return {
        id,
        contract,
        params: { payload: { $from: '$value' }, signal: { $from: '$context.signal' }, endpoint: { $from: '$context.endpoint' } },
        onExhausted: 'abort',
    };
}
