import { createAssessHandler } from './handlers-assess.js';
import { createSubmitTurnHandler } from './handlers-turn.js';
import { applyArc, applyCharacterNote, applyPlan, notesFor } from '../../libraries/core/decision-state.js';
import { setLevel, removeOnLeavingRoster, setPlan, interruptPlan, completePlan, planFor } from '../../libraries/core/decision-library.js';
import {
    addRecord, searchRecords, canCompress, ordinaryRecords, buildCompressionPrompt,
    replaceOrdinaryWithSummary,
} from '../../libraries/core/decision-bank.js';
import { issueName } from '../../libraries/core/decision-names.js';
import { isFrequentCharacter } from '../../libraries/core/decision-window.js';
import { normalizeBrief, normalizeTimelineBanks, renderChatBrief } from '../../libraries/core/decision-brief.js';
/**
 * Исполнители инструментов директора — вынесены из цикла, чтобы цикл
 * оставался циклом. Всё состояние и шины приходят снаружи; обработчики
 * ничего не знают о модели.
 */
const key = value => String(value ?? '').trim().toLowerCase();

/**
 * @param {{ store: object, call: Function, publishEvent: Function, getSettings: Function,
 *           state: { assessments: Map, assessmentCounter: number, turnCounter: number },
 *           resolvePlace: Function, lastTimeMark: Function, similarityScores: Function }} input
 */
