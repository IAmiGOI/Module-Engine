/**
 * Запрос и ответ Jev — классификатора решений («Jev», эндпоинт `decisions` на OpenRouter и NanoGPT): чистые функции. Один запрос несёт срез чата (`state`) и
 * несколько вопросов; на каждое утверждение Jev отвечает вероятностью 0…1 (режим Noul). Сети здесь нет: вызов делает Ядро через Сервис HTTP.
 *
 *   POST <endpoint>   Authorization: Bearer <ключ>
 *   { "model": "...", "state": { "player_message": "..." }, "questions": { "<id>": { "type": "noul", "instructions": "<утверждение>" } } }
 *   → { "answers": { "<id>": { "noul": 0.82 } }, "usage": { ... } }
 */
export const JEV_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.13';
export const JEV_DEFAULT_TIMEOUT_MS = 3000;

export function buildJevRequest({ endpoint, apiKey, model }, { state, questions }) {
    return {
        url: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model, state,
            questions: Object.fromEntries(Object.entries(questions).map(([id, instructions]) => [id, { type: 'noul', instructions: String(instructions) }])),
        }),
    };
}

const isChance = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** `{ [id]: вероятность 0…1 }` только для вопросов, на которые пришёл годный ответ: остальные считаются неотвеченными. */
export function readJevAnswers(data, ids) {
    const answers = {};
    for (const id of ids) {
        const chance = data?.answers?.[id]?.noul;
        if (isChance(chance)) answers[id] = chance;
    }
    return answers;
}

/** Что сказать человеку, когда эндпоинт отказал: ключ, деньги или просто «не вышло». */
export function describeJevFailure(status, data) {
    const code = Number(data?.error?.code ?? status);
    if (code === 401 || code === 403) return 'The API key was rejected.';
    if (code === 402) return 'The account has no credit left.';
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message ?? data?.detail;
    return typeof message === 'string' && message ? message : `The endpoint answered ${status}.`;
}
