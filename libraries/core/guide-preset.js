import { PARAM_KEYS, MARKER_IDS, createEmptyPreset } from './pm-preset-format.js';
import { normalizeCot } from './pm-cot.js';
import { isDivider } from './pm-dividers.js';

/**
 * Пресеты Prompt Manager для гида (чистые функции): правки приходят блоком ```proposal``` одним списком операций (`ops`) над блоками и деревом порядка —
 * здесь они проверяются и применяются к КОПИИ пресета, а Ядро `promptManager` пишет результат и сохраняет версию. Узлы называются по имени, не по пути индексов:
 * гид видит имена в `buildPresetView`, а путь сдвигается при каждой правке. Вторая половина — `computePresetProblems`: проверка формы пресета (парные теги, битые ссылки
 * на шаги, дубли подзаголовков, зависимость от выключенных Модулей, вклады, ломающие кэш), по образцу character-lint.js: находка идёт гиду в план, а не отказом.
 */

export const PRESET_ACTIONS = Object.freeze(['preset.create', 'preset.update', 'preset.restore', 'preset.duplicate', 'preset.override']);

const ROLES = ['system', 'user', 'assistant'];
const POSITIONS = ['relative', 'depth'];
const MAX_OPS = 40;
const MAX_NAME = 120;
const MAX_CONTENT = 40000;
const VIEW_CAP_CHARS = 12000;
const OVERRIDE_SCOPES = ['model', 'character', 'chat'];
/**
 * Вклады Модулей, чьё содержимое меняется по ходу чата: перед историей они рвут кэш префикса на всей истории (PM → Log & cache). Единственное исключение, которое
 * владелец велел держать ПЕРЕД историей, — саммари (`summary`): они заменяют начало чата, и их место там, а не у конца.
 */
const VOLATILE_CONTRIBUTIONS = Object.freeze(['time', 'notebook', 'secrets', 'memory-graph', 'memory-graph-plot']);
const MUST_STAND_BEFORE_HISTORY = Object.freeze(['summary']);
const RANDOM_MACRO = /\{\{\s*(?:random|roll|pick)\b/i;
const MODULE_MENTIONS = Object.freeze([
    { module: 'module.notebook', title: 'Notebook', pattern: /\bnotebook\b/i },
    { module: 'module.secrets', title: 'Secrets', pattern: /\bsecrets?\b(?:\s+tool)?/i },
    { module: 'module.time', title: 'RP Time', pattern: /\{\{\s*rp-time_/i },
]);
const COMMON_TYPOS = Object.freeze([
    ['discription', 'description'], ['discriptions', 'descriptions'], ['discribe', 'describe'], ['guildelines', 'guidelines'], ['obserivng', 'observing'],
    ['acomplish', 'accomplish'], ['obsticle', 'obstacle'], ['obsticles', 'obstacles'], ['knowlage', 'knowledge'], ['knlowlage', 'knowledge'], ['imapcts', 'impacts'],
    ['curent', 'current'], ['geniunly', 'genuinely'], ['independance', 'independence'], ['playtrough', 'playthrough'], ['enviroment', 'environment'],
    ['instinctiual', 'instinctual'], ['responce', 'response'], ['recieve', 'receive'], ['occured', 'occurred'], ['seperate', 'separate'], ['definately', 'definitely'],
]);

const fail = error => ({ ok: false, error });
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, maxLength) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, maxLength) : undefined);
const sameName = (first, second) => String(first ?? '').trim().toLowerCase() === String(second ?? '').trim().toLowerCase();
const clampInteger = (value, min, max) => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Math.min(max, Math.max(min, Math.round(Number(value)))) : undefined);

let counter = 0;
const newBlockId = () => `blk_${Date.now().toString(36)}${(counter++).toString(36)}`;

/* ----------------------------------------------------------------------------------------------------------------------------------------------- */
/* Поиск узлов по имени                                                                                                                              */

/** Список, в котором лежит узел, и его индекс — обход групп и веток «одного из». */
function locate(tree, test, parent = null) {
    for (let index = 0; index < tree.length; index += 1) {
        const node = tree[index];
        if (test(node)) return { list: tree, index, node, parent };
        const inner = node.type === 'group' ? locate(node.children ?? [], test, node)
            : node.type === 'choice' ? (node.options ?? []).map(option => locate(option.children ?? [], test, node)).find(Boolean) : null;
        if (inner) return inner;
    }
    return null;
}

/** Имя, под которым узел виден гиду: блок — по имени блока, группа и вклад модуля — по своему. */
function nodeLabel(node, blocks) {
    if (node.type === 'group') return node.name ?? '';
    if (node.type === 'inject') return node.name ?? node.contribution ?? '';
    if (node.type === 'item') { const block = blocks.find(item => item.id === node.block); return block?.name ?? block?.id ?? node.block; }
    if (node.type === 'note') return node.text ?? 'Note';
    if (node.type === 'choice') return node.name ?? 'Choice';
    if (isDivider(node)) return node.name ?? '';
    return '';
}

/** Узел по имени (или id блока): несколько с одним именем — отказ со списком, чтобы правка не ушла не туда. */
function findNode(preset, reference) {
    const wanted = String(reference ?? '').trim();
    if (!wanted) return { error: 'Which block or group? A name is needed.' };
    const matches = [];
    const visit = (nodes) => {
        for (const node of nodes) {
            if (node.type === 'item' && node.block === wanted) matches.push(node);
            else if (sameName(nodeLabel(node, preset.blocks), wanted) && !isDivider(node)) matches.push(node);
            if (node.type === 'group') visit(node.children ?? []);
            if (node.type === 'choice') for (const option of node.options ?? []) visit(option.children ?? []);
        }
    };
    visit(preset.tree);
    if (!matches.length) return { error: `There is no block or group called “${wanted}” in this preset.` };
    if (matches.length > 1) return { error: `“${wanted}” names ${matches.length} blocks; use the block id (shown in the preset view) for the one you mean.` };
    return { node: matches[0], location: locate(preset.tree, node => node === matches[0]) };
}

