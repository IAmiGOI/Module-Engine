import { estimateMessageTokens } from './pm-tokens.js';

/**
 * Обрезка по бюджету (PROMPT_MANAGER_PLAN.md, раздел 0 «Обрезка и токены»).
 *
 * Принципы: (1) приоритеты — что режем первым; история — самый старый первым; (2) пакетная
 * обрезка с запасом: если бюджет превышен, режем до `budget * (1 - headroom)`, а не «впритык»,
 * чтобы следующие ходы не сдвигали начало истории и не ломали кеш префикса; (3) граница уже
 * сделанной обрезки (`prevCut`) не откатывается назад — кроме одного случая: бюджет вырос с тех пор, как граница была поставлена (`prevBudget`, см. ниже); (4) пара «вызов инструмента + результат»
 * неделима; (5) последнее сообщение и всё с приоритетом ≥ 100 не режется никогда.
 *
 * Сообщение истории несёт `_hid` (стабильный номер в чате). Прочее — `_priority` (по умолчанию 100).
 * Возвращает { messages, dropped, cut, cutBudget, released, total, overBudget }: cut — первый оставшийся `_hid`.
 *
 * Граница привязана к бюджету, при котором её поставили (`cutBudget`, его хранит вызывающий вместе с `cut` и отдаёт обратно как `prevBudget`). Прежде она не отпускалась НИКОГДА:
 * случайно поставили «ответ больше контекста» (бюджет 0), обрезка срезала приветствие и начало чата, бюджет вернули, а чат так и остался без начала. Теперь, когда бюджет
 * вырос не меньше чем на четверть, граница отпускается и обрезка считается заново (влезает всё — вернётся вся история; нет — граница встанет там, где нужно сейчас).
 * Пока бюджет не рос, граница стоит как стояла (тот же префикс на каждом ходу, кеш). `prevBudget` не передан (`undefined`/`null`) — граница не отпускается; `0` — «поставлена
 * при неизвестном бюджете» (старое состояние чата до этой правки): отпускается один раз.
 */
export const CUT_RELEASE_GROWTH = 1.25;
/** Бюджет меньше этого (после вычета места под ответ) — не настройка, а ошибка: резать по нему нечего. */
export const MIN_BUDGET = 512;
export const HISTORY_PRIORITY = 50;
const PROTECTED = 100;

function buildUnits(messages) {
    const units = [];
    for (let i = 0; i < messages.length; i++) {
        const unit = [messages[i]];
        const ids = new Set((messages[i].tool_calls ?? []).map(call => call.id));
        while (ids.size && messages[i + 1]?.role === 'tool' && ids.has(messages[i + 1].tool_call_id)) unit.push(messages[++i]);
        units.push(unit);
    }
    return units;
}

const unitPriority = unit => unit[0]._hid !== undefined ? HISTORY_PRIORITY : unit[0]._priority ?? PROTECTED;
const unitTokens = (unit, count) => unit.reduce((sum, m) => sum + count(m), 0);

export function trimMessages(messages, { budget, headroom = 0.1, prevCut: storedCut = 0, prevBudget, count = estimateMessageTokens } = {}) {
    let units = buildUnits(messages);
    const released = storedCut > 0 && Number.isFinite(budget) && prevBudget !== undefined && prevBudget !== null && budget >= prevBudget * CUT_RELEASE_GROWTH;
    const prevCut = released ? 0 : storedCut;
    const dropped = [];
    const drop = (unit, reason) => { dropped.push({ block: unit[0]._block ?? 'history', hid: unit[0]._hid, tokens: unitTokens(unit, count), reason }); };

    // Уже сделанная граница не откатывается: тот же префикс на каждом ходу.
    units = units.filter(unit => {
        if (unit[0]._hid !== undefined && unit[0]._hid < prevCut) { drop(unit, 'stable cut'); return false; }
        return true;
    });
    let total = units.reduce((sum, unit) => sum + unitTokens(unit, count), 0);
    if (Number.isFinite(budget) && total > budget) {
        const target = budget * (1 - headroom);
        const lastHistory = [...units].reverse().find(unit => unit[0]._hid !== undefined);
        const candidates = units
            .map((unit, index) => ({ unit, index, priority: unitPriority(unit) }))
            .filter(c => c.priority < PROTECTED && c.unit !== lastHistory)
            .sort((a, b) => a.priority - b.priority || a.index - b.index);
        const removed = new Set();
        for (const c of candidates) {
            if (total <= target) break;
            removed.add(c.unit);
            total -= unitTokens(c.unit, count);
            drop(c.unit, c.priority === HISTORY_PRIORITY ? 'over budget (oldest history)' : 'over budget (low priority)');
        }
        units = units.filter(unit => !removed.has(unit));
    }
    const kept = units.flat();
    const firstHistory = kept.find(m => m._hid !== undefined);
    const cut = firstHistory ? firstHistory._hid : prevCut;
    // Бюджет запоминается, когда граница СДВИНУЛАСЬ (или поставлена заново после отпускания); стоит там же, где стояла, — прежний; границы нет — нечего помнить.
    const cutBudget = cut > prevCut || (released && cut > 0) ? budget : (prevCut > 0 && cut > 0 ? (prevBudget ?? null) : null);
    return { messages: kept, dropped, cut, cutBudget, released, total, overBudget: Number.isFinite(budget) && total > budget };
}
