/**
 * Внутренние рассуждения гида (cores/guide): чистые функции. Для сложных задач (несколько шагов, правка чужих данных, проверка границ) модель сначала думает в
 * `<think>…</think>` — черновик на один ответ, не показывается и не хранится, — и ведёт рабочие заметки `<notes>…</notes>`: короткий план и что уже сделано.
 * Заметки СОХРАНЯЮТСЯ между репликами и возвращаются модели в промпте, пока задача не закончится, — так логика длинной задачи не теряется, когда история режется по токенам
 * или разговор уходит на уточнения. Пользователь не видит ни того ни другого. Работает с любой моделью: теги — обычный текст (если модель сама выдаёт `<think>`, он тоже вырезается).
 */

export const MAX_NOTES_CHARS = 1500;

const THINK = /<think>[\s\S]*?(?:<\/think>|$)/gi;
const NOTES = /<notes>([\s\S]*?)(?:<\/notes>|$)/gi;

/**
 * Ответ модели → `{ visible, notes }`. `visible` — то, что увидит человек. `notes`: `undefined` — заметки в ответе не менялись (прежние остаются), строка — новые
 * (пустая — «задача закончена, заметки стереть»).
 */
export function splitThinking(reply) {
    const text = String(reply ?? '');
    let notes;
    for (const match of text.matchAll(NOTES)) notes = match[1].trim().slice(0, MAX_NOTES_CHARS);
    return { visible: text.replace(THINK, '').replace(NOTES, '').replace(/\n{3,}/g, '\n\n').trim(), notes };
}

/** Раздел системного промпта с заметками (пусто, если их нет). */
export const notesBlock = notes => (String(notes ?? '').trim()
    ? `## Your working notes from earlier in this task (private — the user never sees them)\n${String(notes).trim()}`
    : '');

const PARTIAL_TAG = /<(?:t(?:h(?:i(?:n(?:k)?)?)?)?|n(?:o(?:t(?:e(?:s)?)?)?)?)?$/i;

/**
 * Что показывать, пока ответ ещё идёт (стриминг): то же, что `splitThinking().visible`, плюс два правила против «мигания»: (1) обрывок открывающего тега в конце
 * (`<thi`) не показывается; (2) блок с незакрытой оградой ``` (карточка, предложение — JSON ещё дописывается) не показывается совсем до закрытия: сырой JSON на экране
 * недопустим, текст до него — пожалуйста.
 */
export function streamingText(raw) {
    let visible = splitThinking(raw).visible.replace(PARTIAL_TAG, '');
    const fences = [...visible.matchAll(/```/g)];
    if (fences.length % 2 === 1) visible = visible.slice(0, fences.at(-1).index);
    return visible.trimEnd();
}