function findBlock(preset, reference) {
    const wanted = String(reference ?? '').trim();
    if (!wanted) return { error: 'Which block? A name is needed.' };
    const byId = preset.blocks.find(block => block.id === wanted);
    if (byId) return { block: byId };
    const named = preset.blocks.filter(block => sameName(block.name, wanted));
    if (named.length === 1) return { block: named[0] };
    return { error: named.length ? `“${wanted}” names ${named.length} blocks; use the block id (shown in the preset view).` : `There is no block called “${wanted}” in this preset.` };
}

/** Куда вставить узел: `into` (в конец группы), `before` / `after` (рядом с названным узлом) или в конец верхнего уровня. */
function insertNode(preset, node, place = {}) {
    if (place.into) {
        const found = findNode(preset, place.into);
        if (found.error) return found;
        if (found.node.type !== 'group') return { error: `“${place.into}” is not a group; blocks can only be put inside a group.` };
        found.node.children = found.node.children ?? [];
        found.node.children.push(node);
        return { ok: true };
    }
    const anchor = place.before ?? place.after;
    if (anchor) {
        const found = findNode(preset, anchor);
        if (found.error) return found;
        found.location.list.splice(found.location.index + (place.after ? 1 : 0), 0, node);
        return { ok: true };
    }
    preset.tree.push(node);
    return { ok: true };
}

const placementOf = place => ({ into: place.into, before: place.before, after: place.after });

/* ----------------------------------------------------------------------------------------------------------------------------------------------- */
/* Операции                                                                                                                                          */

function normalizeBlockFields(raw, { isNew }) {
    const fields = {};
    if (raw.name !== undefined) {
        const name = cleanText(raw.name, MAX_NAME);
        if (!name) return fail('A block needs a name.');
        fields.name = name;
    } else if (isNew) return fail('A new block needs a name.');
    if (raw.content !== undefined) {
        const content = cleanText(raw.content, MAX_CONTENT);
        if (content === undefined) return fail('"content" must be text.');
        fields.content = content;
    } else if (isNew) fields.content = '';
    if (raw.role !== undefined) {
        if (!ROLES.includes(raw.role)) return fail(`"role" is one of: ${ROLES.join(', ')}.`);
        fields.role = raw.role;
    }
    if (raw.position !== undefined) {
        if (!POSITIONS.includes(raw.position)) return fail('"position" is "relative" (where it stands in the list) or "depth" (inside the chat, N messages from the end).');
        fields.position = raw.position;
    }
    for (const [key, min, max] of [['depth', 0, 200], ['order', 0, 9999], ['trimPriority', 0, 100]]) {
        if (raw[key] === undefined) continue;
        const value = clampInteger(raw[key], min, max);
        if (value === undefined) return fail(`"${key}" is a number from ${min} to ${max}.`);
        fields[key] = value;
    }
    return { ok: true, value: fields };
}

const OP_PLACE_KEYS = ['into', 'before', 'after'];

/** Присланные операции → проверенные (форма, а не существование узлов: узлы проверяются при применении к конкретному пресету). */
export function normalizePresetOps(rawOps) {
    if (!Array.isArray(rawOps) || !rawOps.length) return fail('"ops" is a list of changes: [{"op": "editBlock", "block": "Name", "content": "…"}, …].');
    if (rawOps.length > MAX_OPS) return fail(`At most ${MAX_OPS} changes in one update; send the rest in the next one.`);
    const ops = [];
    for (const [index, raw] of rawOps.entries()) {
        const label = `Change ${index + 1}`;
        if (!isPlainObject(raw) || typeof raw.op !== 'string') return fail(`${label} needs an "op" name.`);
        if (OP_PLACE_KEYS.filter(key => raw[key]).length > 1) return fail(`${label}: use only one of "into", "before", "after".`);
        switch (raw.op) {
            case 'addBlock': {
                const made = normalizeBlockFields(raw, { isNew: true });
                if (!made.ok) return fail(`${label}: ${made.error}`);
                ops.push({ op: raw.op, fields: made.value, place: placementOf(raw) });
                break;
            }
            case 'editBlock': {
                const { block, ...rest } = raw;
                if (!block) return fail(`${label}: "block" (name or id) is needed.`);
                const made = normalizeBlockFields(rest, { isNew: false });
                if (!made.ok) return fail(`${label}: ${made.error}`);
                if (!Object.keys(made.value).length) return fail(`${label}: nothing to change in the block.`);
                ops.push({ op: raw.op, block, fields: made.value });
                break;
            }
            case 'removeBlock':
                if (!raw.block) return fail(`${label}: "block" is needed.`);
                ops.push({ op: raw.op, block: raw.block });
                break;
            case 'addGroup': {
                const name = cleanText(raw.name, MAX_NAME);
                if (!name) return fail(`${label}: a group needs a name.`);
                const placement = raw.placement === undefined ? undefined : isPlainObject(raw.placement) && raw.placement.mode === 'depth'
                    ? { mode: 'depth', depth: clampInteger(raw.placement.depth, 0, 200) ?? 4, order: clampInteger(raw.placement.order, 0, 9999) ?? 100 } : null;
                if (placement === null) return fail(`${label}: "placement" is {"mode": "depth", "depth": 4, "order": 100}.`);
                ops.push({ op: raw.op, name, wrap: raw.wrap !== false, skipWhenEmpty: raw.skipWhenEmpty !== false, placement, place: placementOf(raw) });
                break;
            }
            case 'moveNode':
                if (!raw.node) return fail(`${label}: "node" (name) is needed.`);
                if (!OP_PLACE_KEYS.some(key => raw[key])) return fail(`${label}: say where: "into", "before" or "after" a named node.`);
                ops.push({ op: raw.op, node: raw.node, place: placementOf(raw) });
                break;
            case 'setEnabled':
                if (!raw.node) return fail(`${label}: "node" (name) is needed.`);
                if (typeof raw.enabled !== 'boolean') return fail(`${label}: "enabled" is true or false.`);
                ops.push({ op: raw.op, node: raw.node, enabled: raw.enabled });
                break;
            case 'removeNode':
                if (!raw.node) return fail(`${label}: "node" (name) is needed.`);
                ops.push({ op: raw.op, node: raw.node, withChildren: raw.withChildren === true });
                break;
            case 'setCondition': {
                if (!raw.node) return fail(`${label}: "node" (name) is needed.`);
                if (raw.condition !== null && !isConditionShape(raw.condition)) return fail(`${label}: "condition" is null (always) or a tree like {"type": "keyword", "words": ["dragon"], "scan": 3}, {"type": "all", "items": […]}, {"type": "not", "item": …}.`);
                ops.push({ op: raw.op, node: raw.node, condition: raw.condition });
                break;
            }
            case 'placeModule': {
                if (!raw.contribution) return fail(`${label}: "contribution" (the id of the module row, e.g. "time") is needed.`);
                if (raw.depth !== undefined) {
                    const depth = clampInteger(raw.depth, 0, 200);
                    if (depth === undefined) return fail(`${label}: "depth" is a number from 0 to 200 (0 = after the last message).`);
                    ops.push({ op: raw.op, contribution: raw.contribution, depth, order: clampInteger(raw.order, 0, 9999) ?? 100 });
                } else if (OP_PLACE_KEYS.some(key => raw[key])) ops.push({ op: raw.op, contribution: raw.contribution, place: placementOf(raw), atHistoryStart: raw.atHistoryStart === true });
                else return fail(`${label}: say where: "depth" (inside the chat) or "before"/"after" a named node.`);
                break;
            }
            case 'addRule': {
                const rule = normalizeRule(raw);
                if (!rule.ok) return fail(`${label}: ${rule.error}`);
                ops.push({ op: raw.op, rule: rule.value });
                break;
            }
            case 'removeRule':
                if (!raw.rule) return fail(`${label}: "rule" (name or id) is needed.`);
                ops.push({ op: raw.op, rule: raw.rule });
                break;
            case 'setCot': {
                const patch = normalizeCotPatch(raw);
                if (!patch.ok) return fail(`${label}: ${patch.error}`);
                ops.push({ op: raw.op, patch: patch.value });
                break;
            }
            case 'addCotStep': {
                const made = normalizeBlockFields(raw, { isNew: true });
                if (!made.ok) return fail(`${label}: ${made.error}`);
                ops.push({ op: raw.op, fields: made.value });
                break;
            }
            case 'removeCotStep':
                if (!raw.step) return fail(`${label}: "step" (name) is needed.`);
                ops.push({ op: raw.op, step: raw.step });
                break;
            default:
                return fail(`${label}: unknown "op" “${raw.op}”. Known: addBlock, editBlock, removeBlock, addGroup, moveNode, setEnabled, removeNode, setCondition, placeModule, addRule, removeRule, setCot, addCotStep, removeCotStep.`);
        }
    }
    return { ok: true, value: ops };
}

