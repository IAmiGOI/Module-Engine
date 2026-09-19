/**
 * Упаковка записей в чанки по токенному бюджету — для многовызовных проходов
 * над большим Lorebook (первый потребитель — бутстрап Графа памяти).
 *
 * Гарантии (ради "без потерь"): запись НИКОГДА не режется и не сжимается —
 * каждая попадает ровно в один чанк целиком; порядок записей сохраняется
 * (связанные записи в WI обычно идут подряд, пусть остаются в одном чанке);
 * запись, которая одна больше бюджета, получает СВОЙ чанк (превышение
 * бюджета лучше потери текста). Чанки балансируются по размеру, а не
 * "N полных + огрызок".
 */

/** Грубая оценка токенов по символам. 3.5 симв./токен — консервативно: кириллица/CJK токенизируются хуже латиницы. */
export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 3.5);
}

/** Стоимость записи в промпте: метка + текст + номер и разделители. */
export function entryCostTokens(entry) {
    return estimateTokens(entry?.label) + estimateTokens(entry?.content) + 6;
}

/**
 * @param {Array<{label:string, content:string}>} entries
 * @param {number} budgetTokens — целевой размер ТЕКСТА записей в одном чанке; 0/не число — всё одним чанком
 * @param {{costOf?: (entry:any)=>number}} [options]
 * @returns {Array<Array<any>>} чанки (пустой вход — пустой массив)
 */
export function packEntriesIntoChunks(entries, budgetTokens, { costOf = entryCostTokens } = {}) {
    if (!entries.length) return [];
    const budget = Number(budgetTokens);
    if (!(budget > 0)) return [entries.slice()];

    const costs = entries.map(entry => costOf(entry));
    const total = costs.reduce((sum, cost) => sum + cost, 0);

    // Число чанков заранее недооценивается (ceil(total/budget) исходит из
    // идеальной укладки) — повторяем упаковку с реально получившимся числом,
    // пока оно не перестанет расти: тогда доля на чанк считается от него.
    let chunkCount = Math.max(1, Math.ceil(total / budget));
    for (;;) {
        const chunks = packWithTarget(entries, costs, budget, total / chunkCount, chunkCount);
        if (chunks.length <= chunkCount || chunkCount >= entries.length) return chunks;
        chunkCount = chunks.length;
    }
}

function packWithTarget(entries, costs, budget, target, chunkCount) {
    const chunks = [];
    let current = [];
    let currentCost = 0;
    let doneCost = 0; // стоимость уже закрытых чанков — граница считается КУМУЛЯТИВНО, иначе недолёт/перелёт каждого чанка копится и последний остаётся огрызком
    entries.forEach((entry, index) => {
        const cost = costs[index];
        const wouldOverflow = currentCost + cost > budget;
        // Закрываем чанк, когда добавление записи промахнулось бы мимо границы (k+1)-й "справедливой доли" сильнее, чем остановка сейчас.
        const boundary = (chunks.length + 1) * target;
        const before = doneCost + currentCost;
        const closerToBoundaryWithout = before + cost - boundary > boundary - before;
        if (current.length && (wouldOverflow || (closerToBoundaryWithout && chunks.length < chunkCount - 1))) {
            chunks.push(current);
            doneCost += currentCost;
            current = [];
            currentCost = 0;
        }
        current.push(entry);
        currentCost += cost;
    });
    if (current.length) chunks.push(current);
    return chunks;
}
