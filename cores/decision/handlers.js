import { assessAction, DIFFICULTY_ANCHORS, EXPERIENCE_ANCHORS, lexicalSimilarity } from '../../libraries/core/decision-probability.js';
import { validateTurn } from '../../libraries/core/decision-turn.js';
import { shiftTimeLabel } from '../../libraries/core/time-shift.js';
import { applyArc, applyCharacterNote, applyPlan, notesFor } from '../../libraries/core/decision-state.js';
import { advanceClock, clockFromLabel } from '../../libraries/core/decision-clock.js';
import { setLevel, removeOnLeavingRoster, setPlan, interruptPlan, completePlan, planFor } from '../../libraries/core/decision-library.js';
import {
    addRecord, searchRecords, canCompress, ordinaryRecords, buildCompressionPrompt,
    replaceOrdinaryWithSummary, COMPRESS_SYSTEM,
} from '../../libraries/core/decision-bank.js';

/**
 * Исполнители инструментов директора — вынесены из цикла, чтобы цикл
 * оставался циклом. Всё состояние и шины приходят снаружи; обработчики
 * ничего не знают о модели.
 */

const key = value => String(value ?? '').trim().toLowerCase();

export function createPlaceReader(call) {
    return async function resolvePlace() {
        try {
            const position = await call('map.position.get');
            if (!position?.nodeId) return '';
            const nodes = await call('map.nodes.list');
            const path = await call('map.nodes.containmentPath', { id: position.nodeId });
            const byId = new Map((Array.isArray(nodes) ? nodes : []).map(node => [node.id, node]));
            return (Array.isArray(path) ? path : []).map(id => byId.get(id)?.name ?? id).join(' → ');
        } catch { return ''; }
    };
}

export function createTimeReader(call) {
    return async function lastTimeMark() {
        try {
            const marks = await call('chatHistory.annotations', { namespace: 'module.time' });
            const ids = Object.keys(marks ?? {}).sort((a, b) => Number(a) - Number(b));
            return String(marks?.[ids.at(-1)] ?? '');
        } catch { return ''; }
    };
}

export function createSimilarity(call) {
    const anchorVectors = new Map();
    async function vectorFor(text, kind) {
        const cacheKey = `${kind}:${text}`;
        if (anchorVectors.has(cacheKey)) return anchorVectors.get(cacheKey);
        const vector = await call('embedding.compute', { text, kind });
        if (Array.isArray(vector)) anchorVectors.set(cacheKey, vector);
        return Array.isArray(vector) ? vector : null;
    }
    return async function similarityScores(phrase, anchors) {
        try {
            const query = await vectorFor(phrase, 'query');
            if (!query) return null;
            const scores = new Map();
            for (const anchor of anchors) {
                for (const anchorPhrase of anchor.phrases) {
                    const vector = await vectorFor(anchorPhrase, 'passage');
                    if (!vector) continue;
                    const similarity = await call('embedding.similarity', { a: query, b: vector });
                    if (Number.isFinite(similarity)) scores.set(anchorPhrase, similarity);
                }
            }
            return scores.size ? scores : null;
        } catch { return null; }
    };
}

/**
 * @param {{ store: object, call: Function, publishEvent: Function, getSettings: Function,
 *           state: { assessments: Map, assessmentCounter: number, turnCounter: number },
 *           resolvePlace: Function, lastTimeMark: Function, similarityScores: Function }} input
 */
