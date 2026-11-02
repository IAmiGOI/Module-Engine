/**
 * Условия блоков и групп в разделах промптов директора и прозаика.
 * Перенесено из `pm-conditions.js` только то, что имеет источник данных без
 * Ядра Prompt Manager. Условие — дерево, которое строит конструктор без
 * кода; здесь только вычисление.
 *
 *   { type: 'all' | 'any', items: [...] }  · { type: 'not', item }
 *   keyword        { words[], scan, source: 'any'|'user'|'char' }
 *   messageLength  { source: 'lastUser'|'lastChar', op, value }
 *   tracker        { trackerId, field, op, value }
 *   variable       { name, op, value }
 *   chance         { percent }
 *   everyN         { n }
 *   cooldown       { key, turns }
 *
 * facts: { messages (новые первыми, {role, text}), chatLength, vars (Map),
 *          tracker(id, field), random, timed }. `timed` меняется на месте:
 *          сработавший кулдаун записывает, до какого сообщения молчать.
 */
const OPS = {
    '<': (a, b) => a < b, '>': (a, b) => a > b, '=': (a, b) => a === b, '!=': (a, b) => a !== b,
    '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
    contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
};

function compare(actual, op, expected) {
    const compareFn = OPS[op] ?? OPS['='];
    const numeric = Number.isFinite(Number(actual)) && Number.isFinite(Number(expected)) && String(actual).trim() !== '';
    return numeric ? compareFn(Number(actual), Number(expected)) : compareFn(String(actual ?? ''), String(expected ?? ''));
}

function keywordHit(word, text) {
    const w = String(word ?? '').trim();
    if (!w) return false;
    const regex = /^\/(.+)\/([a-z]*)$/i.exec(w);
    if (regex) { try { return new RegExp(regex[1], regex[2] || 'i').test(text); } catch { return false; } }
    return text.toLowerCase().includes(w.toLowerCase());
}

const LEAVES = {
    keyword(leaf, facts) {
        const scan = leaf.scan ?? 3;
        const wanted = leaf.source === 'user' ? 'user' : leaf.source === 'char' ? 'assistant' : null;
        const text = facts.messages.filter(message => !wanted || message.role === wanted).slice(0, scan).map(message => message.text).join('\n');
        return (leaf.words ?? []).some(word => keywordHit(word, text));
    },
    messageLength(leaf, facts) {
        const role = leaf.source === 'lastChar' ? 'assistant' : 'user';
        const message = facts.messages.find(item => item.role === role);
        return compare((message?.text ?? '').length, leaf.op, leaf.value);
    },
    tracker: (leaf, facts) => compare(facts.tracker?.(leaf.trackerId, leaf.field), leaf.op, leaf.value),
    variable: (leaf, facts) => compare(facts.vars?.get(leaf.name), leaf.op, leaf.value),
    chance: (leaf, facts) => (facts.random ?? Math.random)() * 100 < (leaf.percent ?? 100),
    everyN: (leaf, facts) => leaf.n > 0 && facts.chatLength % leaf.n === 0,
    cooldown(leaf, facts) {
        const timed = facts.timed ?? {};
        const until = timed[leaf.key];
        if (until !== undefined && facts.chatLength < until) return false;
        timed[leaf.key] = facts.chatLength + (leaf.turns ?? 1);
        return true;
    },
};

/** Пустое или отсутствующее условие — истина, неизвестный тип — ложь. */
export function evaluateCondition(condition, facts) {
    if (!condition) return true;
    switch (condition.type) {
        case 'all': return (condition.items ?? []).every(item => evaluateCondition(item, facts));
        case 'any': return (condition.items ?? []).some(item => evaluateCondition(item, facts));
        case 'not': return !evaluateCondition(condition.item, facts);
        default: return LEAVES[condition.type] ? Boolean(LEAVES[condition.type](condition, facts)) : false;
    }
}

const SOURCES = [['any', 'anyone'], ['user', 'you'], ['char', 'the character']];
const OPS_LIST = [['<', 'is less than'], ['>', 'is greater than'], ['=', 'is'], ['!=', 'is not'], ['contains', 'contains']];

