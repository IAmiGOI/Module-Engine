/**
 * Знания персонажей — секция Knowledge дата-банка: что персонаж узнал по ходу этой истории. Ведёт её сам директор
 * инструментом `character_knowledge` (решение владельца): только дописыванием — новое знание добавляется, записанное
 * можно расширить подробностями (update), устаревшее помечается, а не стирается (персонаж помнит, что раньше думал иначе). Хранится только в чате: в другом чате
 * персонаж этого не знает. Для персонажа пользователя знания не ведутся (решение владельца).
 *
 * Банк в начале контекста остаётся статичным ради кеша, а эта секция рисуется отдельно — в изменяемой части.
 * Чистая Библиотека: состояние приходит и уходит значением.
 */
const text = value => String(value ?? '').trim();
export const knowledgeKey = name => text(name).toLowerCase();
export const KNOWLEDGE_SOURCES = Object.freeze(['saw', 'heard', 'told', 'read', 'worked out']);

export function normalizeKnowledge(value) {
    const out = {};
    for (const [key, record] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
        if (!record || !Array.isArray(record.items) || !text(record.name)) continue;
        out[key] = { name: text(record.name), items: record.items.filter(item => item && text(item.id) && text(item.fact)) };
    }
    return out;
}

/**
 * @returns {{ ok: true, state: object, item: object } | { ok: false, error: string }}
 */
export function applyKnowledge(state, args = {}, { minutes = null, at = Date.now(), rid = Math.random } = {}) {
    const name = text(args.character);
    if (!name) return { ok: false, error: 'character_knowledge needs "character".' };
    const key = knowledgeKey(name);
    const next = { ...normalizeKnowledge(state) };
    const record = next[key] ? { ...next[key], items: [...next[key].items] } : { name, items: [] };
    const newId = () => `k_${Math.floor(rid() * 36 ** 6).toString(36).padStart(6, '0')}`;
    const source = KNOWLEDGE_SOURCES.includes(text(args.source)) ? text(args.source) : 'worked out';
    const fresh = fact => ({ id: newId(), fact, source, from: text(args.from), minutes, at, status: 'known' });
    const find = () => record.items.findIndex(item => item.id === text(args.id) && item.status === 'known');

    if (args.op === 'add') {
        const fact = text(args.fact);
        if (!fact) return { ok: false, error: 'To add knowledge, give the "fact" the character learned.' };
        const item = fresh(fact);
        record.items.push(item);
        next[key] = record;
        return { ok: true, state: next, item };
    }
    if (args.op === 'revise') {
        const fact = text(args.fact);
        const index = find();
        if (index < 0) return { ok: false, error: `There is no current knowledge "${text(args.id)}" for ${name}. Use the ids shown in WHAT CHARACTERS KNOW.` };
        if (!fact) return { ok: false, error: 'To revise knowledge, give the new "fact" the character now believes.' };
        const item = { ...fresh(fact), revises: record.items[index].id };
        record.items[index] = { ...record.items[index], status: 'outdated', supersededBy: item.id };
        record.items.push(item);
        next[key] = record;
        return { ok: true, state: next, item };
    }
    if (args.op === 'update') {
        // Расширить уже записанное знание новыми подробностями того же факта — без пометки «раньше думал иначе».
        const addition = text(args.fact);
        const index = find();
        if (index < 0) return { ok: false, error: `There is no current knowledge "${text(args.id)}" for ${name}. Use the ids shown in WHAT CHARACTERS KNOW.` };
        if (!addition) return { ok: false, error: 'To update knowledge, give the new detail in "fact".' };
        const previous = record.items[index];
        const item = {
            ...previous,
            fact: `${previous.fact.replace(/[.\s]+$/, '')}; ${addition}`,
            updates: [...(previous.updates ?? []), { fact: addition, source, from: text(args.from), minutes, at }],
        };
        record.items[index] = item;
        next[key] = record;
        return { ok: true, state: next, item };
    }
    if (args.op === 'forget') {
        const index = find();
        if (index < 0) return { ok: false, error: `There is no current knowledge "${text(args.id)}" for ${name}.` };
        record.items[index] = { ...record.items[index], status: 'forgotten', forgottenAt: at };
        next[key] = record;
        return { ok: true, state: next, item: record.items[index] };
    }
    return { ok: false, error: 'character_knowledge needs op "add", "update", "revise" or "forget".' };
}

function itemLine(item, byId) {
    const how = [item.source, item.from ? `from ${item.from}` : ''].filter(Boolean).join(' ');
    const before = item.revises && byId.get(item.revises) ? ` (used to believe: ${byId.get(item.revises).fact})` : '';
    return `- [${item.id}] ${item.fact}${how ? ` — ${how}` : ''}${before}`;
}

/** Секция знаний. `names` — только эти персонажи (прозаику — активные), `null` — все (директору). */
export function renderKnowledge(state, { names = null } = {}) {
    const wanted = Array.isArray(names) ? new Set(names.map(knowledgeKey)) : null;
    const blocks = [];
    for (const [key, record] of Object.entries(normalizeKnowledge(state))) {
        if (wanted && !wanted.has(key)) continue;
        const byId = new Map(record.items.map(item => [item.id, item]));
        const known = record.items.filter(item => item.status === 'known');
        if (known.length) blocks.push(`### ${record.name}\n${known.map(item => itemLine(item, byId)).join('\n')}`);
    }
    return blocks.length ? `WHAT CHARACTERS KNOW (learned in this story; a character acts only on their bank and this knowledge):\n\n${blocks.join('\n\n')}` : '';
}