const BOOLEAN_LEAVES = ['all', 'any'];
function isConditionShape(condition) {
    if (!isPlainObject(condition) || typeof condition.type !== 'string') return false;
    if (BOOLEAN_LEAVES.includes(condition.type)) return Array.isArray(condition.items) && condition.items.every(isConditionShape);
    if (condition.type === 'not') return isConditionShape(condition.item);
    return true;
}

function normalizeRule(raw) {
    const name = cleanText(raw.name, MAX_NAME);
    if (!name) return fail('a text rule needs a name.');
    const find = raw.find;
    if (!isPlainObject(find) || !['text', 'remove', 'between', 'regex'].includes(find.kind)) return fail('"find" is {"kind": "text" | "remove" | "between" | "regex", …}: text/remove need "value", between needs "from" and "to", regex needs "pattern".');
    if ((find.kind === 'text' || find.kind === 'remove') && !find.value) return fail('"find.value" is needed.');
    if (find.kind === 'between' && !(find.from && find.to)) return fail('"find.from" and "find.to" are needed.');
    if (find.kind === 'regex') {
        if (!find.pattern) return fail('"find.pattern" is needed.');
        try { new RegExp(find.pattern, find.flags ?? ''); } catch (error) { return fail(`"find.pattern" is not a valid regex: ${error.message}`); }
    }
    const scope = isPlainObject(raw.scope) ? { ...raw.scope } : {};
    if (scope.roles !== undefined && !(Array.isArray(scope.roles) && scope.roles.every(role => ROLES.includes(role)))) return fail('"scope.roles" is a list of system, user, assistant.');
    if (scope.targets !== undefined && !['all', 'history', 'prompt'].includes(scope.targets)) return fail('"scope.targets" is all, history or prompt.');
    return { ok: true, value: { id: `rule_${Date.now().toString(36)}${(counter++).toString(36)}`, name, enabled: raw.enabled !== false, find: { ...find }, replace: typeof raw.replace === 'string' ? raw.replace : '', scope } };
}

function normalizeCotPatch(raw) {
    const patch = {};
    if (raw.enabled !== undefined) { if (typeof raw.enabled !== 'boolean') return fail('"enabled" is true or false.'); patch.enabled = raw.enabled; }
    if (raw.mode !== undefined) { if (!['always', 'trigger', 'manual'].includes(raw.mode)) return fail('"mode" is always, trigger or manual.'); patch.mode = raw.mode; }
    if (raw.condition !== undefined) { if (raw.condition !== null && !isConditionShape(raw.condition)) return fail('"condition" is null or a condition tree.'); patch.condition = raw.condition; }
    if (raw.injectAs !== undefined) { if (!['system', 'user'].includes(raw.injectAs)) return fail('"injectAs" is system or user.'); patch.injectAs = raw.injectAs; }
    if (raw.display !== undefined) { if (!['small', 'extended'].includes(raw.display)) return fail('"display" is small or extended.'); patch.display = raw.display; }
    if (raw.regen !== undefined) { if (!['all', 'final'].includes(raw.regen)) return fail('"regen" is all or final.'); patch.regen = raw.regen; }
    for (const [key, min, max] of [['stepMaxTokens', 50, 16000], ['retries', 0, 3]]) {
        if (raw[key] === undefined) continue;
        const value = clampInteger(raw[key], min, max);
        if (value === undefined) return fail(`"${key}" is a number from ${min} to ${max}.`);
        patch[key] = value;
    }
    if (!Object.keys(patch).length) return fail('nothing to change in Guided CoT.');
    return { ok: true, value: patch };
}

