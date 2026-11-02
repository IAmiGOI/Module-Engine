/**
 * События хода для окна ленты. Цикл пишет их по мере работы, чтобы окно не
 * ждало конца цикла и не перечитывало весь лог. Здесь только публикация:
 * ни хранения, ни DOM.
 */
export function createCycleLive({ publishEvent, getTurn = () => null, getClock = () => null }) {
    function started({ runId, event, wake = null, at, type = null }) {
        publishEvent('decision.cycle.started', {
            runId, event, type, wake, at, turn: getTurn(), clockMinutes: getClock(),
        });
    }

    function hooks({ runId, thinking = () => '' }) {
        return {
            onModelStart: ({ step, at }) => publishEvent('decision.cycle.step', { runId, phase: 'waiting', step, at }),
            onModelEnd: ({ step, at, durationMs, text, toolCalls }) => {
                publishEvent('decision.cycle.step', {
                    runId, phase: 'answered', step, at, durationMs,
                    text: String(text ?? ''), toolCalls: (toolCalls ?? []).map(call => ({ id: call.id, name: call.name })),
                });
                const thought = String(thinking() ?? '').trim();
                if (thought) publishEvent('decision.cycle.thinking', { runId, text: thought });
            },
            onToolStart: entry => publishEvent('decision.tool.called', { runId, ...entry }),
            onStep: entry => {
                if (String(entry?.name ?? '').startsWith('__')) return;
                publishEvent('decision.tool.result', {
                    runId, name: entry.name, result: entry.result, error: entry.error ?? null,
                    durationMs: entry.durationMs ?? null, at: entry.at,
                });
            },
        };
    }

    function form({ runId, form, push }) {
        publishEvent('decision.cycle.form', { runId, form, push });
    }

    function finished({ cycle }) {
        publishEvent('decision.cycle.finished', { runId: cycle.runId, cycle });
    }

    function failed({ runId, message }) {
        publishEvent('decision.cycle.failed', { runId, message: String(message ?? '') });
    }

    return { started, hooks, form, finished, failed };
}
