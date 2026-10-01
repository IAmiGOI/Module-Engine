/**
 * Модель визуального конструктора условий (PROMPT_MANAGER_PLAN.md, раздел 0: «ОЧЕНЬ наглядно, без кода»).
 * Чистые данные: описания типов правил, человеческая фраза для правила, операции над деревом условия.
 * Само вычисление — libraries/core/pm-conditions.js. Путь правила — массив индексов внутри `items`.
 */
const OPS = [['<', 'is less than'], ['>', 'is more than'], ['=', 'equals'], ['!=', 'does not equal'], ['contains', 'contains']];
const SOURCES = [['any', 'anyone'], ['user', 'you'], ['char', 'the character']];

/** Тип правила → подпись в списке, поля формы и значения по умолчанию. */
export const LEAF_TYPES = {
    keyword: { label: 'Keywords in the chat', defaults: { words: [], scan: 3, source: 'any' }, fields: [
        { key: 'words', label: 'Words or phrases (comma separated; /regex/ works too)', kind: 'words' },
        { key: 'scan', label: 'Look at the last N messages', kind: 'number', min: 1, max: 50 },
        { key: 'source', label: 'Written by', kind: 'select', options: SOURCES },
    ] },
    messageLength: { label: 'Length of the last message', defaults: { source: 'lastUser', op: '>', value: 200 }, fields: [
        { key: 'source', label: 'Message', kind: 'select', options: [['lastUser', 'your last message'], ['lastChar', 'the last reply']] },
        { key: 'op', label: 'Length', kind: 'select', options: OPS.slice(0, 3) },
        { key: 'value', label: 'Characters', kind: 'number', min: 0, max: 100000 },
    ] },
    tracker: { label: 'Tracker value', defaults: { trackerId: '', field: '', op: '<', value: 50 }, fields: [
        { key: 'trackerId', label: 'Tracker', kind: 'text' }, { key: 'field', label: 'Field', kind: 'text' },
        { key: 'op', label: 'Value', kind: 'select', options: OPS }, { key: 'value', label: 'Compare with', kind: 'text' },
    ] },
    variable: { label: 'Prompt variable', defaults: { name: '', op: '=', value: '' }, fields: [
        { key: 'name', label: 'Variable name', kind: 'text' }, { key: 'op', label: 'Value', kind: 'select', options: OPS }, { key: 'value', label: 'Compare with', kind: 'text' },
    ] },
    jev: { label: 'Jev answers a question', defaults: { question: '', minChance: 70, user: 1, assistant: 1, connection: '' }, fields: [
        { key: 'question', label: 'Statement (Jev says how likely it is true). You may refer to `player_message`, `latest_turn` and `history`', kind: 'textarea' },
        { key: 'minChance', label: 'Send when the chance is at least, %', kind: 'number', min: 0, max: 100 },
        { key: 'user', label: 'Your messages Jev reads', kind: 'number', min: 0, max: 50 },
        { key: 'assistant', label: 'Replies Jev reads', kind: 'number', min: 0, max: 50 },
        { key: 'connection', label: 'Classifier connection (its name in the Classifiers card; empty = the first one)', kind: 'text' },
    ] },
    chance: { label: 'Random chance', defaults: { percent: 50 }, fields: [{ key: 'percent', label: 'Chance, %', kind: 'number', min: 0, max: 100 }] },
    everyN: { label: 'Every N-th message', defaults: { n: 5 }, fields: [{ key: 'n', label: 'Every N messages', kind: 'number', min: 1, max: 1000 }] },
    cooldown: { label: 'Cooldown after firing', defaults: { key: 'cooldown', turns: 5 }, fields: [
        { key: 'key', label: 'Name of this cooldown', kind: 'text' }, { key: 'turns', label: 'Silent for N messages', kind: 'number', min: 1, max: 1000 },
    ] },
};

const label = (options, value) => options.find(([v]) => v === value)?.[1] ?? value;

/** Фраза для правила или группы — то, что пользователь читает вместо кода. */
export function describeCondition(cond) {
    if (!cond) return 'always';
    if (cond.type === 'all' || cond.type === 'any') {
        const parts = (cond.items ?? []).map(describeCondition);
        if (!parts.length) return 'always';
        return parts.length === 1 ? parts[0] : `(${parts.join(cond.type === 'all' ? ' AND ' : ' OR ')})`;
    }
    if (cond.type === 'not') return `NOT ${describeCondition(cond.item)}`;
    switch (cond.type) {
        case 'keyword': return `the last ${cond.scan ?? 3} messages by ${label(SOURCES, cond.source ?? 'any')} mention ${(cond.words ?? []).map(w => `"${w}"`).join(' or ') || '…'}`;
        case 'messageLength': return `${label(LEAF_TYPES.messageLength.fields[0].options, cond.source)} length ${label(OPS, cond.op)} ${cond.value}`;
        case 'tracker': return `tracker ${cond.trackerId || '…'}.${cond.field || '…'} ${label(OPS, cond.op)} ${cond.value}`;
        case 'variable': return `variable ${cond.name || '…'} ${label(OPS, cond.op)} ${cond.value}`;
        case 'jev': return `Jev finds “${cond.question || '…'}” at least ${cond.minChance ?? 70}% likely (reads ${cond.user ?? 1} of your messages and ${cond.assistant ?? 1} replies)`;
        case 'chance': return `${cond.percent}% chance`;
        case 'everyN': return `every ${cond.n}th message`;
        case 'cooldown': return `not within ${cond.turns} messages of the last time`;
        default: return `plugin "${cond.type}"`;
    }
}

export const newLeaf = type => ({ type, ...structuredClone(LEAF_TYPES[type]?.defaults ?? {}) });
export const newGroup = (kind = 'all') => ({ type: kind, items: [] });

/** Корень условия всегда группа: пустое условие — «все из пустого списка» = всегда. */
export const ensureRoot = cond => (cond && (cond.type === 'all' || cond.type === 'any') ? cond : cond ? { type: 'all', items: [cond] } : newGroup('all'));

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
