import { RESOLVER_AFTER_TURN, fillPrompt } from '../../libraries/core/decision-prompts.js';

/**
 * «После хода» — отдельный вызов резолвера по тексту ответа писателя.
 *
 * Вынесено из цикла: здесь только один шаблонный вызов на `after_turn`, тот
 * же разговор с ходом (кеш тот же) и запись цикла. Исход пишется по тому, что
 * реально случилось на странице; Молитва и Телеграмма — только по поводу.
 */

export const AFTER_TURN_STEPS = 6;

/** Принятый шаблон в сжатом виде для задания «после хода». */
export function compactTurn(form) {
    const list = Array.isArray(form?.characters) ? form.characters : [];
    const lines = list.map(character => {
        if (character?.idle === true) return `- ${character.name}: idle${character.busy ? ` (${character.busy})` : ''}`;
        return `- ${character.name}: does ${character.does || '—'}${character.says ? `; says in meaning: ${character.says}` : ''}`;
    });
    const beats = (Array.isArray(form?.beats) ? form.beats : []).map((beat, index) => `${index + 1}. ${beat.who} — ${beat.kind === 'line' ? 'LINE' : 'ACTION'}: ${beat.text}`);
    return [
        `Roster: ${(Array.isArray(form?.roster?.active) ? form.roster.active : []).join(', ') || 'none'}`,
        `Characters:\n${lines.join('\n') || '- none'}`,
        `Beats:\n${beats.join('\n') || '- none'}`,
        `Stop: ${form?.stop ?? form?.resolution ?? ''}`,
        `User result: ${form?.userResult ?? ''}`,
        `Duration: ${form?.scene?.duration ?? ''}`,
    ].join('\n');
}

/**
 * @param {{ runId: string, built: object, writerText: string, form: object }} input
 * @param {{ deciderWorker, context, handlersFor, runDecisionCycle, callTool, capture, live, cycleRecord,
 *           store, publishEvent, wakeFor, now, usage, epoch: () => number, setController: Function }} deps
 */
export async function runAfterTurn({ runId: turnRunId, built, writerText, form }, deps) {
    const {
        getSettings, deciderWorker, context, handlersFor, runDecisionCycle, callTool, capture, live,
        cycleRecord, store, publishEvent, wakeFor, now, usage, epoch, setController, state,
    } = deps;
    const runId = `${turnRunId}_after`;
    const controller = new AbortController();
    setController(controller);
    const captured = typeof capture === 'function' ? capture(`${runId}:`, { onThinking: text => publishEvent('decision.cycle.thinking', { runId, text }) }) : null;
    const thinking = () => captured?.value ?? '';
    const settings = getSettings();
    const worker = deciderWorker(settings);
    const startedWake = wakeFor({ type: 'after_turn', label: 'The resolver closes the turn' });
    const startedAt = now();
    state.runId = runId;
    state.lastForm = form;
    state.lastWriterText = String(writerText ?? '');
    const task = fillPrompt(RESOLVER_AFTER_TURN, {
        writer: String(writerText ?? '').trim() || '(the writer has not written anything new)',
        turn: compactTurn(form),
    });
    live.started({ runId, event: 'after_turn', wake: startedWake, at: startedAt });
    try {
        // Тот же разговор с ходом (кеш тот же): дописываем задание «после хода».
        const messages = [...(built?.messages ?? []), { role: 'user', content: task }];
        const tools = await context.toolsFor(settings, { filter: ['after_turn'] });
        const result = await runDecisionCycle({
            messages, tools, handlers: handlersFor(settings), callTool, maxSteps: AFTER_TURN_STEPS,
            implicitAwait: true, emptyRetry: false, now, stopAfter: ['after_turn'],
            // «После хода» — фоновая роль: бюджет повторов длиннее, чем у хода (часть 19).
            generate: context.generateFor({ settings, worker, runId, prefix: 'a', startedAt, effort: settings.adaptiveReasoning ? 'low' : null, signal: controller.signal, budget: 'background' }),
            ...live.hooks({ runId, thinking }),
        });
        if (epoch() !== deps.startEpoch) { live.finished({ cycle: null }); return null; }
        const { cycle } = cycleRecord({ runId, event: 'after_turn', result, thinking, wake: startedWake, startedAt, workerId: worker.id, usage: captured ? captured.usage : usage(), contextMessages: messages });
        await store.appendCycle(cycle).catch(() => {});
        live.finished({ cycle });
        return cycle;
    } catch (error) {
        live.failed({ runId, message: error?.message ?? String(error) });
        return null;
    } finally {
        captured?.stop();
        setController(null);
    }
}