/** Описание типов для конструктора: подпись, значения по умолчанию, поля. Плагинов больше нет — список закрыт. */
export const LEAF_TYPES = {
    keyword: { label: 'Recent messages mention a word', defaults: { words: [], scan: 3, source: 'any' }, fields: [
        { key: 'words', label: 'Words or /regex/', kind: 'words' },
        { key: 'scan', label: 'How many recent messages to read', kind: 'number', min: 1, max: 50 },
        { key: 'source', label: 'Whose messages', kind: 'select', options: SOURCES },
    ] },
    messageLength: { label: 'A message is longer or shorter than', defaults: { source: 'lastUser', op: '>', value: 200 }, fields: [
        { key: 'source', label: 'Which message', kind: 'select', options: [['lastUser', 'your last message'], ['lastChar', 'the last reply']] },
        { key: 'op', label: 'Length', kind: 'select', options: OPS_LIST },
        { key: 'value', label: 'Characters', kind: 'number', min: 0, max: 100000 },
    ] },
    tracker: { label: 'A tracker value', defaults: { trackerId: '', field: '', op: '=', value: '' }, fields: [
        { key: 'trackerId', label: 'Tracker id', kind: 'text' },
        { key: 'field', label: 'Field name', kind: 'text' },
        { key: 'op', label: 'Comparison', kind: 'select', options: [...OPS_LIST] },
        { key: 'value', label: 'Value', kind: 'text' },
    ] },
    variable: { label: 'A macro variable', defaults: { name: '', op: '=', value: '' }, fields: [
        { key: 'name', label: 'Variable name', kind: 'text' },
        { key: 'op', label: 'Comparison', kind: 'select', options: [...OPS_LIST] },
        { key: 'value', label: 'Value', kind: 'text' },
    ] },
    chance: { label: 'Random chance', defaults: { percent: 50 }, fields: [{ key: 'percent', label: 'Chance, %', kind: 'number', min: 0, max: 100 }] },
    everyN: { label: 'Every N-th message', defaults: { n: 5 }, fields: [{ key: 'n', label: 'Every N messages', kind: 'number', min: 1, max: 1000 }] },
    cooldown: { label: 'Cooldown after firing', defaults: { key: 'cooldown', turns: 5 }, fields: [
        { key: 'key', label: 'Name of this cooldown', kind: 'text' },
        { key: 'turns', label: 'Silent for N messages', kind: 'number', min: 1, max: 1000 },
    ] },
};

const label = (options, value) => options.find(([optionValue]) => optionValue === value)?.[1] ?? value;

/** Фраза для правила или группы — то, что пользователь читает вместо кода. */
export function describeCondition(condition) {
    if (!condition) return 'always';
    if (condition.type === 'all' || condition.type === 'any') {
        const parts = (condition.items ?? []).map(describeCondition);
        if (!parts.length) return 'always';
        return parts.length === 1 ? parts[0] : `(${parts.join(condition.type === 'all' ? ' AND ' : ' OR ')})`;
    }
    if (condition.type === 'not') return `NOT ${describeCondition(condition.item)}`;
    switch (condition.type) {
        case 'keyword': return `the last ${condition.scan ?? 3} messages by ${label(SOURCES, condition.source ?? 'any')} mention ${(condition.words ?? []).map(word => `"${word}"`).join(' or ') || '…'}`;
        case 'messageLength': return `${label(LEAF_TYPES.messageLength.fields[0].options, condition.source)} length ${label(OPS_LIST, condition.op)} ${condition.value}`;
        case 'tracker': return `tracker ${condition.trackerId || '…'}.${condition.field || '…'} ${label(OPS_LIST, condition.op)} ${condition.value}`;
        case 'variable': return `variable ${condition.name || '…'} ${label(OPS_LIST, condition.op)} ${condition.value}`;
        case 'chance': return `${condition.percent}% chance`;
        case 'everyN': return `every ${condition.n}th message`;
        case 'cooldown': return `not within ${condition.turns} messages of the last time`;
        default: return 'unknown condition';
    }
}

export const newLeaf = type => ({ type, ...structuredClone(LEAF_TYPES[type]?.defaults ?? {}) });
export const newGroup = (kind = 'all') => ({ type: kind, items: [] });

/** Корень условия всегда группа: пустое условие — «все из пустого списка» = всегда. */
export const ensureRoot = condition => (condition && (condition.type === 'all' || condition.type === 'any') ? condition : condition ? { type: 'all', items: [condition] } : newGroup('all'));

function listAt(root, path) {
    let node = root;
    for (const index of path) node = node.items[index];
    return node;
}

export function updateAt(root, path, patch) {
    const next = structuredClone(root);
    Object.assign(path.length ? listAt(next, path) : next, patch);
    return next;
}

export function addTo(root, path, child) {
    const next = structuredClone(root);
    (path.length ? listAt(next, path) : next).items.push(child);
    return next;
}

export function removeAt(root, path) {
    const next = structuredClone(root);
    listAt(next, path.slice(0, -1).length ? path.slice(0, -1) : []).items.splice(path.at(-1), 1);
    return next;
}

/** Условие для сохранения: пустая группа означает «без условия». */
export const normalizeCondition = root => (!root || ((root.type === 'all' || root.type === 'any') && !(root.items ?? []).length) ? null : root);
