import { createCycleRecord } from '../../libraries/core/decision-log.js';

/** Цикл, разбуженный сообщением пользователя, не закрывается без ответа ему (поле `reply` у await). */
export function withRequiredReply(handlers) {
    return {
        ...handlers,
        await: (args, extra) => (String(args?.reply ?? '').trim()
            ? handlers.await(args, extra)
            : { ok: false, error: 'The user wrote to you. Put a short answer into "reply" — what you did, or why you did not — and call await again.' }),
    };
}

/** Упавший цикл тоже остаётся в журнале — с причиной, чтобы было видно, что случилось. */
export function createFailureRecorder({ store, state, getSettings, now }) {
    return async function recordFailure({ runId, event, wake, startedAt, message }) {
        const endedAt = now();
        const cycle = createCycleRecord({
            runId, event, messages: [], toolCalls: [], thinking: '', warnings: [`failed: ${message}`], at: startedAt ?? endedAt,
            wake, turn: state.turnCounter, clockMinutes: store.clock().minutes,
            workerId: getSettings().decider?.workerId || null, endedAt, durationMs: endedAt - (startedAt ?? endedAt),
        });
        await store.appendCycle(cycle).catch(() => {});
    };
}