/** Параметры генерации пресета: только имена, которые знает формат; значения — числа, булевы или текст. */
export function normalizePresetParams(raw) {
    if (!isPlainObject(raw)) return fail('"params" is an object of generation settings, e.g. {"temperature": 0.8}.');
    const unknown = Object.keys(raw).filter(key => !PARAM_KEYS.includes(key));
    if (unknown.length) return fail(`Unknown generation setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known: ${PARAM_KEYS.join(', ')}.`);
    const value = {};
    for (const [key, item] of Object.entries(raw)) {
        if (!['number', 'boolean', 'string'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) return fail(`"${key}" must be a number, true/false or text.`);
        value[key] = item;
    }
    return { ok: true, value };
}

/** Применяет операции к копии пресета. Возвращает `{ ok, preset, changes, changedBlocks }` либо `{ ok: false, error }`; исходный пресет не меняется. */
export function applyPresetOps(preset, ops) {
    const next = structuredClone(preset);
    next.blocks = next.blocks ?? [];
    next.tree = next.tree ?? [];
    const changes = [];
    const changedBlocks = new Set();
    for (const [index, op] of ops.entries()) {
        const step = (message) => fail(`Change ${index + 1} (${op.op}): ${message}`);
        switch (op.op) {
            case 'addBlock': {
                if (next.blocks.some(block => sameName(block.name, op.fields.name))) return step(`a block called “${op.fields.name}” already exists; edit it, or pick another name.`);
                const id = newBlockId();
                const block = { id, role: 'system', ...op.fields };
                const placed = insertNode(next, { type: 'item', block: id, enabled: true }, op.place);
                if (placed.error) return step(placed.error);
                next.blocks.push(block);
                changedBlocks.add(id);
                changes.push(`added “${block.name}”${op.place.into ? ` into “${op.place.into}”` : ''}`);
                break;
            }
            case 'editBlock': {
                const found = findBlock(next, op.block);
                if (found.error) return step(found.error);
                if (found.block.marker) return step(`“${found.block.name ?? found.block.id}” is a marker the assembler fills in; it has no text to edit.`);
                if (op.fields.name && !sameName(op.fields.name, found.block.name) && next.blocks.some(block => block !== found.block && sameName(block.name, op.fields.name))) return step(`a block called “${op.fields.name}” already exists.`);
                Object.assign(found.block, op.fields);
                changedBlocks.add(found.block.id);
                changes.push(`changed ${Object.keys(op.fields).join(', ')} of “${found.block.name ?? found.block.id}”`);
                break;
            }
            case 'removeBlock': {
                const found = findBlock(next, op.block);
                if (found.error) return step(found.error);
                if (found.block.marker || MARKER_IDS.includes(found.block.id)) return step('a marker block cannot be removed (switch it off with setEnabled instead).');
                if (['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'].includes(found.block.id)) return step(`“${found.block.name}” is where the character card's own prompts land; switch it off or leave it empty instead of removing it.`);
                let removed = 0;
                for (let at = locate(next.tree, node => node.type === 'item' && node.block === found.block.id); at; at = locate(next.tree, node => node.type === 'item' && node.block === found.block.id)) { at.list.splice(at.index, 1); removed += 1; }
                next.blocks = next.blocks.filter(block => block.id !== found.block.id);
                changes.push(`removed “${found.block.name ?? found.block.id}”${removed > 1 ? ` (${removed} places)` : ''}`);
                break;
            }
            case 'addGroup': {
                if (locate(next.tree, node => node.type === 'group' && sameName(node.name, op.name))) return step(`a group called “${op.name}” already exists.`);
                const group = { type: 'group', id: `group-${newBlockId()}`, name: op.name, enabled: true, skipWhenEmpty: op.skipWhenEmpty, children: [] };
                if (op.placement) group.placement = op.placement;
                if (op.wrap) {
                    const open = { id: newBlockId(), name: `<${op.name}>`, role: 'system', content: `<${op.name}>` };
                    const close = { id: newBlockId(), name: `</${op.name}>`, role: 'system', content: `</${op.name}>` };
                    next.blocks.push(open, close);
                    group.wrap = { open: open.id, close: close.id };
                }
                const placed = insertNode(next, group, op.place);
                if (placed.error) return step(placed.error);
                changes.push(`added group “${op.name}”${op.wrap ? ` (wraps its content in <${op.name}>)` : ''}`);
                break;
            }
            case 'moveNode': {
                const found = findNode(next, op.node);
                if (found.error) return step(found.error);
                const target = findNode(next, op.place.into ?? op.place.before ?? op.place.after);
                if (target.error) return step(target.error);
                if (target.node === found.node || (found.node.type === 'group' && locate(found.node.children ?? [], node => node === target.node))) return step('a node cannot be moved into itself.');
                found.location.list.splice(found.location.index, 1);
                const placed = insertNode(next, found.node, op.place);
                if (placed.error) return step(placed.error);
                changes.push(`moved “${op.node}” ${op.place.into ? `into “${op.place.into}”` : op.place.before ? `before “${op.place.before}”` : `after “${op.place.after}”`}`);
                break;
            }
            case 'setEnabled': {
                const found = findNode(next, op.node);
                if (found.error) return step(found.error);
                found.node.enabled = op.enabled;
                changes.push(`${op.enabled ? 'switched on' : 'switched off'} “${op.node}”`);
                break;
            }
            case 'removeNode': {
                const found = findNode(next, op.node);
                if (found.error) return step(found.error);
                const { node, location } = found;
                if (node.type === 'item') {
                    const block = next.blocks.find(item => item.id === node.block);
                    if (block?.marker) return step('a marker cannot be removed (switch it off with setEnabled instead).');
                    location.list.splice(location.index, 1);
                    changes.push(`took “${op.node}” out of the order (the block itself stays in the library)`);
                } else if (node.type === 'group') {
                    const inside = op.withChildren ? [] : (node.children ?? []);
                    location.list.splice(location.index, 1, ...inside);
                    if (node.wrap) next.blocks = next.blocks.filter(block => block.id !== node.wrap.open && block.id !== node.wrap.close);
                    changes.push(`removed group “${op.node}”${inside.length ? ` (its ${inside.length} item${inside.length === 1 ? '' : 's'} stay in its place)` : ''}`);
                } else {
                    location.list.splice(location.index, 1);
                    changes.push(`removed “${op.node}”`);
                }
                break;
            }
            case 'setCondition': {
                const found = findNode(next, op.node);
                if (found.error) return step(found.error);
                if (op.condition === null) delete found.node.condition; else found.node.condition = op.condition;
                changes.push(op.condition === null ? `“${op.node}” is always sent` : `“${op.node}” is sent only when ${describeCondition(op.condition)}`);
                break;
            }
            case 'placeModule': {
                const found = locate(next.tree, node => node.type === 'inject' && (node.contribution === op.contribution || sameName(node.name, op.contribution)));
                if (!found) return step(`there is no module row “${op.contribution}” in this preset (the module must be on and have published its place).`);
                if (op.depth !== undefined) {
                    found.node.placement = { mode: 'depth', depth: op.depth, order: op.order };
                    delete found.node.atHistoryStart;
                    changes.push(`module “${found.node.name}” goes ${op.depth === 0 ? 'after the last message (depth 0)' : `${op.depth} messages from the end`}`);
                } else {
                    const target = findNode(next, op.place.into ?? op.place.before ?? op.place.after);
                    if (target.error) return step(target.error);
                    found.list.splice(found.index, 1);
                    delete found.node.placement;
                    if (op.atHistoryStart) found.node.atHistoryStart = true; else delete found.node.atHistoryStart;
                    const placed = insertNode(next, found.node, op.place);
                    if (placed.error) return step(placed.error);
                    changes.push(`module “${found.node.name}” moved ${op.place.into ? `into “${op.place.into}”` : op.place.before ? `before “${op.place.before}”` : `after “${op.place.after}”`}`);
                }
                break;
            }
            case 'addRule': {
                next.rules = next.rules ?? [];
                if (next.rules.some(rule => sameName(rule.name, op.rule.name))) return step(`a text rule called “${op.rule.name}” already exists.`);
                next.rules.push(op.rule);
                changes.push(`added text rule “${op.rule.name}”`);
                break;
            }
            case 'removeRule': {
                const rules = next.rules ?? [];
                const rule = rules.find(item => item.id === op.rule || sameName(item.name, op.rule));
                if (!rule) return step(`there is no text rule “${op.rule}”.`);
                next.rules = rules.filter(item => item !== rule);
                changes.push(`removed text rule “${rule.name}”`);
                break;
            }
            case 'setCot': {
                next.cot = { ...normalizeCot(next.cot), ...op.patch };
                changes.push(`Guided CoT: ${Object.entries(op.patch).map(([key, value]) => `${key} ${typeof value === 'object' ? 'set' : value}`).join(', ')}`);
                break;
            }
            case 'addCotStep': {
                next.cot = normalizeCot(next.cot);
                const id = newBlockId();
                next.blocks.push({ id, role: 'user', ...op.fields });
                next.cot.steps = [...next.cot.steps, { type: 'item', block: id, enabled: true }];
                changedBlocks.add(id);
                changes.push(`added Guided CoT step “${op.fields.name}”`);
                break;
            }
            case 'removeCotStep': {
                next.cot = normalizeCot(next.cot);
                const at = next.cot.steps.findIndex(step => nodeLabel(step, next.blocks).toLowerCase() === String(op.step).trim().toLowerCase());
                if (at < 0) return step(`there is no Guided CoT step “${op.step}”.`);
                const [gone] = next.cot.steps.splice(at, 1);
                if (gone.type === 'item') next.blocks = next.blocks.filter(block => block.id !== gone.block);
                changes.push(`removed Guided CoT step “${op.step}”`);
                break;
            }
            default:
                return step('unknown operation.');
        }
    }
    return { ok: true, preset: next, changes, changedBlocks };
}

/** Пустой, но рабочий пресет: маркеры в порядке ST (карточка, мир, примеры, история) — без маркера истории запрос не собрать. Тексты и порядок дальше решает гид. */
export function createStarterPreset(name) {
    const preset = createEmptyPreset(name);
    const markers = [['charDescription', 'Char Description'], ['charPersonality', 'Char Personality'], ['scenario', 'Scenario'], ['personaDescription', 'Persona Description'], ['worldInfoBefore', 'World Info (before)'], ['worldInfoAfter', 'World Info (after)'], ['dialogueExamples', 'Chat Examples'], ['chatHistory', 'Chat History']];
    for (const [id, label] of markers) {
        preset.blocks.push({ id, name: label, marker: true, role: 'system' });
        preset.tree.push({ type: 'item', block: id, enabled: true });
    }
    return preset;
}

/* ----------------------------------------------------------------------------------------------------------------------------------------------- */
/* Показ                                                                                                                                             */

const OPS_TEXT = { '<': 'is less than', '>': 'is more than', '=': 'is', '!=': 'is not', '<=': 'is at most', '>=': 'is at least', contains: 'contains' };

/** Условие обычными словами — для вида пресета и для итога правки. */
export function describeCondition(condition) {
    if (!condition) return 'always';
    switch (condition.type) {
        case 'all': return `(${(condition.items ?? []).map(describeCondition).join(' AND ')})`;
        case 'any': return `(${(condition.items ?? []).map(describeCondition).join(' OR ')})`;
        case 'not': return `NOT ${describeCondition(condition.item)}`;
        case 'keyword': return `the last ${condition.scan ?? 3} messages ${condition.source === 'user' ? 'from the user' : condition.source === 'char' ? 'from the character' : 'by anyone'} mention ${(condition.words ?? []).map(word => `"${word}"`).join(' or ')}`;
        case 'messageLength': return `the last ${condition.source === 'lastChar' ? 'character' : 'user'} message length ${OPS_TEXT[condition.op] ?? 'is'} ${condition.value}`;
        case 'tracker': return `tracker ${condition.trackerId}.${condition.field} ${OPS_TEXT[condition.op] ?? 'is'} ${condition.value}`;
        case 'variable': return `variable ${condition.name} ${OPS_TEXT[condition.op] ?? 'is'} ${condition.value}`;
        case 'chance': return `${condition.percent ?? 100}% chance`;
        case 'everyN': return `every ${condition.n}th message`;
        case 'cooldown': return `not within ${condition.turns ?? 1} messages of the last time (${condition.key})`;
        case 'jev': return `Jev answers "${condition.question}" with at least ${condition.minChance ?? 70}%`;
        default: return `plugin "${condition.type}"`;
    }
}

const capText = (label, value) => {
    if (!value) return `${label}: (empty)`;
    if (value.length <= VIEW_CAP_CHARS) return `${label} (${value.length} chars):\n${value}`;
    // Как у карточек: без метки модель заменит обрезанное целиком и сотрёт невидимый хвост.
    return `${label} (TRUNCATED — you see ${VIEW_CAP_CHARS} of ${value.length} chars; do NOT replace this text as a whole):\n${value.slice(0, VIEW_CAP_CHARS)}…`;
};

/** Пресет целиком для промпта гида: параметры, дерево порядка с именами и id, полный текст блоков, правила, CoT. */
export function buildPresetView(record, { isActive = false } = {}) {
    const preset = record.preset;
    const blocks = preset.blocks ?? [];
    const lines = [`Prompt Manager preset “${record.name}” — id ${record.id}${isActive ? ' (the ACTIVE preset: it is what is sent to the model now)' : ''}, ${blocks.length} blocks, ~${Math.ceil((record.size ?? JSON.stringify(preset).length) / 4)} tokens as stored`];
    lines.push(`Generation settings: ${Object.entries(preset.params ?? {}).filter(([key]) => PARAM_KEYS.includes(key)).map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`).join(', ') || '(none)'}`);
    lines.push('Order (what is sent, top to bottom; [x] on, [ ] off):');
    const shown = new Set();
    const walk = (nodes, depth) => {
        for (const node of nodes) {
            const pad = '  '.repeat(depth + 1);
            const flag = node.enabled === false ? '[ ]' : '[x]';
            const condition = node.condition ? ` — only when ${describeCondition(node.condition)}` : '';
            if (node.type === 'group') {
                lines.push(`${pad}${flag} GROUP “${node.name}”${node.wrap ? ` <${node.name}>…</${node.name}>` : ''}${node.placement?.mode === 'depth' ? ` — inside the chat, depth ${node.placement.depth}, order ${node.placement.order}` : ''}${node.skipWhenEmpty === false ? ' — tags sent even when empty' : ''}${condition}`);
                walk(node.children ?? [], depth + 1);
            } else if (node.type === 'item') {
                const block = blocks.find(item => item.id === node.block);
                if (!block) { lines.push(`${pad}${flag} (missing block ${node.block})`); continue; }
                shown.add(block.id);
                const where = block.position === 'depth' ? `, depth ${block.depth ?? 4}, order ${block.order ?? 100}` : '';
                lines.push(`${pad}${flag} ${block.marker ? `MARKER “${block.name ?? block.id}” (filled by the assembler)` : `BLOCK “${block.name ?? block.id}” (id ${block.id}, ${block.role ?? 'system'}${where}${block.trimPriority !== undefined ? `, trim priority ${block.trimPriority}` : ''}, ${(block.content ?? '').length} chars)`}${condition}`);
            } else if (node.type === 'inject') {
                const place = node.placement?.mode === 'depth' ? `inside the chat, depth ${node.placement.depth}, order ${node.placement.order}` : node.atHistoryStart ? 'at the start of the history' : 'in order';
                lines.push(`${pad}${flag} MODULE ROW “${node.name ?? node.contribution}” (contribution ${node.contribution}) — ${place}${condition}`);
            } else if (isDivider(node)) lines.push(`${pad}${node.edge === 'end' ? '— divider end' : `— divider begin “${node.name ?? ''}”${condition}`}`);
            else if (node.type === 'note') lines.push(`${pad}(note: ${node.text})`);
            else if (node.type === 'choice') lines.push(`${pad}${flag} CHOICE “${node.name ?? ''}” — one of ${(node.options ?? []).length}`);
        }
    };
    walk(preset.tree ?? [], 0);
    const unused = blocks.filter(block => !shown.has(block.id) && !block.marker && !isWrapBlock(preset, block.id) && !isCotBlock(preset, block.id));
    if (unused.length) lines.push(`Blocks in the library but not in the order: ${unused.map(block => `“${block.name}”`).join(', ')}`);
    lines.push('', 'Texts of the blocks:');
    for (const block of blocks) if (!block.marker && (block.content ?? '') && !isWrapBlock(preset, block.id)) lines.push(`### ${block.name ?? block.id}`, capText('text', block.content), '');
    const cot = normalizeCot(preset.cot);
    lines.push(`Guided CoT: ${cot.enabled ? `ON, mode ${cot.mode}, ${cot.steps.length} step${cot.steps.length === 1 ? '' : 's'}${cot.condition ? `, when ${describeCondition(cot.condition)}` : ''}` : 'off'}${cot.steps.length ? ` — steps: ${cot.steps.map(step => `“${nodeLabel(step, blocks)}”`).join(', ')}` : ''}`);
    for (const step of cot.steps) { const block = blocks.find(item => item.id === step.block); if (block?.content) lines.push(`### CoT step ${block.name}`, capText('text', block.content), ''); }
    const rules = preset.rules ?? [];
    lines.push(rules.length ? `Text rules (${rules.length}):\n${rules.map(rule => `  ${rule.enabled === false ? '[ ]' : '[x]'} “${rule.name}” — ${rule.find?.kind}: ${JSON.stringify(rule.find)} → ${JSON.stringify(rule.replace ?? '')}${rule.scope && Object.keys(rule.scope).length ? ` scope ${JSON.stringify(rule.scope)}` : ''}`).join('\n')}` : 'Text rules: (none)');
    return lines.join('\n');
}

