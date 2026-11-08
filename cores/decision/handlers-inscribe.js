import { repairInscription } from '../../libraries/core/decision-inscription.js';
import { durationMinutes } from '../../libraries/core/decision-duration.js';
import { departedFrom, lastAcceptedForm } from '../../libraries/core/decision-scene.js';
import { shiftTimeLabel } from '../../libraries/core/time-shift.js';
import { advanceClock, clockFromLabel, parseClock } from '../../libraries/core/decision-clock.js';
import { rpInstant } from '../../libraries/core/decision-bank-time.js';

/**
 * `inscribe` — единственный ход резолвера. Ростер, каждый персонаж изнутри,
 * beats, где ход кончается и сколько сцены заняло. Движок чинит шаблон и
 * отказывает только без beats при действующих; место и RP-время ставит сам,
 * минуты считает из шкалы слов.
 */
export function createInscribeHandler({ store, publishEvent, state, resolvePlace, lastTimeMark, formChecker = null, userName = () => '', getSettings = null, applyRoster = null, timeOfDay = null }) {
    return async args => {
        // Ростер — первым делом: остальное читается уже по новой сцене.
        if (args?.roster && typeof applyRoster === 'function') {
            const applied = await applyRoster(args.roster);
            if (applied?.warnings?.length) state.formWarnings = [...(state.formWarnings ?? []), ...applied.warnings];
        }
        const timeBefore = await lastTimeMark();
        const clock = store.clock();
        const nowValue = rpInstant(timeBefore, Number(clock?.minutes) || 0);
        const previous = lastAcceptedForm(typeof store.cycles === 'function' ? store.cycles() : []);
        const user = userName();

        const repaired = repairInscription({
            form: args, roster: store.roster().active, assessments: state.assessments, user,
            nowValue, timeOfDay: typeof timeOfDay === 'function' ? timeOfDay() : null,
        });
        if (repaired.warnings.length) state.formWarnings = [...(state.formWarnings ?? []), ...repaired.warnings];
        if (!repaired.ok) return { ok: false, missing: repaired.missing };
        const form = repaired.form;
        // Состав сцены — из принятого Начертания: кто действует, тот в ростере, даже если «вошёл» не отмечен.
        // Без этого ростер оставался прежним (однажды — один персонаж пользователя), и резолвер не видел Указов сцены.
        const scene = (Array.isArray(form.roster?.active) ? form.roster.active : []).map(name => String(name ?? '').trim())
            .filter(name => name && name.toLowerCase() !== String(user ?? '').trim().toLowerCase());
        const stored = store.roster().active ?? [];
        const sameScene = scene.length === stored.length && scene.every(name => stored.some(item => String(item).toLowerCase() === name.toLowerCase()));
        if (scene.length && !sameScene && typeof store.saveRoster === 'function') await store.saveRoster({ active: scene });

        // Ушедший в прошлом исходе снова действует, а из ростера не убран — один раз напомнить.
        if (!state.departureWarned) {
            const departed = previous ? departedFrom(previous.resolution, store.roster().active, { user }) : [];
            const back = form.characters.filter(character => character.idle !== true && departed.some(name => name.toLowerCase() === String(character.name).toLowerCase()));
            if (back.length) {
                state.departureWarned = true;
                return { ok: false, missing: back.map(character => `characters: "${character.name}" left the scene at the end of the previous turn — remove them with the roster field (or list them as idle). If they really come back now, say how in their does and inscribe again.`) };
            }
        }

        if (formChecker) {
            const verdict = await formChecker.check({
                form, sceneText: state.sceneText ?? '', returned: state.knowledgeReturns ?? new Set(),
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
        const minutes = form.scene.minutes;
        const storedClock = store.clock();
        const base = storedClock.updatedAt ? storedClock : (clockFromLabel(timeBefore) ?? storedClock);
        const nextClock = advanceClock(base, minutes);
        await store.saveClock(nextClock);
        const timeAfter = shiftTimeLabel(timeBefore, minutes) ?? '';
        const out = {
            ...form,
            scene: { ...form.scene, place: place || form.scene.place || '' },
            meta: { place, timeBefore, timeAfter, clockMinutes: nextClock.minutes },
        };
        state.turnCounter += 1;
        publishEvent('decision.timeShift', { runId: state.runId, minutes, timeBefore, timeAfter, clockMinutes: nextClock.minutes });
        return { ok: true, form: out };
    };
}

/** Минуты из шкалы — наружу для «после хода» и тестов: одно правило, один разбор. */
export { durationMinutes, parseClock };
