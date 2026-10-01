/**
 * Внутренние рассуждения гида (cores/guide): чистые функции. Для сложных задач (несколько шагов, правка чужих данных, проверка границ) модель сначала думает в
 * `<think>…</think>` — черновик на один ответ, не показывается и не хранится, — и пишет себе план `<plan>…</plan>` (шаги, что сделано); тег `<notes>` принимается как прежнее имя.
 * План СОХРАНЯЕТСЯ между репликами и возвращаются модели в промпте, пока задача не закончится, — так логика длинной задачи не теряется, когда история режется по токенам
 * или разговор уходит на уточнения. Пользователь не видит ни того ни другого. Работает с любой моделью: теги — обычный текст (если модель сама выдаёт `<think>`, он тоже вырезается).
 *
 * Третий тег — `<continue/>`: «я открываю блок, чтобы посмотреть; продолжи сразу, как он откроется». Гид видит поля и значения только у РАСКРЫТЫХ блоков, поэтому за
 * недостающими сведениями ей нужно сослаться на блок (он откроется сам) и получить ещё один ход без участия человека. Тег вырезается из видимого текста.
 */

import { normalizeToolCalls, findForeignCallStart } from './guide-toolcalls.js';

// Вызовы инструментов на языке модели (GLM, Qwen, DeepSeek…) переписываются в блоки действий: см. guide-toolcalls.js.
export { normalizeToolCalls };

export const MAX_PLAN_CHARS = 4000;

/**
 * Результат действия (поиск, страница, проверка) в истории для модели. Отдельная рамка, не её реплика: когда результаты шли как `(result: …)` её собственными
 * словами, модель начинала писать такие результаты сама — выдумывала страницу, цитаты и «text continues» вместо того, чтобы запустить действие и дождаться ответа движка.
 */
export const formatEngineResult = text => `[ENGINE RESULT — made by the engine after your action ran; you never write these]\n${String(text ?? '').trim()}\n[END ENGINE RESULT]`;