export function createHandlers({ store, call, publishEvent, getSettings, state, resolvePlace, lastTimeMark, similarityScores, researcher }) {
    const findLibraryRecord = character => Object.values(store.library())
        .find(record => key(record.name) === key(character)) ?? null;

    /**
     * Сжатие — отдельной моделью и только для обычных записей. Важные не
     * трогаются никогда; если раздел не дорос до порога — модель не зовётся.
     * Ошибка сжатия не ломает запись результата: банк остаётся как был.
     */
    async function compressIfNeeded(character, bank) {
        const settings = getSettings();
        if (!canCompress(bank, character, settings.compression.thresholdTokens)) return bank;
        const ordinary = ordinaryRecords(bank, character);
        try {
            const summary = await call('model.generate', {
                workerId: settings.compression.workerId || undefined,
                systemPrompt: COMPRESS_SYSTEM,
                prompt: buildCompressionPrompt(ordinary),
                maxTokens: settings.compression.maxTokens,
                temperature: settings.compression.temperature,
                stream: false,
            });
            if (!String(summary ?? '').trim()) return bank;
            const replaced = replaceOrdinaryWithSummary(bank, { character, summary, covers: ordinary.map(record => record.id) });
            if (!replaced.ok) return bank;
            await store.saveBank(replaced.bank);
            publishEvent('decision.bank.compressed', { character, records: ordinary.length });
            return replaced.bank;
        } catch { return bank; }
    }

    return {
        update_roster: async args => {
            const before = store.roster().active;
            const remove = new Set((Array.isArray(args.remove) ? args.remove : []).map(name => String(name).trim()).filter(Boolean));
            const next = [...before.filter(name => !remove.has(name))];
            const added = [];
            for (const entry of Array.isArray(args.add) ? args.add : []) {
                const name = String(entry?.name ?? '').trim();
                if (name && !next.some(existing => key(existing) === key(name))) { next.push(name); added.push(name); }
            }
            const removed = before.filter(name => !next.includes(name));
            await store.saveRoster({ active: next });

            let plans = store.plans();
            for (const name of added) plans = interruptPlan(plans, { character: name });
            let library = store.library();
            for (const name of removed) {
                library = removeOnLeavingRoster(library, { character: name }).library;
                plans = plans.map(plan => (key(plan.character) === key(name) && !plan.resolvedAt
                    ? { ...plan, interrupted: false, approximate: false, dueAt: store.clock().minutes, needsNewPlan: true }
                    : plan));
            }
            if (added.length || removed.length) { await store.saveLibrary(library); await store.savePlans(plans); }
            return { ok: true, active: next, added: added.length, removed: removed.length };
        },

        set_plan: async args => {
            const applied = applyPlan(store.plan(), args);
            if (!applied.ok) return { ok: false, error: applied.error };
            await store.savePlan(applied.plan);
            return { ok: true, plan: applied.plan };
        },

        character_note: async args => {
            const applied = applyCharacterNote(store.notes(), args);
            if (!applied.ok) return { ok: false, error: applied.error };
            await store.saveNotes(applied.notes);
            return { ok: true, count: notesFor(applied.notes, args.character).length };
        },

        arc: async args => {
            const applied = applyArc(store.arcs(), args);
            if (!applied.ok) return { ok: false, error: applied.error };
            await store.saveArcs(applied.arcs);
            return { ok: true, arcs: applied.arcs.map(arc => ({ id: arc.id, title: arc.title, status: arc.status })) };
        },

        set_character_level: async args => {
            const applied = setLevel(store.library(), {
                character: args.character, level: args.level,
                inRoster: store.roster().active.some(name => key(name) === key(args.character)),
            });
            if (!applied.ok) return { ok: false, error: applied.error };
            await store.saveLibrary(applied.library);
            const record = Object.values(applied.library).find(item => key(item.name) === key(args.character));
            return { ok: true, character: record?.name ?? args.character, level: record?.level };
        },

        set_character_plan: async args => {
            const record = findLibraryRecord(args.character);
            if (!record) return { ok: false, error: `There is no library entry for "${args.character}" — set the level first.` };
            const inRoster = store.roster().active.some(name => key(name) === key(record.name));
            const applied = setPlan(store.plans(), {
                character: record.name, level: record.level, summary: args.summary, steps: args.steps,
                durationMinutes: args.durationMinutes, inRoster, clockMinutes: store.clock().minutes,
            });
            if (!applied.ok) return { ok: false, error: applied.error };
            await store.savePlans(applied.plans);
            return { ok: true, plan: applied.plan };
        },

        resolve_character_plan: async args => {
            const record = findLibraryRecord(args.character);
            if (!record) return { ok: false, error: `There is no library entry for "${args.character}".` };
            const current = planFor(store.plans(), { character: record.name });
            const banked = addRecord(store.bank(), {
                character: record.name, planId: current?.id ?? null, text: args.result, important: args.important === true,
            });
            if (!banked.ok) return { ok: false, error: banked.error };
            let plans = completePlan(store.plans(), { character: record.name });
            let nextPlan = null;
            if (String(args.nextSummary ?? '').trim()) {
                const inRoster = store.roster().active.some(name => key(name) === key(record.name));
                const applied = setPlan(plans, {
                    character: record.name, level: record.level, summary: args.nextSummary, steps: args.nextSteps,
                    durationMinutes: args.nextDurationMinutes, inRoster, clockMinutes: store.clock().minutes,
                });
                if (!applied.ok) return { ok: false, error: applied.error };
                plans = applied.plans;
                nextPlan = applied.plan;
            }
            await store.saveBank(banked.bank);
            await store.savePlans(plans);
            const finalBank = await compressIfNeeded(record.name, banked.bank);
            return { ok: true, record: banked.record, nextPlan, compressed: finalBank !== banked.bank };
        },

        library: async args => {
            const wanted = key(args.character);
            const records = Object.values(store.library())
                .filter(record => !wanted || key(record.name) === wanted)
                .map(record => ({ ...record, plan: planFor(store.plans(), { character: record.name }) }));
            return { ok: true, characters: records };
        },

        spawn_researcher: async args => {
            if (!researcher) return { ok: false, error: 'The researcher is not available.' };
            return researcher.start({ task: args.task });
        },

        forced_memory: async args => {
            if (args.op !== 'list') await call('summary.force', { id: args.summaryId, forced: args.op === 'keep' });
            const kept = await call('summary.forced');
            return { ok: true, kept: Array.isArray(kept) ? kept : [] };
        },

        memory: async args => {
            if (args.op === 'write') {
                const banked = addRecord(store.bank(), { character: args.character, text: args.text, important: args.important === true });
                if (!banked.ok) return { ok: false, error: banked.error };
                await store.saveBank(banked.bank);
                await compressIfNeeded(args.character, banked.bank);
                return { ok: true, record: banked.record };
            }
            const records = searchRecords(store.bank(), { character: args.character, query: args.query, limit: args.limit });
            return { ok: true, records };
        },

        current_state: async () => {
            const place = await resolvePlace();
            const time = await lastTimeMark();
            const plan = store.plan();
            const open = store.arcs().find(arc => arc.status === 'open') ?? null;
            return {
                ok: true,
                place: place || null,
                time: time || null,
                planStage: plan?.stages?.[plan.currentStage] ?? null,
                arc: open ? { id: open.id, title: open.title } : null,
                sources: { place: place ? 'map' : 'no-position', time: time ? 'rp-time' : 'no-time', plan: plan ? 'plan' : 'no-plan' },
            };
        },

        assess: async args => {
            state.assessmentCounter += 1;
            const id = `asm_${state.runId}_${state.assessmentCounter}`;
            const [difficultyScores, experienceScores] = await Promise.all([
                similarityScores(args.difficulty, DIFFICULTY_ANCHORS),
                similarityScores(args.experience, EXPERIENCE_ANCHORS),
            ]);
            const similarity = (text, anchorPhrase) => difficultyScores?.get(anchorPhrase)
                ?? experienceScores?.get(anchorPhrase)
                ?? lexicalSimilarity(text, anchorPhrase);
            const settings = getSettings();
            const seed = Number.isFinite(settings.assessSeed) ? settings.assessSeed + state.assessmentCounter : undefined;
            const result = assessAction({
                character: args.character, action: args.action, difficulty: args.difficulty, experience: args.experience, seed, similarity,
            });
            state.assessments.set(id, { ...result, id });
            return { ok: true, id, ...result };
        },

        submit_turn: async args => {
            if (!store.plan() && !args._decision) return { ok: false, missing: ['plan: call set_plan before submit_turn'] };
            const validation = validateTurn({ form: args, roster: store.roster().active, assessments: state.assessments });
            if (!validation.ok) return { ok: false, missing: validation.missing };
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
        },

        await: args => ({ ok: true, reason: String(args.reason ?? '') }),
    };
}