const isWrapBlock = (preset, id) => Boolean(locate(preset.tree ?? [], node => node.type === 'group' && (node.wrap?.open === id || node.wrap?.close === id)));
const isCotBlock = (preset, id) => (preset.cot?.steps ?? []).some(step => step.block === id);

/** Карточка-предложение: `{ ok, title, lines }` либо `{ ok: false, error }` — по той же проверке, что и при записи. */
export function describePreset(action, params = {}) {
    if (action === 'preset.restore') {
        if (!params.id) return fail('Which preset? Its id is needed.');
        if (!params.key) return fail('Which version? Its key from the list is needed.');
        return { ok: true, danger: true, title: 'Restore the preset to an earlier version', lines: ['The preset goes back to that version. The state right now is saved first, so this can be undone too.'] };
    }
    if (action === 'preset.duplicate') {
        if (!params.id) return fail('Which preset? Its id is needed.');
        return { ok: true, title: `Copy the preset${params.name ? ` as “${params.name}”` : ''}`, lines: ['A separate copy; the original stays as it is.'] };
    }
    if (action === 'preset.override') {
        if (!OVERRIDE_SCOPES.includes(params.scope) || !params.key) return fail('An override needs "scope" (model, character or chat), "key" (the model, character or chat id) and "params".');
        const made = params.params && Object.keys(params.params).length ? normalizePresetParams(params.params) : { ok: true, value: {} };
        if (!made.ok) return made;
        return { ok: true, title: `Generation settings for ${params.scope} “${params.key}”`, lines: Object.keys(made.value).length ? Object.entries(made.value).map(([key, value]) => `${key}: ${value}`) : ['The override is cleared.'] };
    }
    const lines = [];
    if (action === 'preset.create' && !cleanText(params.name, MAX_NAME)) return fail('A new preset needs a name.');
    if (action === 'preset.update' && !params.id) return fail('Which preset? Its id is needed.');
    if (params.params !== undefined) {
        const made = normalizePresetParams(params.params);
        if (!made.ok) return made;
        lines.push(`Generation settings: ${Object.entries(made.value).map(([key, value]) => `${key} ${value}`).join(', ')}`);
    }
    if (params.ops !== undefined) {
        const made = normalizePresetOps(params.ops);
        if (!made.ok) return made;
        lines.push(`${made.value.length} change${made.value.length === 1 ? '' : 's'}: ${made.value.map(op => op.op).join(', ')}`);
    }
    if (action === 'preset.update' && !lines.length) return fail('Nothing to change in the preset.');
    return { ok: true, title: action === 'preset.create' ? `New preset “${cleanText(params.name, MAX_NAME)}”` : 'Change the preset', lines };
}

