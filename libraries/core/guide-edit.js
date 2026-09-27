import { TRIGGER_MODES, computeTriggers } from './trigger-modes.js';
import { slug } from './guide-create.js';
import { planSettingChanges, describePlan } from './guide-settings.js';

/**
 * Правка и удаление для гида (cores/guide): чистые функции. Как и создание (guide-create.js), каждое действие приходит блоком ```proposal``` — карточка показывает, что
 * изменится, кнопка применяет. Здесь параметры приводятся к настоящему изменению (или отвергаются с причиной) и строится описание для карточки.
 *
 *   tracker.update  { id, fields?: [{ name, prompt?, default? }] (по имени: есть — правится, нет — добавляется), removeFields?: [name], when?, every?, enabled? }
 *   tracker.delete  { id }
 *   macro.update    { name, text | code }        macro.delete { name }
 *   lorebook.updateEntry { uid, book?, title?, keys?, content?, always? }     lorebook.deleteEntry { uid, book? }
 *   module.setting.set   { module, changes: { key: value } }   — только то, что Модуль объявил (guide-settings.js)
 *   postprocess.pass.add { name?, prompt, workerId?, includeContext?, contextDepth?, position? }   .update { id, name?, prompt?, workerId?, enabled?, includeContext?, contextDepth? }
 *   postprocess.pass.remove { id }   .move { id, position }   — проходы Post-Turn Processor (исполняет сам Модуль через `guideTools()`)
 */

export const EDIT_ACTIONS = Object.freeze(['tracker.update', 'tracker.delete', 'macro.update', 'macro.delete', 'lorebook.updateEntry', 'lorebook.deleteEntry', 'module.setting.set',
    'postprocess.pass.add', 'postprocess.pass.update', 'postprocess.pass.remove', 'postprocess.pass.move']);

const text = (value, max) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : '');
const fail = error => ({ ok: false, error });
const TRACKER_WHEN = TRIGGER_MODES.map(mode => mode.value);

/** Правка трекера: `{ id, fields, removeFields, when, every, enabled }` (только названное) либо ошибка. */
export function normalizeTrackerPatch(params = {}) {
    const id = slug(params.id);
    if (!id) return fail('Which tracker? Its id is needed.');
    const fields = (Array.isArray(params.fields) ? params.fields : []).map(raw => {
        const name = slug(typeof raw === 'string' ? raw : raw?.name, 24);
        if (!name) return null;
        const field = { name };
        if (raw && typeof raw === 'object' && 'prompt' in raw) field.prompt = text(raw.prompt, 300);
        if (raw && typeof raw === 'object' && 'default' in raw) field.default = typeof raw.default === 'number' && Number.isFinite(raw.default) ? raw.default : text(raw.default, 80);
        return field;
    }).filter(Boolean);
    const removeFields = (Array.isArray(params.removeFields) ? params.removeFields : []).map(name => slug(name, 24)).filter(Boolean);
    const patch = { id, fields, removeFields };
    if (TRACKER_WHEN.includes(params.when)) patch.when = params.when;
    if (params.every !== undefined) patch.every = Math.min(50, Math.max(1, Math.round(Number(params.every) || 1)));
    if (typeof params.enabled === 'boolean') patch.enabled = params.enabled;
    if (!fields.length && !removeFields.length && patch.when === undefined && patch.every === undefined && patch.enabled === undefined) return fail('Nothing to change in the tracker.');
    return { ok: true, value: patch };
}

/** Применяет правку к записи трекера (чистая): поля по имени, триггер, включённость. */
export function applyTrackerPatch(tracker, patch) {
    const byName = new Map((tracker.fields ?? []).map(field => [field.name, { ...field }]));
    for (const name of patch.removeFields) byName.delete(name);
    for (const field of patch.fields) byName.set(field.name, { prompt: '', default: '', ...byName.get(field.name), ...field });
    const next = { ...tracker, fields: [...byName.values()] };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.when !== undefined || patch.every !== undefined) {
        const every = patch.every ?? 1;
        let mode = patch.when ?? (every > 1 ? 'everyNReplies' : 'everyReply');
        if (mode === 'everyReply' && every > 1) mode = 'everyNReplies';
        next.triggers = computeTriggers(mode, every);
    }
    return next;
}

export function normalizeId(params = {}) {
    const id = slug(params.id);
    return id ? { ok: true, value: { id } } : fail('Which tracker? Its id is needed.');
}

export function normalizeMacroPatch(params = {}) {
    const name = text(params.name, 32).replace(/[^A-Za-z0-9_]/g, '_');
    if (!name) return fail('Which macro? Its name is needed.');
    const code = text(params.code, 4000);
    const source = code || text(params.text, 2000);
    return source ? { ok: true, value: { name, kind: code ? 'code' : 'text', source } } : fail('The macro would be empty.');
}

