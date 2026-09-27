import { normalizeTrackerPatch, applyTrackerPatch, normalizeId, normalizeMacroPatch, normalizeMacroName, normalizeEntryPatch, normalizeEntryRef, normalizePassParams } from '../../libraries/core/guide-edit.js';
import { planSettingChanges, describePlan } from '../../libraries/core/guide-settings.js';

/**
 * Действия гида «править и удалять» (трекер, макрос, запись лорбука) и «менять настройки Модуля». Приходят блоком ```proposal```: карточка показывает, что
 * изменится (guide-edit.js), применяется кнопкой. Трогаются только СВОИ трекеры пользователя (не системные и не принадлежащие Модулям); менять настройки
 * можно только у включённого Модуля и только то, что он сам объявил (`guideSettings()` → guide-settings.js).
 */
export function createEditActions({ call, modules }) {
    const failure = message => ({ ok: false, message });
    /** Проходы Post-Turn Processor исполняет сам Модуль (`guideTools()` в его объекте): у него их живой список и сохранение. Выключен — отказ. */
    const passTool = (action, method) => ({
        async run(params = {}) {
            const tools = modules?.guideTools?.('module.postprocess');
            if (!tools) return failure('Post-Turn Processor is off — turn it on first.');
            const made = normalizePassParams(action, params);
            if (!made.ok) return failure(made.error);
            return tools[method](made.value);
        },
    });
    const ownTracker = (list, id) => list.find(tracker => tracker.id === id && tracker.kind !== 'system' && !tracker.ownerId);

    async function trackers() {
        const listed = await call('tracking.trackers');
        return listed.ok ? listed.value ?? [] : [];
    }

    return {
        'tracker.update': {
            description: 'Change one of the user\'s trackers. Params: {"id": "hero_status", "fields": [{"name": "mood", "prompt": "…", "default": "calm"}] (existing name = edit, new name = add), "removeFields": ["hunger"], "when": "everyReply" | "everyNReplies" | "onUserMessage" | "beforeSend" | "manual", "every": 3, "enabled": true}. Only what you name changes. Use ids from the state. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeTrackerPatch(params);
                if (!made.ok) return failure(made.error);
                const list = await trackers();
                const current = ownTracker(list, made.value.id);
                if (!current) return failure(`There is no tracker of yours called “${made.value.id}”.`);
                const next = applyTrackerPatch(current, made.value);
                if (!next.fields.length) return failure('A tracker needs at least one field — delete it instead.');
                const saved = await call('tracking.configure', { trackers: list.map(tracker => (tracker.id === current.id ? next : tracker)) });
                return saved.ok ? { ok: true, message: `Tracker “${current.id}” is updated.` } : failure(saved.error.message);
            },
        },
        'tracker.delete': {
            description: 'Delete one of the user\'s trackers. Params: {"id": "hero_status"}. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeId(params);
                if (!made.ok) return failure(made.error);
                const list = await trackers();
                if (!ownTracker(list, made.value.id)) return failure(`There is no tracker of yours called “${made.value.id}”.`);
                const saved = await call('tracking.configure', { trackers: list.filter(tracker => tracker.id !== made.value.id) });
                return saved.ok ? { ok: true, message: `Tracker “${made.value.id}” is deleted.` } : failure(saved.error.message);
            },
        },
        'macro.update': {
            description: 'Change a macro\'s text or program. Params: {"name": "weather", "text": "It is sunny."} or {"name": "hp", "code": "…"}. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeMacroPatch(params);
                if (!made.ok) return failure(made.error);
                const listed = await call('macros.programs');
                const list = listed.ok ? listed.value ?? [] : [];
                const current = list.find(program => program.macroName === made.value.name);
                if (!current) return failure(`There is no macro {{${made.value.name}}}.`);
                const next = { ...current, kind: made.value.kind, source: made.value.source };
                if (next.kind === 'code') {
                    const tested = await call('macros.test', { program: next });
                    if (!tested.ok || tested.value?.ok === false) return failure(`That program doesn't run: ${tested.ok ? tested.value.error : tested.error.message}`);
                }
                const saved = await call('macros.configure', { programs: list.map(program => (program === current ? next : program)) });
                return saved.ok ? { ok: true, message: `Macro {{${current.macroName}}} is updated.` } : failure(saved.error.message);
            },
        },
        'macro.delete': {
            description: 'Delete a macro. Params: {"name": "weather"}. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeMacroName(params);
                if (!made.ok) return failure(made.error);
                const listed = await call('macros.programs');
                const list = listed.ok ? listed.value ?? [] : [];
                if (!list.some(program => program.macroName === made.value.name)) return failure(`There is no macro {{${made.value.name}}}.`);
                const saved = await call('macros.configure', { programs: list.filter(program => program.macroName !== made.value.name) });
                return saved.ok ? { ok: true, message: `Macro {{${made.value.name}}} is deleted.` } : failure(saved.error.message);
            },
        },
        'lorebook.updateEntry': {
            description: 'Change a lorebook entry. Params: {"uid": 3, "book": "optional", "title": "…", "keys": ["…"], "content": "…", "always": false}. Only what you name changes; uid comes from the state. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeEntryPatch(params);
                if (!made.ok) return failure(made.error);
                const updated = await call('lorebook.updateEntry', { uid: made.value.uid, book: made.value.book, patch: made.value.patch });
                return updated.ok ? { ok: true, message: `Lorebook entry #${made.value.uid} is updated.` } : failure(updated.error.message);
            },
        },
        'lorebook.deleteEntry': {
            description: 'Delete a lorebook entry. Params: {"uid": 3, "book": "optional"}. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeEntryRef(params);
                if (!made.ok) return failure(made.error);
                const removed = await call('lorebook.deleteEntry', { uid: made.value.uid, book: made.value.book });
                return removed.ok ? { ok: true, message: `Lorebook entry #${made.value.uid} is deleted.` } : failure(removed.error.message);
            },
        },
        'postprocess.pass.add': {
            ...passTool('postprocess.pass.add', 'addPass'),
            description: 'Add a pass to the Post-Turn Processor (it rewrites each fresh reply; passes run in order, each sees the previous result). Params: {"name": "Fix grammar", "prompt": "Fix grammar and spelling. Do not change the story or tone.", "workerId": "optional connection id from the state", "includeContext": false, "contextDepth": 6, "position": 1 (optional, default last), plus optional generation settings of the pass: "temperature" 0–2, "topP" 0–1, "topK" 0–200, "maxTokens" 1–32768, "reasoningMode", "reasoningEffort", "reasoningBudget"}. Send it in a ```proposal``` block.',
        },
        'postprocess.pass.update': {
            ...passTool('postprocess.pass.update', 'updatePass'),
            description: 'Change a Post-Turn pass. Params: {"id": "<pass id from the state>", "name", "prompt", "workerId", "enabled", "includeContext", "contextDepth", and the generation settings "temperature" 0–2, "topP" 0–1, "topK" 0–200, "maxTokens" 1–32768, "reasoningMode", "reasoningEffort", "reasoningBudget"} — only what you name changes, so you CAN set a pass\'s temperature. Send it in a ```proposal``` block.',
        },
        'postprocess.pass.remove': {
            ...passTool('postprocess.pass.remove', 'removePass'),
            description: 'Delete a Post-Turn pass. Params: {"id": "<pass id>"}. Send it in a ```proposal``` block.',
        },
        'postprocess.pass.move': {
            ...passTool('postprocess.pass.move', 'movePass'),
            description: 'Move a Post-Turn pass to a position (1 = runs first). Params: {"id": "<pass id>", "position": 2}. Send it in a ```proposal``` block.',
        },
        'module.setting.set': {
            description: 'Change settings of a module that is ON. Params: {"module": "module.music", "changes": {"minSimilarity": 0.4, "autoSwitch": false}}. Only the keys listed under "Settings you can change" in the state exist. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const moduleId = String(params.module ?? '');
                const declared = modules?.guideSettings?.(moduleId);
                if (!declared) return failure(`${moduleId || 'That module'} is not on, or has no settings I can change.`);
                const plan = planSettingChanges(declared.specs, params.changes);
                if (!plan.ok) return failure(plan.error);
                for (const { spec, to } of plan.changes) spec.set(to);
                await declared.save?.();
                return { ok: true, message: `${modules.list?.().find(item => item.id === moduleId)?.title ?? moduleId}: ${describePlan(plan.changes).join('; ')}.` };
            },
        },
    };
}
