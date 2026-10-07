/**
 * Поиск мест по ключевым словам — ОДИН код на сервере и в клиенте ME (файл в клиенте — байт-в-байт копия, это проверяет тест). Слова ищет КЛИЕНТ в тексте чата, текст на сервер не уходит.
 * Только английский: слово приводится к основе (без притяжательного 's и без окончания множественного числа), фраза ищется от самого длинного совпадения.
 */

/** Основа слова: нижний регистр, без 's и без множественного числа (tavern, taverns, tavern's → tavern). */
export function stem(word) {
    let w = String(word).toLowerCase().replace(/['’]s$/, '').replace(/['’]/g, '');
    if (w.length <= 3) return w;
    if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
    if (/(sses|xes|ches|shes|zes)$/.test(w)) return w.slice(0, -2);
    if (/(ss|us|is)$/.test(w)) return w;
    if (/s$/.test(w)) return w.slice(0, -1);
    return w;
}
const tokenize = text => (String(text).toLowerCase().replace(/-/g, ' ').match(/[a-z]+(?:['’][a-z]+)?/g) ?? []).map(stem);

/** Ключевое слово или фраза → последовательность основ (дефис считается границей слов). */
export const phraseOf = keyword => tokenize(keyword);

/** Индекс для поиска: первая основа → фразы этого начала, от самых длинных. `places` — `[{ id, keywords }]`. */
export function buildIndex(places) {
    const index = new Map();
    for (const place of places) for (const keyword of place.keywords) {
        const phrase = phraseOf(keyword);
        if (!phrase.length) continue;
        (index.get(phrase[0]) ?? index.set(phrase[0], []).get(phrase[0])).push({ place: place.id, phrase });
    }
    for (const list of index.values()) list.sort((a, b) => b.phrase.length - a.phrase.length);
    return index;
}

/** Сколько раз встретились слова каждого места в тексте: `{ placeId: count }` только для найденных. Совпадение ищется от самого длинного слова и не накладывается на соседнее. */
export function matchPlaces(text, index) {
    const tokens = tokenize(text);
    const counts = {};
    for (let i = 0; i < tokens.length;) {
        const hit = (index.get(tokens[i]) ?? []).find(item => item.phrase.every((part, offset) => tokens[i + offset] === part));
        if (hit) { counts[hit.place] = (counts[hit.place] ?? 0) + 1; i += hit.phrase.length; } else i += 1;
    }
    return counts;
}