export function normalizeMacroName(params = {}) {
    const name = text(params.name, 32).replace(/[^A-Za-z0-9_]/g, '_');
    return name ? { ok: true, value: { name } } : fail('Which macro? Its name is needed.');
}

export function normalizeEntryPatch(params = {}) {
    const uid = Number(params.uid);
    if (!Number.isInteger(uid)) return fail('Which entry? Its uid is needed.');
    const patch = {};
    if (typeof params.title === 'string' && params.title.trim()) patch.comment = text(params.title, 80);
    if (Array.isArray(params.keys)) patch.key = [...new Set(params.keys.map(key => text(key, 40)).filter(Boolean))].slice(0, 8);
    if (typeof params.content === 'string' && params.content.trim()) patch.content = text(params.content, 4000);
    if (typeof params.always === 'boolean') patch.constant = params.always;
    if (!Object.keys(patch).length) return fail('Nothing to change in the entry.');
    return { ok: true, value: { uid, book: text(params.book, 120) || undefined, patch } };
}

export function normalizeEntryRef(params = {}) {
    const uid = Number(params.uid);
    return Number.isInteger(uid) ? { ok: true, value: { uid, book: text(params.book, 120) || undefined } } : fail('Which entry? Its uid is needed.');
}

/** Проходы Post-Turn Processor: параметры → `{ ok, value }` (только названное) либо ошибка. Существование id и подключения проверяет сам Модуль. */
export function normalizePassParams(action, params = {}) {
    const id = text(params.id, 80);
    const position = Number.isInteger(Number(params.position)) && Number(params.position) >= 1 ? Number(params.position) : undefined;
    const fields = {};
    if (typeof params.name === 'string' && params.name.trim()) fields.name = text(params.name, 60);
    if (typeof params.prompt === 'string' && params.prompt.trim()) fields.prompt = text(params.prompt, 4000);
    if (typeof params.workerId === 'string') fields.workerId = text(params.workerId, 120);
    if (typeof params.enabled === 'boolean') fields.enabled = params.enabled;
    if (typeof params.includeContext === 'boolean') fields.includeContext = params.includeContext;
    if (params.contextDepth !== undefined && Number.isFinite(Number(params.contextDepth))) fields.contextDepth = Math.round(Number(params.contextDepth));
    // Сэмплер и ризонинг прохода: границы зажимает сам Модуль (`sanitizePasses`) — здесь только тип.
    for (const key of PASS_NUMBERS) if (params[key] !== undefined && params[key] !== '' && Number.isFinite(Number(params[key]))) fields[key] = Number(params[key]);
    for (const key of PASS_WORDS) if (typeof params[key] === 'string' && params[key].trim()) fields[key] = params[key].trim().toLowerCase();
    if (action === 'postprocess.pass.add') return fields.prompt ? { ok: true, value: { fields: { name: fields.name ?? 'New pass', ...fields }, position } } : fail('A pass needs an instruction (what to do with the reply).');
    if (!id) return fail('Which pass? Its id is needed.');
    if (action === 'postprocess.pass.remove') return { ok: true, value: { id } };
    if (action === 'postprocess.pass.move') return position ? { ok: true, value: { id, position } } : fail('Move to which position (1 = first)?');
    return Object.keys(fields).length ? { ok: true, value: { id, fields } } : fail('Nothing to change in the pass.');
}

/** Числовые и словесные настройки генерации прохода (ползунки «Temperature» и т. д. в карточке Модуля). */
export const PASS_NUMBERS = Object.freeze(['temperature', 'topP', 'topK', 'maxTokens', 'reasoningBudget']);
export const PASS_WORDS = Object.freeze(['reasoningMode', 'reasoningEffort']);
const samplerLine = fields => {
    const parts = [...PASS_NUMBERS, ...PASS_WORDS].filter(key => fields[key] !== undefined).map(key => `${key} ${fields[key]}`);
    return parts.length ? [`Generation: ${parts.join(', ')}`] : [];
};