export function createHandlers({ store, call, publishEvent, getSettings, getGameSettings = null, state, resolvePlace, lastTimeMark, researcher, banks = null, window: turnWindow = null, formChecker = null, questions = null }) {
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
            if (added.length && banks) await banks.noteRosterAdded(added).catch(() => {});
            if (added.length || removed.length) {
                const parts = [];
                if (added.length) parts.push(`+ ${added.join(', ')}`);
                if (removed.length) parts.push(`− ${removed.join(', ')}`);
                await turnWindow?.addFact(`update_roster: ${parts.join(', ')}`, { turn: state.turnCounter });
            }
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
            return { ok: true, count: notesFor(applied.notes, args.character).length, ...(applied.replaced ? { replaced: `The note "${applied.replaced}" was the oldest and was replaced.` } : {}) };
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
            await turnWindow?.addFact(`set_character_level ${record?.name ?? args.character}: ${record?.level}`, { turn: state.turnCounter });
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
            if (isFrequentCharacter(store.library(), record.name)) {
                await turnWindow?.addFact(`set_character_plan ${record.name}: "${String(args.summary ?? '').trim()}"`, { turn: state.turnCounter });
            }
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
            if (isFrequentCharacter(store.library(), record.name)) {
                await turnWindow?.addFact(`resolve_character_plan ${record.name}: ${String(args.result ?? '').trim()}${nextPlan ? `; next: "${nextPlan.summary}"` : ''}`, { turn: state.turnCounter });
            }
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
            return researcher.start({ task: args.task, runId: state.runId || null });
        },

        save_draft: async args => {
            if (!getSettings().turnDraft) return { ok: false, error: 'Turn drafting is off.' };
            const draft = args.draft && typeof args.draft === 'object' ? args.draft : null;
            if (!draft) return { ok: false, error: 'A draft needs an object.' };
            await store.saveDraft(draft);
            return { ok: true };
        },

        recall_name: async args => {
            const issued = store.names();
            const result = issueName({ issued, gender: args.gender, culture: args.culture, setting: args.setting });
            if (!result.ok) return result;
            await store.addName(result.key);
            return { ok: true, name: result.name, surname: result.surname, full: result.full, remaining: result.remaining };
        },

        forced_memory: async args => {
            if (args.op !== 'list') await call('summary.force', { id: args.summaryId, forced: args.op === 'keep' });
            const kept = await call('summary.forced');
            return { ok: true, kept: Array.isArray(kept) ? kept : [] };
        },

        lorebook: async args => {
            if (args.op === 'search') {
                const results = await call('lorebook.search', { query: args.query, book: args.book, limit: args.limit });
                return { ok: true, results: Array.isArray(results) ? results : [] };
            }
            if (args.op === 'list') {
                // Оглавление книги: названия и номера, без текста — чтобы найти забытую запись и прочитать её.
                const all = (await call('lorebook.entries')) ?? [];
                const book = String(args.book ?? '').trim();
                const entries = all.filter(entry => !entry?.disable && (!book || entry.book === book))
                    .map(entry => ({ uid: entry.uid, book: entry.book, title: String(entry.comment ?? '').trim() || `Entry ${entry.uid}`, constant: Boolean(entry.constant) }));
                return { ok: true, entries };
            }
            if (args.op === 'read') {
                let { uid, book } = args;
                const title = String(args.title ?? '').trim().toLowerCase();
                if ((uid === undefined || uid === null || uid === '') && title) {
                    const all = (await call('lorebook.entries')) ?? [];
                    const found = all.find(entry => String(entry.comment ?? '').trim().toLowerCase() === title)
                        ?? all.find(entry => String(entry.comment ?? '').toLowerCase().includes(title));
                    if (!found) return { ok: false, error: `There is no lorebook entry titled "${args.title}". Use op "list" or "search".` };
                    uid = found.uid;
                    book = found.book;
                }
                const entry = await call('lorebook.get', { uid, book });
                return entry ? { ok: true, entry } : { ok: false, error: 'There is no such lorebook entry. Use op "list" or "search".' };
            }
            return { ok: false, error: 'The lorebook tool needs op "list", "search" or "read".' };
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

        assess: createAssessHandler({ state, getSettings, getGameSettings }),

        submit_turn: createSubmitTurnHandler({ store, publishEvent, state, resolvePlace, lastTimeMark, formChecker, userName: () => String(banks?.persona?.()?.name ?? '').trim() }),


        character_bank: async args => {
            if (!banks) return { ok: false, error: 'Character banks are not available.' };
            if (args.op === 'write') return banks.write({ name: args.character, text: args.text });
            if (args.op === 'rebuild') return banks.rebuild({ name: args.character });
            return { ok: true, banks: await banks.read({ name: args.character }) };
        },

        ask_user: async args => {
            if (!questions) return { ok: false, text: 'ask_user is not available.' };
            const result = await questions.ask({
                question: args.question, options: args.options, why: args.why,
                allowed: state.canAsk === true, asked: state.questionCount ?? 0, limit: state.questionLimit ?? 5,
            });
            if (result.asked) state.questionCount = (state.questionCount ?? 0) + 1;
            return { ok: true, text: result.text, asked: Boolean(result.asked) };
        },

        write_chat_brief: async args => {
            if (!state.canWriteBrief) {
                return { ok: false, error: 'write_chat_brief is available only in the chat bootstrap or an out-of-character talk.' };
            }
            const brief = normalizeBrief({ text: args.brief, timelineBanks: normalizeTimelineBanks(args.timelineBanks), bankGuide: args.bankGuide ?? store.chatBrief?.()?.bankGuide ?? '', at: Date.now() });
            if (!brief) return { ok: false, error: 'A chat brief needs text.' };
            await store.saveChatBrief(brief);
            state.briefWritten = true;
            const win = typeof store.window === 'function' ? store.window() : null;
            const hasTurns = Array.isArray(win?.entries) && win.entries.some(entry => entry.kind === 'turn');
            // Новая сводка — целиком: в первой строке только таймлайн, а правка (редкон) обычно ниже — она терялась.
            if (hasTurns) await turnWindow?.addFact(`write_chat_brief — the chat brief now reads:\n${brief.text}`);
            else if (typeof store.boundary === 'function' && store.boundary()) {
                await store.saveBoundary({ ...store.boundary(), chatBriefText: renderChatBrief(brief) });
            }
            // Правка банков под таймлайн — в фоне: это запрос модели на каждый банк, и bootstrap (а за ним ход и сообщения) ждал её минутами.
            if (banks?.applyTimeline) banks.applyTimeline({ timelineBanks: brief.timelineBanks }).catch(() => {});
            publishEvent('decision.brief.written', { at: brief.at, timelineBanks: brief.timelineBanks.length });
            return { ok: true };
        },

        await: args => ({ ok: true, reason: String(args.reason ?? '') }),
    };
}
