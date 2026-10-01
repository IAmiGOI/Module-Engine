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
const TOOL_CALL_OPEN = /<(?:tool_call|function_call)>/gi;
// Обрывки чужой разметки вызовов: закрывающие теги и метки вида $0$, которыми такие модели заканчивают аргументы.
const TOOL_CALL_JUNK = /<\/?(?:tool_call|function_call|arg_key|arg_value|tool_response)>|\$\d+\$/gi;

/** Конец JSON-объекта, начинающегося в `from` (учитывает строки и вложенность); `-1` — не закрыт. */
function findJsonEnd(text, from) {
    let depth = 0;
    let inString = false;
    for (let index = from; index < text.length; index += 1) {
        const char = text[index];
        if (inString) { if (char === '\\') index += 1; else if (char === '"') inString = false; continue; }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') { depth -= 1; if (!depth) return index + 1; }
    }
    return -1;
}

/**
 * Некоторые модели вызывают инструменты на своём языке: `<tool_call>web.read: {"ref": "anilist:1"}$0$</arg_value>` (имя, двоеточие или перенос, JSON, обрывки тегов). Такой вызов
 * переписывается в обычный блок ```action``` (дальше всё как у остальных действий), а оборванная разметка вырезается и в чат не попадает. Вызов, который не разобрать, просто
 * вырезается вместе с остатком строки.
 */
export function normalizeToolCalls(reply) {
    let text = String(reply ?? '');
    let from = 0;
    for (;;) {
        TOOL_CALL_OPEN.lastIndex = from;
        const open = TOOL_CALL_OPEN.exec(text);
        if (!open) break;
        const afterTag = open.index + open[0].length;
        const head = /^\s*([\w.]+)\s*[:\n ]\s*/.exec(text.slice(afterTag));
        const braceAt = head ? afterTag + head[0].length : -1;
        const end = head && text[braceAt] === '{' ? findJsonEnd(text, braceAt) : -1;
        let params = null;
        let callEnd = end;
        if (end > 0) { try { params = JSON.parse(text.slice(braceAt, end)); } catch { params = null; } }
        // Родной формат GLM: имя, затем пары `<arg_key>ключ</arg_key><arg_value>значение</arg_value>`; значение — JSON, если разбирается, иначе строка.
        if (!params && head) {
            const pairs = /^(?:\s*<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>)+/.exec(text.slice(braceAt));
            if (pairs) {
                params = {};
                for (const [, key, value] of pairs[0].matchAll(/<arg_key>([^<]+)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)) {
                    let parsed = value.trim();
                    try { parsed = JSON.parse(parsed); } catch { /* строка */ }
                    params[key.trim()] = parsed;
                }
                callEnd = braceAt + pairs[0].length;
            }
        }
        if (params && head[1].includes('.')) {
            // Хвост вызова — только ЗАКРЫВАЮЩИЕ теги и метки `$0$`: открывающий `<tool_call>` следующего вызова забирать нельзя.
            const junk = /^(?:\s*(?:<\/(?:arg_key|arg_value|tool_call|function_call)>|\$\d+\$))*/.exec(text.slice(callEnd))[0].length;
            const block = `\n\`\`\`action\n${JSON.stringify({ label: head[1], action: head[1], params })}\n\`\`\`\n`;
            text = text.slice(0, open.index) + block + text.slice(callEnd + junk);
            from = open.index + block.length;
        } else {
            const lineEnd = text.indexOf('\n', afterTag);
            text = text.slice(0, open.index) + (lineEnd < 0 ? '' : text.slice(lineEnd));
            from = open.index;
        }
    }
    return text.replace(TOOL_CALL_JUNK, '');
}

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
    if (/<(?:tool_call|function_call)>(?![\s\S]*<\/(?:tool_call|function_call)>)/i.test(text) || /<(?:tool_call|function_call)>/i.test(text)) return { label: 'Preparing an action' };
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
    const toolAt = String(raw ?? '').search(/<(?:tool_call|function_call)>/i);
    let visible = splitThinking(toolAt >= 0 ? String(raw).slice(0, toolAt) : raw).visible.replace(PARTIAL_TAG, '').replace(PARTIAL_RESULT, '');
    const fence = visible.indexOf('```');
    if (fence >= 0) visible = visible.slice(0, fence);
    return visible.trimEnd();
}