function describePass(action, params) {
    const made = normalizePassParams(action, params);
    if (!made.ok) return made;
    const { value } = made;
    if (action === 'postprocess.pass.add') {
        const { fields } = value;
        return { ok: true, title: `New pass “${fields.name}”`, lines: [`Instruction: ${fields.prompt.slice(0, 240)}`, `Model: ${fields.workerId || 'any connection'}`, ...(fields.includeContext ? [`Sees the last ${fields.contextDepth ?? 6} chat messages too`] : []), ...samplerLine(fields), value.position ? `Position: ${value.position}` : 'Runs last'] };
    }
    if (action === 'postprocess.pass.remove') return { ok: true, danger: true, title: 'Delete a Post-Turn pass', lines: [`Pass ${value.id} is removed; the other passes keep their order.`] };
    if (action === 'postprocess.pass.move') return { ok: true, title: 'Reorder Post-Turn passes', lines: [`Pass ${value.id} → position ${value.position}. Each pass sees the result of the one before it.`] };
    const { fields } = value;
    return { ok: true, title: `Change Post-Turn pass ${value.id}`, lines: [
        ...(fields.name !== undefined ? [`Name: ${fields.name}`] : []),
        ...(fields.prompt !== undefined ? [`Instruction: ${fields.prompt.slice(0, 240)}`] : []),
        ...(fields.workerId !== undefined ? [`Model: ${fields.workerId || 'any connection'}`] : []),
        ...(fields.enabled !== undefined ? [fields.enabled ? 'Turn on' : 'Turn off'] : []),
        ...(fields.includeContext !== undefined ? [fields.includeContext ? 'Also sees recent chat messages' : 'Sees only the text it rewrites'] : []),
        ...(fields.contextDepth !== undefined ? [`Chat context: ${fields.contextDepth} messages`] : []),
        ...samplerLine(fields),
    ] };
}

/**
 * Описание для карточки: `{ ok, title, lines, danger }`. `context.settingsOf(moduleId)` → спецификации Модуля (для «было → стало»).
 */
export function describeEdit(action, params, context = {}) {
    if (action === 'tracker.update') {
        const made = normalizeTrackerPatch(params);
        if (!made.ok) return made;
        const { value } = made;
        const lines = [
            ...value.fields.map(field => `Field ${field.name}: ${[field.prompt !== undefined ? `“${field.prompt}”` : '', field.default !== undefined ? `starts at ${field.default}` : ''].filter(Boolean).join(', ') || 'kept'}`),
            ...value.removeFields.map(name => `Remove field ${name}`),
            ...(value.when !== undefined || value.every !== undefined ? [`Updated: ${value.when === 'everyNReplies' || (value.every > 1) ? `every ${value.every ?? 'N'} replies` : value.when ?? 'after every reply'}`] : []),
            ...(value.enabled !== undefined ? [value.enabled ? 'Turn on' : 'Turn off'] : []),
        ];
        return { ok: true, title: `Change tracker “${value.id}”`, lines };
    }
    if (action === 'tracker.delete') {
        const made = normalizeId(params);
        return made.ok ? { ok: true, danger: true, title: `Delete tracker “${made.value.id}”`, lines: ['Its fields and settings are removed. Values already saved in chats stay in those chats.'] } : made;
    }
    if (action === 'macro.update') {
        const made = normalizeMacroPatch(params);
        return made.ok ? { ok: true, title: `Change macro {{${made.value.name}}}`, lines: [made.value.kind === 'code' ? 'New program:' : 'New text:', made.value.source.slice(0, 240)] } : made;
    }
    if (action === 'macro.delete') {
        const made = normalizeMacroName(params);
        return made.ok ? { ok: true, danger: true, title: `Delete macro {{${made.value.name}}}`, lines: ['Prompts that use it will show the bare {{name}} afterwards.'] } : made;
    }
    if (action === 'lorebook.updateEntry') {
        const made = normalizeEntryPatch(params);
        if (!made.ok) return made;
        const { patch } = made.value;
        return { ok: true, title: `Change lorebook entry #${made.value.uid}`, lines: [
            ...(patch.comment !== undefined ? [`Title: ${patch.comment}`] : []),
            ...(patch.key !== undefined ? [`Triggers on: ${patch.key.join(', ') || '—'}`] : []),
            ...(patch.constant !== undefined ? [patch.constant ? 'Always active' : 'Active only on its trigger words'] : []),
            ...(patch.content !== undefined ? [`Text: ${patch.content.slice(0, 200)}`] : []),
        ] };
    }
    if (action === 'lorebook.deleteEntry') {
        const made = normalizeEntryRef(params);
        return made.ok ? { ok: true, danger: true, title: `Delete lorebook entry #${made.value.uid}`, lines: ['The entry is removed from its lorebook.'] } : made;
    }
    if (action === 'module.setting.set') {
        const moduleId = text(params?.module, 80);
        const specs = context.settingsOf?.(moduleId);
        if (!specs) return fail(`"${moduleId || 'that module'}" is not on or has no settings I can change.`);
        const plan = planSettingChanges(specs, params?.changes);
        return plan.ok ? { ok: true, title: `Settings — ${context.titleOf?.(moduleId) ?? moduleId}`, lines: describePlan(plan.changes) } : plan;
    }
    if (action.startsWith('postprocess.pass.')) return describePass(action, params);
    return fail(`Unknown proposal "${action}".`);
}