/** Следы выдуманного результата в ответе модели: рамка движка, прежний формат `(result: …)`, тег. Всё от первого следа и до конца — её выдумка, не показывается и не исполняется. */
const FAKE_RESULT = /\[(?:END )?ENGINE RESULT|\(result\s*(?::|for\b)|<engine_result/i;
const BROKEN_CONTINUE = /<continue\b[^>]*$/i;
/** План лежит в истории на этой глубине (как вставка `@4` в SillyTavern): перед последними четырьмя сообщениями, а не в системном промпте — он всегда рядом с последними репликами. */
export const PLAN_DEPTH = 4;

const THINK = /<think>[\s\S]*?(?:<\/think>|$)/gi;
// `<notes>` — прежнее имя тега: старые чаты и модели, привыкшие к нему, продолжают работать.
const PLAN = /<(?:plan|notes)>([\s\S]*?)(?:<\/(?:plan|notes)>|$)/gi;
const CONTINUE = /<continue\s*\/?>(?:\s*<\/continue>)?/gi;

/**
 * Ответ модели → `{ visible, plan, more, fabricated }` (`fabricated` — в ответе были выдуманные «результаты» действий: они отброшены вместе со всем, что после них). `visible` — то, что увидит человек. `plan`: `undefined` — план в ответе не менялся (прежний остаётся; подтверждения человека он не требует и ему не показывается), строка — новый
 * (пустая — «задача закончена, план стереть»). `more` — модель просит продолжить сама, когда откроются блоки, на которые сослалась.
 */
export function splitThinking(reply) {
    const whole = normalizeToolCalls(reply);
    const cut = whole.search(FAKE_RESULT);
    const fabricated = cut >= 0;
    const text = (fabricated ? whole.slice(0, cut) : whole).replace(BROKEN_CONTINUE, '');
    let plan;
    for (const match of text.matchAll(PLAN)) plan = match[1].trim().slice(0, MAX_PLAN_CHARS);
    const more = /<continue\s*\/?>/i.test(text.replace(THINK, ''));
    return { visible: text.replace(THINK, '').replace(PLAN, '').replace(CONTINUE, '').replace(/\n{3,}/g, '\n\n').trim(), plan, more, fabricated };
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

// Обрывок рамки результата в конце стримингового ответа (`(res`, `[ENGINE RE`) не мелькает на экране, пока не станет ясно, что это.
const PARTIAL_RESULT = /(?:\(r(?:e(?:s(?:u(?:l(?:t)?)?)?)?)?|\[E[A-Z ]{0,12})$/;
const PARTIAL_TAG = /<(?:t(?:h(?:i(?:n(?:k)?)?)?)?|p(?:l(?:a(?:n)?)?)?|n(?:o(?:t(?:e(?:s)?)?)?)?|c(?:o(?:n(?:t(?:i(?:n(?:u(?:e)?)?)?)?)?)?)?)?$/i;

const CARD_FIELD_LABELS = Object.freeze({ name: 'name', description: 'description', personality: 'personality', scenario: 'scenario', first_mes: 'first message', mes_example: 'examples', creator_notes: 'notes', system_prompt: 'system prompt', post_history_instructions: 'post-history rules', alternate_greetings: 'greetings', tags: 'tags', character_book: 'lorebook', depth_prompt: 'depth prompt' });
const CARD_FIELD_KEY = new RegExp(`"(${Object.keys(CARD_FIELD_LABELS).join('|')})"\\s*:`, 'g');

/**
 * Что она делает сейчас, пока ответ ещё идёт: `{ label }` или `null`. Нужна, потому что текст стриминга обрывается на первой ограде ``` (карточки и предложения появляются
 * готовыми), и пока она пишет длинную карточку, окно молчит и выглядит зависшим. Стадия: думает (`<think>`), пишет план (`<plan>`), пишет карточку персонажа (с названием
 * поля, которое пишется сейчас), готовит предложение или действие. Закрытые блоки не считаются.
 */
export function streamingStage(raw) {
    const text = String(raw ?? '');
    if (findForeignCallStart(text) >= 0) return { label: 'Preparing an action' };
    if (/<think>(?![\s\S]*<\/think>)/i.test(text)) return { label: 'Thinking' };
    if (/<(?:plan|notes)>(?![\s\S]*<\/(?:plan|notes)>)/i.test(text)) return { label: 'Writing the plan' };
    const fences = text.split('```');
    if (fences.length % 2 === 1) return null;
    const open = fences.at(-1);
    const kind = /^\s*(\w+)/.exec(open)?.[1] ?? '';
    if (kind === 'proposal') {
        const action = /"action"\s*:\s*"([\w.]+)"/.exec(open)?.[1] ?? '';
        if (action.startsWith('character.')) {
            if (action === 'character.avatar') return { label: 'Choosing a picture' };
            const keys = [...open.matchAll(CARD_FIELD_KEY)].map(match => match[1]);
            return { label: keys.length ? `Writing the card · ${CARD_FIELD_LABELS[keys.at(-1)]}` : 'Writing the card' };
        }
        return { label: 'Preparing a proposal' };
    }
    if (kind === 'action') return { label: 'Preparing an action' };
    return { label: 'Preparing the reply' };
}

/**
 * Что показывать, пока ответ ещё идёт (стриминг): то же, что `splitThinking().visible`, но (1) обрывок открывающего тега в конце (`<thi`) не показывается; (2) всё от первой
 * ограды ``` не показывается — карточки, предложения и кнопки появятся, когда придёт финальная реплика (их ещё может вырезать предохранитель «сначала посмотри»), а сырой JSON
 * на экране недопустим. Текст ДО блока показывается сразу.
 */
export function streamingText(raw) {
    // Чужая разметка вызова, пока она ещё пишется, не показывается: всё от `<tool_call>` — не текст для человека.
    const toolAt = findForeignCallStart(raw);
    let visible = splitThinking(toolAt >= 0 ? String(raw).slice(0, toolAt) : raw).visible.replace(PARTIAL_TAG, '').replace(PARTIAL_RESULT, '');
    const fence = visible.indexOf('```');
    if (fence >= 0) visible = visible.slice(0, fence);
    return visible.trimEnd();
}
