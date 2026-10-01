/**
 * Зацикливание модели: иногда она начинает бесконечно повторять одну и ту же фразу, часто с мелкими вариациями и без разделителей («…main wiki pageLet me pull up the…»).
 * Пока ответ идёт, по накопленному тексту ищется петля, и генерацию можно оборвать, оставив один экземпляр. Чистая функция.
 */

const MIN_TEXT = 120;
const TAIL_CHARS = 3000;
const UNIT_MIN = 20;
const UNIT_MAX = 600;
const WINDOW = 40;
const WINDOW_REPEATS = 4;
const SENTENCE_LOOK_BACK = 200;
const SCAN_CHARS = 700;
const SCAN_STEP = 8;

const letters = text => (text.match(/\p{L}/gu) ?? []).length;
const insideFence = text => (text.match(/```/g) ?? []).length % 2 === 1;

/** Возвращает индекс обрезки по ближайшей границе предложения слева от `cut` (если она рядом), чтобы остаток не кончался на полуслове. */
function snapToSentence(source, cut) {
    const boundary = Math.max(source.lastIndexOf('.', cut - 1), source.lastIndexOf('!', cut - 1), source.lastIndexOf('?', cut - 1), source.lastIndexOf('\n', cut - 1));
    return boundary >= 0 && cut - boundary <= SENTENCE_LOOK_BACK ? boundary + 1 : cut;
}

/**
 * Где обрезать зациклившийся текст: индекс, до которого текст ещё нормальный (остаётся ОДИН экземпляр), либо `-1`, если петли нет. Ищет: (1) точный повтор куска (20–600 знаков,
 * не менее 8 букв — линия из «-----» не петля) три раза подряд в конце; (2) какие-то 40 знаков (не менее 20 букв) из последних 700 встречаются в хвосте текста четыре раза и больше — так ловится
 * петля с вариациями. Внутри блока ``` (JSON карточки) работает только первый способ: ключи там повторяются честно.
 */
export function computeRepetitionCut(text) {
    const source = String(text ?? '');
    if (source.length < MIN_TEXT) return -1;
    const tail = source.slice(-TAIL_CHARS);
    for (let size = UNIT_MIN; size <= Math.min(UNIT_MAX, Math.floor(tail.length / 3)); size += 1) {
        const unit = tail.slice(-size);
        if (tail.slice(-2 * size, -size) === unit && tail.slice(-3 * size, -2 * size) === unit && letters(unit) >= 8) return snapToSentence(source, source.length - 2 * size);
    }
    if (insideFence(source)) return -1;
    // Скользим окном по последним знакам: границы между повторами у петли с вариациями «плавают», зато внутри фразы любое окно встречается снова и снова.
    const from = Math.max(0, tail.length - SCAN_CHARS);
    for (let offset = from; offset + WINDOW <= tail.length; offset += SCAN_STEP) {
        const window = tail.slice(offset, offset + WINDOW);
        if (letters(window) < 20) continue;
        const at = [];
        for (let found = tail.indexOf(window); found >= 0; found = tail.indexOf(window, found + WINDOW)) at.push(found);
        if (at.length >= WINDOW_REPEATS) return snapToSentence(source, source.length - tail.length + at[1]);
    }
    return -1;
}
