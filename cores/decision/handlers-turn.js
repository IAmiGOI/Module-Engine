import { validateTurn } from '../../libraries/core/decision-turn.js';
import { departedFrom, lastAcceptedForm } from '../../libraries/core/decision-scene.js';
import { shiftTimeLabel } from '../../libraries/core/time-shift.js';
import { advanceClock, clockFromLabel } from '../../libraries/core/decision-clock.js';

/** `submit_turn`: строгая форма, проверка знаний классификатором, место и RP-время. */
export function createSubmitTurnHandler({ store, publishEvent, state, resolvePlace, lastTimeMark, formChecker = null, userName = () => '' }) {
    return async args => {
        if (!store.plan()) return { ok: false, missing: ['plan: call set_plan before submit_turn'] };
        const previous = lastAcceptedForm(typeof store.cycles === 'function' ? store.cycles() : []);
        const validation = validateTurn({ form: args, roster: store.roster().active, assessments: state.assessments, user: userName(), previous });
        if (!validation.ok) return { ok: false, missing: validation.missing };
        // Ушедший в прошлом исходе снова действует, а из ростера не убран — один раз напомнить (стражник «уходил» и возвращался).
        if (!state.departureWarned) {
            const departed = previous ? departedFrom(previous.resolution, store.roster().active, { user: userName() }) : [];
            const back = validation.normalized.characters.filter(character => character.idle !== true && departed.some(name => name.toLowerCase() === String(character.name).toLowerCase()));
            if (back.length) {
                state.departureWarned = true;
                return { ok: false, missing: back.map(character => `characters: "${character.name}" left the scene at the end of the previous turn — remove them with update_roster (or list them as idle). If they really come back now, say how in their action and submit again.`) };
            }
        }
        if (validation.warnings?.length) state.formWarnings = [...(state.formWarnings ?? []), ...validation.warnings];
        if (formChecker) {
            const verdict = await formChecker.check({
                form: validation.normalized, sceneText: state.sceneText ?? '',
                returned: state.knowledgeReturns ?? new Set(),
            });
            if (!verdict.ok) {
                state.knowledgeReturns?.add(verdict.name);
                publishEvent('decision.form.check', {
                    runId: state.runId, name: verdict.name, chance: verdict.chance, quote: verdict.quote,
                    refused: true, probabilities: verdict.probabilities,
                });
                return { ok: false, error: verdict.refusal };
            }
            for (const warning of verdict.warnings ?? []) (state.formWarnings ??= []).push(warning);
            if (verdict.probabilities) {
                publishEvent('decision.form.check', {
                    runId: state.runId, refused: false, probabilities: verdict.probabilities, warnings: verdict.warnings ?? [],
                });
            }
        }
        const place = await resolvePlace();
        const timeBefore = await lastTimeMark();
        const minutes = validation.normalized.scene.minutes;
        const storedClock = store.clock();
        const base = storedClock.updatedAt ? storedClock : (clockFromLabel(timeBefore) ?? storedClock);
        const nextClock = advanceClock(base, minutes);
        await store.saveClock(nextClock);
        const timeAfter = shiftTimeLabel(timeBefore, minutes) ?? '';
        const form = {
            ...validation.normalized,
            scene: { ...validation.normalized.scene, place: place || validation.normalized.scene.place || '' },
            meta: { place, timeBefore, timeAfter, clockMinutes: nextClock.minutes },
        };
        state.turnCounter += 1;
        publishEvent('decision.timeShift', { runId: state.runId, minutes, timeBefore, timeAfter, clockMinutes: nextClock.minutes });
        return { ok: true, turnId: `turn_${state.turnCounter}`, form };
    };
}
