/**
 * Действия гида над пресетами Prompt Manager: прочитать, посмотреть превью запроса, создать, изменить, скопировать, вернуть версию, задать переопределение параметров.
 * Правки приходят блоком ```proposal``` и применяются сразу (как у карточек): каждая запись сохраняет версию пресета (PM хранит 30), удаления пресета у гида нет намеренно.
 * Проверка и запись — Ядро `promptManager` (контракты `promptManager.*`); здесь только перевод предложения в вызов и проверка формы после записи (guide-preset.js).
 */
import { normalizePresetOps, normalizePresetParams, applyPresetOps, buildPresetView, buildPresetFixLine, computePresetProblems, createStarterPreset } from '../../libraries/core/guide-preset.js';

/** После применённой правки пресета она сама идёт дальше: следующий шаг плана или короткий отчёт. */
const PRESET_FOLLOW_UP = 'The preset change was applied (see the last result). Continue the task: if your plan has a next step, do it now; if the work is finished, tell the user in one or two lines what changed and what is still open. Do not repeat the text you just wrote, and do not ask whether to apply — it is already applied.';
const MAX_DETAIL_BLOCKS = 40;

export function createPresetActions({ call, modules }) {
    const failure = message => ({ ok: false, message });
    const enabledModules = () => (typeof modules?.enabled === 'function' ? modules.enabled() : null);

    /** Пресет по id, по имени или — без указания — активный. */
    async function resolveRecord({ id, name } = {}) {
        const listed = await call('promptManager.presets');
        if (!listed.ok) return { error: listed.error.message };
        const list = listed.value ?? [];
        let wanted = id;
        if (!wanted && name) {
            const named = list.filter(item => String(item.name).trim().toLowerCase() === String(name).trim().toLowerCase());
            if (named.length > 1) return { error: `Several presets are called “${name}”; use the id: ${named.map(item => item.id).join(', ')}.` };
            wanted = named[0]?.id;
            if (!wanted) return { error: `There is no preset called “${name}”.` };
        }
        const settings = await call('promptManager.settings');
        const activeId = settings.ok ? settings.value?.activePresetId ?? null : null;
        wanted = wanted ?? activeId;
        if (!wanted) return { error: 'Which preset? Give its id or name (none is active).' };
        const record = await call('promptManager.preset', { id: wanted });
        if (!record.ok || !record.value) return { error: `There is no preset “${wanted}”.` };
        return { record: record.value, isActive: wanted === activeId };
    }

    // Долг по найденному: помнится по пресету, исправленное уходит из плана, когда не осталось ни одной находки.
    const debt = new Map();
    const settle = (record, changed) => {
        const found = computePresetProblems(record.preset, { changed, enabledModules: enabledModules() });
        debt.set(record.id, found);
        const line = buildPresetFixLine([...debt.values()].flat());
        return { planFix: line, note: found.length ? ` Saved. ${found.length} thing${found.length === 1 ? '' : 's'} in the preset look off: they are in your plan.` : '' };
    };

    async function save(record, label) {
        const saved = await call('promptManager.savePreset', { record, label });
        return saved.ok ? { value: saved.value } : { error: saved.error.message };
    }

    return {
        'preset.read': {
            safe: true,
            thenContinue: true,
            followUp: 'The full preset is in the last result. Use it for the task; do not re-read it unless you changed it.',
            description: 'Read the FULL Prompt Manager preset: the order tree with names and ids, the text of every block, generation settings, Guided CoT and text rules. Params: {"id": "<preset id>"} or {"name": "<exact name>"}; with neither, the active preset. Use it before you edit one the state does not show in full.',
            async run(params = {}) {
                const found = await resolveRecord(params);
                if (found.error) return failure(found.error);
                return { ok: true, message: `Read the preset “${found.record.name}”.`, detail: buildPresetView(found.record, { isActive: found.isActive }) };
            },
        },
        'preset.preview': {
            safe: true,
            thenContinue: true,
            followUp: 'The preview of the request is in the last result. Read it against the task: what is sent, in what order, how many tokens each block takes, what was dropped, and what the cache says.',
            description: 'Show what the Prompt Manager would send to the model for the OPEN chat, without sending: tokens per block, what was dropped and why, macro warnings, and how much of the start of the request stayed the same between the last requests (the provider cache). No params. Needs a chat open in SillyTavern.',
            async run() {
                const shown = await call('promptManager.preview');
                if (!shown.ok) return failure(shown.error.message);
                if (shown.value?.skipped) return failure(`The Prompt Manager is not building this request: ${shown.value.skipped}`);
                const { tokens, report, dropped, budget, macros } = shown.value;
                const lines = [`Request preview: ${tokens.total} tokens${Number.isFinite(budget) ? ` of a budget of ${budget}` : ''}.`, 'Tokens by block:', ...tokens.byBlock.slice(0, MAX_DETAIL_BLOCKS).map(([name, count]) => `  ${name}: ${count}`)];
                const skipped = (report ?? []).filter(row => row.included === false);
                if (skipped.length) lines.push('Not sent:', ...skipped.map(row => `  ${row.name ?? row.blockId} — ${row.reason}`));
                if (dropped?.length) lines.push(`Dropped by trimming: ${dropped.map(item => `${item.block} (${item.tokens} tokens, ${item.reason})`).slice(0, 12).join('; ')}`);
                if (macros?.usedRandom) lines.push('Random macros are used: the provider cache breaks unless "Freeze random" is on in the Prompt Manager Settings tab.');
                if (macros?.unresolved?.length) lines.push(`Unknown macros left as text: ${macros.unresolved.join(', ')}`);
                const cache = await call('promptManager.stability');
                if (cache.ok && cache.value) {
                    const { volatile = [], recoverableTokens = 0, advice = [], verdict, cachedTokens } = cache.value;
                    lines.push(`Cache: ${verdict ?? 'no verdict yet'}${cachedTokens != null ? `; the provider reported ${cachedTokens} cached tokens` : ''}.`);
                    if (volatile.length) lines.push(`Blocks whose text changed between requests: ${volatile.join(', ')}. ${recoverableTokens} stable tokens stand after the first of them${advice.length ? ` (${advice.map(item => item.block).slice(0, 8).join(', ')})` : ''}.`);
                }
                return { ok: true, message: `Previewed the request (${tokens.total} tokens).`, detail: lines.join('\n') };
            },
        },
        'preset.create': {
            autoApply: true,
            thenContinue: true,
            followUp: PRESET_FOLLOW_UP,
            description: 'Send as a ```proposal``` block {"action": "preset.create", "params": {…}}; it is applied at once. Create a NEW Prompt Manager preset. Params: {"name": "My preset", "from": "<id of a preset to copy; without it a starter with the standard markers (card, world, examples, chat history)>", "ops": [changes as in preset.update], "params": {generation settings}}. A name that is already taken is refused. The new preset is NOT made active. Follow "Prompt Manager presets: how to work". CACHE LAW (it comes before everything else when you place anything): whatever can differ between two requests (module rows like RP Time, Notebook, Secrets, Memory graph; blocks with a condition; random macros) goes AFTER the chat history or inside the chat at a small depth, never before the history; the ONLY exception is the Summaries row, which always stands before the chat history. Breaking the law makes the provider re-read the whole history on every reply. CONTEXT BUDGET: the sweet spot for roleplay is about 35 000 tokens for the whole request (preset, card, lorebook, memory, history); the ceiling without losses is 50 000 to 60 000 in total; say what a change costs in tokens.',
            async run(params = {}) {
                const name = String(params.name ?? '').trim();
                if (!name) return failure('A new preset needs a name.');
                const listed = await call('promptManager.presets');
                if (!listed.ok) return failure(listed.error.message);
                if ((listed.value ?? []).some(item => String(item.name).trim().toLowerCase() === name.toLowerCase())) return failure(`A preset called “${name}” already exists — pick another name, or change that one.`);
                let preset;
                if (params.from) {
                    const source = await resolveRecord({ id: params.from });
                    if (source.error) return failure(source.error);
                    preset = structuredClone(source.record.preset);
                    preset.name = name;
                } else preset = createStarterPreset(name);
                const touched = new Set();
                const changes = [];
                if (params.ops !== undefined) {
                    const ops = normalizePresetOps(params.ops);
                    if (!ops.ok) return failure(ops.error);
                    const applied = applyPresetOps(preset, ops.value);
                    if (!applied.ok) return failure(applied.error);
                    preset = applied.preset;
                    applied.changedBlocks.forEach(id => touched.add(id));
                    changes.push(...applied.changes);
                }
                if (params.params !== undefined) {
                    const made = normalizePresetParams(params.params);
                    if (!made.ok) return failure(made.error);
                    preset.params = { ...(preset.params ?? {}), ...made.value };
                }
                const saved = await save({ name, sourceName: null, preset }, 'created by Mea');
                if (saved.error) return failure(saved.error);
                const { planFix, note } = settle(saved.value, params.from ? touched : null);
                return { ok: true, message: `Preset “${name}” is created (${saved.value.id}); it is not active yet.${note}`, planFix };
            },
        },
        'preset.update': {
            autoApply: true,
            thenContinue: true,
            followUp: PRESET_FOLLOW_UP,
            description: 'Send as a ```proposal``` block {"action": "preset.update", "params": {…}}; it is applied at once. Change a preset. Params: {"id": "<preset id>" (or "name"; without both the active one), "label": "optional note for the version list", "ops": [changes, in order], "params": {generation settings such as "temperature": 0.8}}. Changes address blocks and groups by NAME (or block id) as shown in the preset view: {"op": "addBlock", "name", "content", "role": "system|user|assistant", "position": "relative|depth", "depth", "order", "trimPriority", "into": "<group>" | "before": "<node>" | "after": "<node>"} · {"op": "editBlock", "block", plus the fields that change} · {"op": "removeBlock", "block"} · {"op": "addGroup", "name", "wrap": true (default: <name>…</name> around the content), "skipWhenEmpty", "placement": {"mode": "depth", "depth", "order"}, "into"/"before"/"after"} · {"op": "moveNode", "node", "into"|"before"|"after"} · {"op": "setEnabled", "node", "enabled"} · {"op": "removeNode", "node", "withChildren"} · {"op": "setCondition", "node", "condition": null | {"type": "keyword", "words": [..], "scan": 3, "source": "any|user|char"} | {"type": "messageLength", "source": "lastUser|lastChar", "op": "<|>|=", "value"} | {"type": "tracker", "trackerId", "field", "op", "value"} | {"type": "variable", "name", "op", "value"} | {"type": "chance", "percent"} | {"type": "everyN", "n"} | {"type": "cooldown", "key", "turns"} | {"type": "jev", "question", "minChance"} | {"type": "all|any", "items": [..]} | {"type": "not", "item"}} · {"op": "placeModule", "contribution": "time", "depth": 0, "order": 100} or {"op": "placeModule", "contribution", "before"|"after", "atHistoryStart"} · {"op": "addRule", "name", "find": {"kind": "text|remove|between|regex", …}, "replace", "scope": {"roles", "minDepth", "maxDepth", "targets"}} · {"op": "removeRule", "rule"} · {"op": "setCot", "enabled", "mode", "condition", "injectAs", "display", "regen", "stepMaxTokens", "retries"} · {"op": "addCotStep", "name", "content"} · {"op": "removeCotStep", "step"}. Up to 40 changes per update. CACHE LAW (it comes before everything else when you place anything): whatever can differ between two requests (module rows like RP Time, Notebook, Secrets, Memory graph; blocks with a condition; random macros) goes AFTER the chat history or inside the chat at a small depth, never before the history; the ONLY exception is the Summaries row, which always stands before the chat history. Breaking the law makes the provider re-read the whole history on every reply. CONTEXT BUDGET: the sweet spot for roleplay is about 35 000 tokens for the whole request (preset, card, lorebook, memory, history); the ceiling without losses is 50 000 to 60 000 in total; say what a change costs in tokens. The previous version is saved automatically and can be restored. Markers (Chat History, Char Description…) can be moved or switched off, never removed. To change a long block send the whole new text of that block, never a fragment.',
            async run(params = {}) {
                const found = await resolveRecord(params);
                if (found.error) return failure(found.error);
                let preset = found.record.preset;
                const touched = new Set();
                const changes = [];
                if (params.ops !== undefined) {
                    const ops = normalizePresetOps(params.ops);
                    if (!ops.ok) return failure(ops.error);
                    const applied = applyPresetOps(preset, ops.value);
                    if (!applied.ok) return failure(applied.error);
                    preset = applied.preset;
                    applied.changedBlocks.forEach(id => touched.add(id));
                    changes.push(...applied.changes);
                }
                if (params.params !== undefined) {
                    const made = normalizePresetParams(params.params);
                    if (!made.ok) return failure(made.error);
                    preset = { ...preset, params: { ...(preset.params ?? {}), ...made.value } };
                    changes.push(`generation settings: ${Object.keys(made.value).join(', ')}`);
                }
                if (!changes.length) return failure('Nothing to change in the preset.');
                const label = String(params.label ?? '').trim().slice(0, 100) || `Mea: ${changes[0]}${changes.length > 1 ? ` (+${changes.length - 1})` : ''}`.slice(0, 100);
                const saved = await save({ ...found.record, preset }, label);
                if (saved.error) return failure(saved.error);
                const { planFix, note } = settle(saved.value, touched);
                return { ok: true, message: `Preset “${found.record.name}” is updated: ${changes.join('; ')}. The previous version is saved.${found.isActive ? ' It is the active preset, so the next reply already uses it.' : ''}${note}`, planFix };
            },
        },
        'preset.duplicate': {
            autoApply: true,
            thenContinue: true,
            followUp: PRESET_FOLLOW_UP,
            description: 'Copy a preset under a new name, to try changes on the copy. Params: {"id": "<preset id>", "name": "optional new name"}. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const found = await resolveRecord({ id: params.id });
                if (found.error) return failure(found.error);
                const copied = await call('promptManager.duplicatePreset', { id: found.record.id, name: params.name });
                return copied.ok ? { ok: true, message: `Copied “${found.record.name}” as “${copied.value.name}” (${copied.value.id}).` } : failure(copied.error.message);
            },
        },
        'preset.restore': {
            autoApply: true,
            thenContinue: true,
            followUp: PRESET_FOLLOW_UP,
            description: 'Put a preset back to an earlier saved version. Params: {"id": "<preset id>", "key": "<version key from the state>"}. The current state is saved first, so a restore can be undone too. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const found = await resolveRecord({ id: params.id });
                if (found.error) return failure(found.error);
                if (!params.key) return failure('Which version? Its key from the list is needed.');
                const restored = await call('promptManager.rollback', { presetId: found.record.id, key: params.key });
                return restored.ok ? { ok: true, message: `Preset “${found.record.name}” is back to the chosen version.` } : failure(restored.error.message);
            },
        },
        'preset.override': {
            autoApply: true,
            thenContinue: true,
            followUp: PRESET_FOLLOW_UP,
            description: 'Set generation settings that win over the preset for one model, one character or one chat. Params: {"scope": "model" | "character" | "chat", "key": "<model name | character name | chat id>", "params": {"temperature": 0.7}}; empty "params" clears that layer. Overrides apply only while "Overrides" is switched on in the Prompt Manager Settings tab (off by default) — say so. Send it in a ```proposal``` block.',
            async run(params = {}) {
                if (!['model', 'character', 'chat'].includes(params.scope) || !params.key) return failure('An override needs "scope" (model, character or chat), "key" and "params".');
                const hasParams = params.params && Object.keys(params.params).length;
                if (hasParams) {
                    const made = normalizePresetParams(params.params);
                    if (!made.ok) return failure(made.error);
                }
                const done = await call('promptManager.setOverride', { scope: params.scope, key: params.key, params: hasParams ? params.params : {} });
                if (!done.ok) return failure(done.error.message);
                const settings = await call('promptManager.settings');
                const on = settings.ok && settings.value?.overrides?.enabled === true;
                return { ok: true, message: `${hasParams ? 'Set' : 'Cleared'} the ${params.scope} override for “${params.key}”.${on ? '' : ' Overrides are switched off in the Prompt Manager Settings tab, so they do nothing until the user switches them on.'}` };
            },
        },
    };
}
