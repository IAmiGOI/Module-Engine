import { BOOTSTRAP_TASK, DIRECTOR_PASSIVE, fillPrompt } from '../../libraries/core/decision-prompts.js';
import { duePlans } from '../../libraries/core/decision-library.js';

/** Фоновые задания директора: bootstrap, пассивный цикл, заготовка, отчёт субагента. */
export function createCycleJobs({ backgroundRun, wakeQueue, store, getSettings, wakeFor, now = () => Date.now() }) {
    function runBootstrap({ runId, maxQuestions = 5, maxSteps = 30 } = {}) {
        return backgroundRun({
            runId, event: 'bootstrap', canAsk: true, maxSteps,
            wake: wakeFor({ type: 'bootstrap', label: 'Bootstrapping the chat' }),
            task: fillPrompt(BOOTSTRAP_TASK, { max_questions: maxQuestions }),
        });
    }

    function runPassive({ runId, thinking = () => '' } = {}) {
        return wakeQueue.schedule(() => {
            const clock = store.clock();
            const due = duePlans(store.plans(), clock.minutes);
            if (!due.length) return { skipped: true, due: 0 };
            const dueText = due.map(plan => `- ${plan.character} (level ${plan.level}): ${plan.summary}${plan.needsNewPlan ? ' [left the active roster — a new plan is needed]' : ''}`).join('\n');
            const draftLine = getSettings().turnDraft ? '\nBefore await, if you can guess the likely next turn, call save_draft with it.' : '';
            return backgroundRun({
                runId, event: 'time', thinking,
                wake: wakeFor({ type: 'time', label: 'The clock moved', detail: dueText }),
                task: fillPrompt(DIRECTOR_PASSIVE, { event: `${dueText}${draftLine}` }),
            });
        });
    }

    function runDraft({ runId } = {}) {
        return wakeQueue.schedule(() => backgroundRun({
            runId: runId ?? `typing_${now()}`,
            event: 'typing',
            wake: wakeFor({ type: 'typing', label: 'The user is typing' }),
            task: 'The user is typing. Prepare a draft of the likely next decisions. If turn drafting is on, call save_draft with it, then await. Do not submit a turn.',
        }));
    }

    function onResearcherReport(payload = {}) {
        const task = String(payload.task ?? '');
        const report = String(payload.report ?? '');
        return wakeQueue.schedule(() => backgroundRun({
            runId: `researcher_${payload.taskId ?? 'task'}`,
            event: 'researcher',
            wake: wakeFor({ type: 'researcher', label: 'A researcher reported', detail: report, task }),
            task: fillPrompt(DIRECTOR_PASSIVE, { event: `A researcher reported:\n${report}` }),
        }));
    }

    return { runBootstrap, runPassive, runDraft, onResearcherReport };
}
