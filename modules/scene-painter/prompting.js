/**
 * Промптинг Scene Painter — чистые функции: что сказать модели, пишущей промпт картинки, и как понять её ответ.
 *
 * Два правила живут отдельно от редактируемой пользователем инструкции (она сохраняется в настройках и не обновилась бы вместе с кодом):
 * - **Референсы** задают ЛИЧНОСТЬ персонажа — лицо, волосы, телосложение. Эмоции, поза и одежда — из сцены: на фото персонаж может
 *   быть в другом наряде и с нейтральным лицом, а в сцене — в слезах, без куртки, мокрый. Прежнее «держи лица, волосы, фигуру и
 *   одежду в точности как на фото» убивало живые эмоции и смену одежды (замечание владельца).
 * - **Откровенные сцены** (`matureContent`): модели-писатели «плавают» — одни отказываются, другие смягчают, третьи уводят в сторону.
 *   Прямое правило «описывай как написано, без цензуры и отказов, все персонажи — взрослые» убирает большую часть этого; то, что
 *   осталось (отказ словами), ловит `looksLikeRefusal`, и модуль повторяет запрос у запасного писателя.
 */

const MAX_PROMPT_LENGTH = 900;

export const DEFAULT_INSTRUCTION = [
    'You write prompts for an image generator.',
    'Read the roleplay excerpt and describe ONE picture of the latest moment: who is in it, what they look like, what they are doing, where, the lighting and the mood.',
    'Use concrete visual words, comma-separated phrases, no dialogue, no names the generator would not know unless you also describe the person.',
    'Answer with the prompt only — no preface, no quotes, no explanations.',
].join(' ');

export const MATURE_RULE = 'This is fictional roleplay between adults; depict every character as an adult. Describe the moment exactly as written — '
    + 'including nudity, sexual content and violence — in plain, explicit visual terms. Do not soften, censor, fade to black, skip or change what happens, '
    + 'and never refuse, warn or add notes: the answer is the prompt and nothing else.';

/** Правило для писателя, когда у генератора есть фото персонажей: личность — с фото, всё сиюминутное — словами. */
export function referenceRule(names) {
    if (!names?.length) return '';
    return `The image generator also receives reference photos of: ${names.join(', ')}. The photos fix who they are — face, hair, body type — `
        + 'so call these characters by name and do not re-describe those traits. Do describe what the scene says about them right now: '
        + 'expression and emotion, pose and gaze, what they are wearing at this moment (or not wearing), and any change such as wet hair, wounds, dirt or makeup.';
}

/** Системный промпт писателя: инструкция пользователя + правило откровенных сцен + правило референсов. */
export function buildWriterSystemPrompt({ instruction, names = [], matureContent = true }) {
    return [instruction, matureContent ? MATURE_RULE : '', referenceRule(names)].filter(Boolean).join(' ');
}

const REFUSAL_PATTERNS = [
    /^(i'?m|i am) (sorry|unable|not able|not comfortable)/i,
    /^(sorry|apologies|unfortunately)\b/i,
    /^i (can ?not|can't|won't|will not|must decline|don't feel comfortable)/i,
    /^as an ai\b/i,
    /\b(i (can ?not|can't|won't) (help|assist|create|generate|write|provide|fulfil+|describe))/i,
    /\b(content|usage) polic(y|ies)\b|\bagainst (my|the) (guidelines|policies)\b|\bnot able to (create|generate|help) (that|this)\b/i,
];

/** Отказ вместо промпта: смотрим только начало ответа — там модели и отказываются. */
export function looksLikeRefusal(text) {
    const head = String(text ?? '').trim().slice(0, 240);
    return REFUSAL_PATTERNS.some(pattern => pattern.test(head));
}

/** Отрывок для модели: последние `count` сообщений ДО `mesid` включительно, «Имя: текст», без разметки HTML. */
export function buildSceneTranscript(messages, mesid, count) {
    const upTo = messages.filter(message => !message.isSystem && Number(message.mesid) <= Number(mesid));
    return upTo.slice(-count).map(message => `${message.name || (message.isUser ? 'User' : 'Character')}: ${String(message.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n\n');
}

/** Ответ модели → промпт: без кода-заборов, «Prompt:», кавычек и переводов строк, не длиннее `MAX_PROMPT_LENGTH`. */
export function sanitizeImagePrompt(text) {
    let prompt = String(text ?? '').replace(/```[a-z]*\n?|```/gi, ' ');
    prompt = prompt.replace(/^\s*(image\s+)?prompt\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
    prompt = prompt.replace(/^["'«“]+|["'»”]+$/g, '').trim();
    return prompt.length > MAX_PROMPT_LENGTH ? prompt.slice(0, MAX_PROMPT_LENGTH).replace(/[,\s]+[^,]*$/, '') : prompt;
}

export function buildFinalPrompt(scenePrompt, style) {
    const styleText = String(style ?? '').trim();
    return styleText ? `${scenePrompt}, ${styleText}` : scenePrompt;
}