/* ----------------------------------------------------------------------------------------------------------------------------------------------- */
/* Проверка формы пресета                                                                                                                            */

const wordsOf = text => String(text ?? '');

function collectBlockTexts(preset) {
    return (preset.blocks ?? []).filter(block => !block.marker && typeof block.content === 'string' && block.content.trim()).map(block => ({ id: block.id, name: block.name ?? block.id, text: block.content }));
}

/**
 * Находки по пресету: `[{ where, problem }]`. `changed` — id блоков, тронутых этой правкой (опечатки и дубли ищутся там, а не по всему чужому тексту);
 * `enabledModules` — id включённых Модулей (нет списка — проверка зависимостей пропускается). Ловит форму, а не смысл.
 */
export function computePresetProblems(preset, { changed = null, enabledModules = null } = {}) {
    const problems = [];
    const seen = new Set();
    const report = (where, problem) => { const key = `${where}|${problem}`; if (!seen.has(key)) { seen.add(key); problems.push({ where, problem }); } };
    const texts = collectBlockTexts(preset);
    const touched = block => !changed || changed.has(block.id);

    // Опечатки — только в тронутых блоках: чужой текст без просьбы не «исправляется».
    for (const block of texts.filter(touched)) {
        for (const [wrong, right] of COMMON_TYPOS) if (new RegExp(`\\b${wrong}\\b`, 'i').test(block.text)) report(block.name, `typo “${wrong}” (${right})`);
    }

    // Парные теги: у группы-обёртки оба тега на месте и называются одинаково; одиночный <тег> без закрывающего.
    const blocks = preset.blocks ?? [];
    for (const { node } of flattenNodes(preset.tree ?? [])) {
        if (node.type !== 'group' || !node.wrap) continue;
        const open = blocks.find(block => block.id === node.wrap.open);
        const close = blocks.find(block => block.id === node.wrap.close);
        if (!open || !close) { report(`group “${node.name}”`, 'one of its wrapper tags is missing'); continue; }
        const openTag = /^<([^<>/\n]+)>$/.exec((open.content ?? '').trim())?.[1];
        const closeTag = /^<\/([^<>\n]+)>$/.exec((close.content ?? '').trim())?.[1];
        if (!openTag || !closeTag || openTag !== closeTag) report(`group “${node.name}”`, `wrapper tags do not match (“${(open.content ?? '').trim()}” … “${(close.content ?? '').trim()}”)`);
    }
    for (const list of listsOf(preset.tree ?? [])) {
        const stack = [];
        for (const node of list) {
            const block = node.type === 'item' ? blocks.find(item => item.id === node.block) : null;
            // Открывающий тег — первая строка блока (под ним может стоять пояснение, как у `<chat examples>`), закрывающий — последняя.
            const lines = (block?.content ?? '').trim().split('\n');
            const open = /^<([^<>/\n]{1,60})>\s*$/.exec(lines[0])?.[1];
            const close = lines.length === 1 ? /^<\/([^<>\n]{1,60})>\s*$/.exec(lines[0])?.[1] : undefined;
            if (block && !block.marker && open) stack.push(open);
            else if (block && !block.marker && close) { const at = stack.lastIndexOf(close); if (at < 0) report(`block “${block.name}”`, `closing tag </${close}> has no opening tag before it`); else stack.splice(at); }
        }
        for (const tag of stack) report('the order', `tag <${tag}> is opened and never closed`);
    }

    // Ссылки «Step N» / «Step N.M» на несуществующие шаги списка «N - Название».
    const sections = new Map();
    for (const block of texts) {
        let section = null;
        for (const line of block.text.split('\n')) {
            const heading = /^\s*\*?\s*(?:Step\s+)?(\d+)\s*[-–—]\s*\S/i.exec(line);
            if (heading) { section = Number(heading[1]); if (!sections.has(section)) sections.set(section, new Set()); continue; }
            const item = section === null ? null : /^\s*(?:(\d+)\.)?(\d+)[.)]\s/.exec(line);
            if (item && section !== null && (!item[1] || Number(item[1]) === section)) sections.get(section).add(Number(item[2]));
        }
    }
    if (sections.size) {
        for (const block of texts.filter(touched)) {
            for (const [, major, minor] of wordsOf(block.text).matchAll(/\bStep\s+(\d+)(?:\.(\d+))?/g)) {
                const items = sections.get(Number(major));
                if (!items) report(block.name, `refers to Step ${major}, but the checklist has no step ${major}`);
                else if (minor !== undefined && !items.has(Number(minor))) report(block.name, `refers to Step ${major}.${minor}, but step ${major} has no item ${minor}`);
            }
        }
    }

    // Один подзаголовок в двух блоках — два правила под одним именем (в трёх и больше — это общий приём пресета, не повтор).
    const headingBlocks = new Map();
    for (const block of texts) {
        for (const match of block.text.matchAll(/^\s*\*\*([^*\n]{3,60})\*\*\s*$/gm)) {
            const heading = match[1].trim().replace(/\s+/g, ' ').toLowerCase();
            if (/^(what|how|why|who)\b/.test(heading)) continue;
            headingBlocks.set(heading, [...new Set([...(headingBlocks.get(heading) ?? []), block.id])]);
        }
    }
    for (const [heading, ids] of headingBlocks) {
        if (ids.length !== 2 || !ids.some(id => !changed || changed.has(id))) continue;
        const names = ids.map(id => texts.find(block => block.id === id)?.name);
        report(names.join(' and '), `the same subheading “${heading}” in two blocks (two rules under one name — rename one, unless it is one rule repeated on purpose)`);
    }

    // Текст, который зовёт Модуль, выключенный сейчас.
    if (Array.isArray(enabledModules)) {
        for (const block of texts.filter(touched)) {
            for (const mention of MODULE_MENTIONS) if (mention.pattern.test(block.text) && !enabledModules.includes(mention.module)) report(block.name, `mentions ${mention.title}, but the ${mention.title} module is off`);
        }
    }

    // Правило кэша: всё, что меняется между ходами (вклад модуля, блок с условием, случайный макрос), стоит ПОСЛЕ истории или внутри неё на малой глубине.
    // Исключение одно — саммари: они перед историей. Что перед историей и меняется, ломает кэш префикса на всей истории чата.
    const positions = walkWithHistoryPosition(preset.tree ?? [], blocks);
    if (positions.hasHistory) {
        for (const { node, before } of positions.list) {
            if (!before || node.enabled === false) continue;
            if (node.type === 'inject' && VOLATILE_CONTRIBUTIONS.includes(node.contribution) && node.placement?.mode !== 'depth') {
                report(`module row “${node.name ?? node.contribution}”`, 'changes as the chat goes on but stands before the chat history, so the provider cache restarts before the whole history (put it inside the chat at a small depth, 0 is after the last message)');
            }
            if ((node.type === 'item' || node.type === 'group') && node.condition) {
                report(`${node.type === 'group' ? 'group' : 'block'} “${nodeLabel(node, blocks)}”`, 'has a condition but stands before the chat history: whenever it appears or disappears the cache restarts before the whole history (move it after the history)');
            }
            if (node.type === 'item' && RANDOM_MACRO.test(blocks.find(block => block.id === node.block)?.content ?? '')) {
                report(`block “${nodeLabel(node, blocks)}”`, 'uses a random macro before the chat history: the text differs every request and the cache restarts before the whole history (move it after the history, or turn on "Freeze random")');
            }
        }
        for (const { node, before } of positions.list) {
            if (before || node.type !== 'inject' || !MUST_STAND_BEFORE_HISTORY.includes(node.contribution) || node.enabled === false) continue;
            report(`module row “${node.name ?? node.contribution}”`, node.placement?.mode === 'depth'
                ? 'summaries replace the start of the chat and belong BEFORE the chat history, not inside the chat at a depth'
                : 'summaries belong BEFORE the chat history (they replace the start of the chat), but this row stands after it');
        }
    }
    return problems;
}

