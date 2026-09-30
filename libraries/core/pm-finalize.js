/**
 * Завершающая обработка собранных сообщений и параметры в тело запроса (Chat Completion).
 * Чистые функции. Служебные поля (всё, что начинается с `_`: `_block`, `_hid`, `_priority`, `_open`…) снимаются последним
 * шагом — провайдер их не должен видеть (раньше снимались только `_block`/`_hid`, и `_priority` уходил в запрос — живой ST 1.18).
 */
/**
 * Параметры пресета → поля тела запроса ST (только заданные в пресете; имена — как у эндпоинта generate).
 * `stream` сюда НЕ входит намеренно: ST разбирает ответ по своей настройке стриминга, и расхождение с телом запроса сломало бы
 * приём ответа. Стриминг переключается настройкой ST на время генерации (`stPromptData.setStreaming`), см. ядро PM.
 */
const PARAM_TO_BODY = {
    temperature: 'temperature', top_p: 'top_p', top_k: 'top_k', top_a: 'top_a', min_p: 'min_p',
    frequency_penalty: 'frequency_penalty', presence_penalty: 'presence_penalty', repetition_penalty: 'repetition_penalty',
    openai_max_tokens: 'max_tokens', seed: 'seed', n: 'n',
    reasoning_effort: 'reasoning_effort', verbosity: 'verbosity',
};

export function paramsToBody(params) {
    const body = {};
    for (const [key, target] of Object.entries(PARAM_TO_BODY)) if (params?.[key] !== undefined && params[key] !== null) body[target] = params[key];
    return body;
}

/** `squash_system_messages`: подряд идущие system-сообщения без служебных полей склеиваются в одно. */
export function squashSystem(messages) {
    const out = [];
    for (const message of messages) {
        const last = out.at(-1);
        if (last && last.role === 'system' && message.role === 'system' && typeof last.content === 'string' && typeof message.content === 'string') {
            out[out.length - 1] = { ...last, content: `${last.content}\n${message.content}` };
        } else out.push({ ...message });
    }
    return out;
}

export function finalizeMessages(messages, { params = {}, substitute = text => text } = {}) {
    let out = messages;
    if (params.squash_system_messages) out = squashSystem(out);
    const prefill = substitute(params.assistant_prefill ?? '');
    if (typeof prefill === 'string' && prefill.trim()) out = [...out, { role: 'assistant', content: prefill }];
    return out.map(message => Object.fromEntries(Object.entries(message).filter(([key]) => !key.startsWith('_'))));
}
