/**
 * Изношенные обороты Писателя: куски по 5 слов, которые уже стоят в двух и больше его последних ответах.
 * Правило «не повторяй образы» модель не держала: «words come level, measured out like coin on a counter»
 * вышло четыре раза подряд. Список ей даётся прямо в Inscription — так же, как резолверу ALREADY SAID AND DONE.
 */
const SIZE = 5;
// Служебные слова: кусок только из них («and then she was the») — не оборот.
const FILLER = new Set('a an the and or but of to in on at by for with from into onto over under as is was were be been her his their its she he they it you your i me my we our that this there then than not no so if what who which while where when'.split(' '));

const words = text => String(text ?? '').toLowerCase().replace(/[*_"“”«»]/g, ' ').match(/[a-z']+/g) ?? [];

export function wornPhrases(replies, { size = SIZE, min = 2, limit = 12 } = {}) {
    const seen = new Map();
    for (const reply of (Array.isArray(replies) ? replies : []).filter(Boolean)) {
        const list = words(reply);
        const here = new Set();
        for (let index = 0; index + size <= list.length; index += 1) {
            const gram = list.slice(index, index + size);
            if (gram.filter(word => !FILLER.has(word)).length < 2) continue;
            here.add(gram.join(' '));
        }
        for (const gram of here) seen.set(gram, (seen.get(gram) ?? 0) + 1);
    }
    // Длинный повтор даёт цепочку перекрывающихся кусков — оставляем первый из каждой цепочки.
    const repeated = [...seen].filter(([, count]) => count >= min).map(([gram]) => gram);
    const kept = [];
    for (const gram of repeated) {
        const head = gram.split(' ').slice(0, size - 1).join(' ');
        if (kept.some(other => other.endsWith(head) || other.includes(gram))) { kept[kept.length - 1] = merge(kept.at(-1), gram); continue; }
        kept.push(gram);
    }
    return kept.slice(0, limit);
}

function merge(left, right) {
    const tail = right.split(' ');
    for (let cut = tail.length - 1; cut > 0; cut -= 1) if (left.endsWith(tail.slice(0, cut).join(' '))) return `${left} ${tail.slice(cut).join(' ')}`;
    return left.includes(right) ? left : `${left} … ${right}`;
}

/** Блок для Inscription: пусто — блока нет. */
export function wornPhrasesBlock(replies, options) {
    const list = wornPhrases(replies, options);
    if (!list.length) return '';
    return `WORN PHRASES — these turns of phrase already stand in more than one of your recent replies. Write none of them again, and nothing built the same way; find what is new in this moment:\n${list.map(item => `- "${item}"`).join('\n')}`;
}
