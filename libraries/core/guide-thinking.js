/**
 * Внутренние рассуждения гида (cores/guide): чистые функции. Для сложных задач (несколько шагов, правка чужих данных, проверка границ) модель сначала думает в
 * `<think>…</think>` — черновик на один ответ, не показывается и не хранится, — и пишет себе план `<plan>…</plan>` (шаги, что сделано); тег `<notes>` принимается как прежнее имя.
 * План СОХРАНЯЕТСЯ между репликами и возвращаются модели в промпте, пока задача не закончится, — так логика длинной задачи не теряется, когда история режется по токенам
 * или разговор уходит на уточнения. Пользователь не видит ни того ни другого. Работает с любой моделью: теги — обычный текст (если модель сама выдаёт `<think>`, он тоже вырезается).
 *
 * Третий тег — `<continue/>`: «я открываю блок, чтобы посмотреть; продолжи сразу, как он откроется». Гид видит поля и значения только у РАСКРЫТЫХ блоков, поэтому за
 * недостающими сведениями ей нужно сослаться на блок (он откроется сам) и получить ещё один ход без участия человека. Тег вырезается из видимого текста.
 */

export const MAX_PLAN_CHARS = 4000;
/** План лежит в истории на этой глубине (как вставка `@4` в SillyTavern): перед последними четырьмя сообщениями, а не в системном промпте — он всегда рядом с последними репликами. */
export const PLAN_DEPTH = 4;

const THINK = /<think>[\s\S]*?(?:<\/think>|$)/gi;
// `<notes>` — прежнее имя тега: старые чаты и модели, привыкшие к нему, продолжают работать.
const PLAN = /<(?:plan|notes)>([\s\S]*?)(?:<\/(?:plan|notes)>|$)/gi;
const CONTINUE = /<continue\s*\/?>(?:\s*<\/continue>)?/gi;

/**
 * Ответ модели → `{ visible, plan, more }`. `visible` — то, что увидит человек. `plan`: `undefined` — план в ответе не менялся (прежний остаётся; подтверждения человека он не требует и ему не показывается), строка — новый
 * (пустая — «задача закончена, план стереть»). `more` — модель просит продолжить сама, когда откроются блоки, на которые сослалась.
 */
export function splitThinking(reply) {
    const text = String(reply ?? '');
    let plan;
    for (const match of text.matchAll(PLAN)) plan = match[1].trim().slice(0, MAX_PLAN_CHARS);
    const more = /<continue\s*\/?>/i.test(text.replace(THINK, ''));
    return { visible: text.replace(THINK, '').replace(PLAN, '').replace(CONTINUE, '').replace(/\n{3,}/g, '\n\n').trim(), plan, more };
}

/** Сообщение с планом для модели (`null`, если плана нет). */
export const planMessage = plan => (String(plan ?? '').trim()
    ? { role: 'system', content: `## Your plan for this task (private — the user never sees it; follow it and update it with a new <plan> when something is done or changes)\n${String(plan).trim()}` }
    : null);

/** Ход с планом вставляется на глубину `depth` от конца истории (в коротком разговоре — в самое начало): `turns` не меняется, возвращается новый список. */
export function insertPlan(turns, plan, depth = PLAN_DEPTH) {
    const message = planMessage(plan);
    if (!message) return turns;
    const at = Math.max(0, turns.length - depth);
    return [...turns.slice(0, at), message, ...turns.slice(at)];
}

const PARTIAL_TAG = /<(?:t(?:h(?:i(?:n(?:k)?)?)?)?|p(?:l(?:a(?:n)?)?)?|n(?:o(?:t(?:e(?:s)?)?)?)?|c(?:o(?:n(?:t(?:i(?:n(?:u(?:e)?)?)?)?)?)?)?)?$/i;

/**
 * Что показывать, пока ответ ещё идёт (стриминг): то же, что `splitThinking().visible`, но (1) обрывок открывающего тега в конце (`<thi`) не показывается; (2) всё от первой
 * ограды ``` не показывается — карточки, предложения и кнопки появятся, когда придёт финальная реплика (их ещё может вырезать предохранитель «сначала посмотри»), а сырой JSON
 * на экране недопустим. Текст ДО блока показывается сразу.
 */
export function streamingText(raw) {
    let visible = splitThinking(raw).visible.replace(PARTIAL_TAG, '');
    const fence = visible.indexOf('```');
    if (fence >= 0) visible = visible.slice(0, fence);
    return visible.trimEnd();
}