/**
 * Узлы в порядке отправки с признаком «стоит перед историей чата»: до маркера истории и не на глубине (узел на глубине лежит внутри чата, а не перед ним).
 * Вклад модуля «в начале истории» (`atHistoryStart`) стоит перед историей, где бы он ни лежал в дереве.
 */
function walkWithHistoryPosition(tree, blocks) {
    const list = [];
    let seen = false;
    const visit = (nodes, inDepthGroup) => {
        for (const node of nodes) {
            const block = node.type === 'item' ? blocks.find(item => item.id === node.block) : null;
            const isHistory = Boolean(block?.marker) && node.block === 'chatHistory';
            const depth = inDepthGroup || node.placement?.mode === 'depth' || block?.position === 'depth';
            list.push({ node, before: !depth && (node.type === 'inject' && node.atHistoryStart ? true : !seen) });
            if (isHistory) seen = true;
            if (node.type === 'group') visit(node.children ?? [], depth);
        }
    };
    visit(tree, false);
    return { list, hasHistory: seen };
}

function* flattenNodes(nodes, parent = null) {
    for (const node of nodes) {
        yield { node, parent };
        if (node.type === 'group') yield* flattenNodes(node.children ?? [], node);
        if (node.type === 'choice') for (const option of node.options ?? []) yield* flattenNodes(option.children ?? [], node);
    }
}

function* listsOf(nodes) {
    yield nodes;
    for (const node of nodes) {
        if (node.type === 'group') yield* listsOf(node.children ?? []);
        if (node.type === 'choice') for (const option of node.options ?? []) yield* listsOf(option.children ?? []);
    }
}

/** Строка `[fix]` для плана гида по находкам (не больше `max` мест), пусто — если находок нет. */
export function buildPresetFixLine(problems, max = 6) {
    if (!problems.length) return '';
    return `[fix] The engine found these in the preset (send ONE small preset.update with only the edits needed; leave anything the owner wrote on purpose): ${problems.slice(0, max).map(item => `${item.where}: ${item.problem}`).join('; ')}${problems.length > max ? `; and ${problems.length - max} more` : ''}.`;
}
