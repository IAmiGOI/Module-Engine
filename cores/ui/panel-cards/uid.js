let uid = 0;

/** Общий счётчик для стабильных ключей строк списков (`worker_1`, `macro_2`, …) — уникален на весь экран, а не на карточку. */
export function nextUid() {
    return ++uid;
}
