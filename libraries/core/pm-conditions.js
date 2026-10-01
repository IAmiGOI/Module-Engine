/**
 * Условия блоков и групп (PROMPT_MANAGER_PLAN.md, раздел 0 «Условия и триггеры»). Чистые данные:
 * условие — дерево, которое строит визуальный конструктор без кода; здесь только вычисление.
 *
 *   { type: 'all' | 'any', items: [...] }  · { type: 'not', item }
 *   keyword        { words[], scan (сообщений), source: 'any'|'user'|'char', regex? }
 *   messageLength  { source: 'lastUser'|'lastChar', op: '<'|'>'|'=', value }
 *   tracker        { trackerId, field, op, value }        — значение трекера через facts.tracker()
 *   variable       { name, op, value }                    — переменные макросов (в т. ч. выбор «одного из»)
 *   chance         { percent }                            — зерно random даёт воспроизводимость
 *   everyN         { n }                                  — каждое N-е сообщение чата
 *   cooldown       { key, turns }                         — после срабатывания молчит N сообщений (состояние в facts.timed)
 *   jev            { question, minChance, user, assistant } — Jev (классификатор) оценивает вероятность утверждения; ответ приходит заранее через facts.jev(leaf).
 *                    Нет ответа (сбой, тайм-аут, нет ключа) — условие ИСТИННО: блок отправляется, как если бы условия не было.
 *   плагин         { type: '<имя>' } → facts.plugins[имя](leaf, facts); ошибка плагина = условие ложно (PM отключает плагин)
 *
 * facts: { messages (новые первыми, {role, text}), chatLength, vars (Map), tracker(id, field), jev(leaf), random, timed, plugins }
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
        const text = facts.messages.filter(m => !wanted || m.role === wanted).slice(0, scan).map(m => m.text).join('\n');
        return (leaf.words ?? []).some(word => keywordHit(word, text));
    },
    messageLength(leaf, facts) {
        const role = leaf.source === 'lastChar' ? 'assistant' : 'user';
        const message = facts.messages.find(m => m.role === role);
        return compare((message?.text ?? '').length, leaf.op, leaf.value);
    },
    tracker: (leaf, facts) => compare(facts.tracker?.(leaf.trackerId, leaf.field), leaf.op, leaf.value),
    variable: (leaf, facts) => compare(facts.vars?.get(leaf.name), leaf.op, leaf.value),
    chance: (leaf, facts) => (facts.random ?? Math.random)() * 100 < (leaf.percent ?? 100),
    everyN: (leaf, facts) => leaf.n > 0 && facts.chatLength % leaf.n === 0,
    jev(leaf, facts) {
        const chance = facts.jev?.(leaf);
        // Нет ответа Jev — условие истинно (решение владельца): сбой классификатора не должен выключать блоки молча.
        if (typeof chance !== 'number') return true;
        return chance * 100 >= (Number.isFinite(Number(leaf.minChance)) ? Number(leaf.minChance) : 70);
    },
    cooldown(leaf, facts) {
        const timed = facts.timed ?? {};
        const until = timed[leaf.key];
        if (until !== undefined && facts.chatLength < until) return false;
        timed[leaf.key] = facts.chatLength + (leaf.turns ?? 1);
        return true;
    },
};

/** Пустое или отсутствующее условие — истина. Неизвестный тип без плагина — ложь. */
export function evaluateCondition(condition, facts) {
    if (!condition) return true;
    switch (condition.type) {
        case 'all': return (condition.items ?? []).every(item => evaluateCondition(item, facts));
        case 'any': return (condition.items ?? []).some(item => evaluateCondition(item, facts));
        case 'not': return !evaluateCondition(condition.item, facts);
        default: {
            if (LEAVES[condition.type]) return Boolean(LEAVES[condition.type](condition, facts));
            const plugin = facts.plugins?.[condition.type];
            if (!plugin) return false;
            try { return Boolean(plugin(condition, facts)); } catch (error) { facts.onPluginError?.(condition.type, error); return false; }
        }
    }
}
