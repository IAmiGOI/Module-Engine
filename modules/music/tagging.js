import { request } from '../../libraries/shared/request.js';
import { TAGGING_INSTRUCTION, batchTracks, buildTaggingPrompt, parseTaggingReply } from '../../libraries/shared/music-tagging.js';

/**
 * Разметка треков текстовой моделью пользователя (`model.generate` через ядра): пачками по десять, названия и исполнители → описания настроения и сцены.
 * Промпт, разбор и пределы — чистая библиотека `libraries/shared/music-tagging.js`; здесь только вызовы. Ничего не пишет в хранилище: возвращает
 * `{ descriptions: Map(id → текст), error? }`, а что с ними делать (вектор, сохранение, защита ручных правок) решает Модуль.
 *
 * Не вышла первая пачка (модель не подключена, отказ) — остальные не пробуем: тот же отказ. Не вышла поздняя — уже полученное остаётся, `error` описывает обрыв.
 */

const MAX_TOKENS_PER_TRACK = 110;

export async function tagWithModel({ host, items, onProgress = () => {} }) {
    const descriptions = new Map();
    let done = 0;
    for (const batch of batchTracks(items)) {
        const reply = await request(host.cores, 'model.generate', {
            params: {
                systemPrompt: TAGGING_INSTRUCTION, prompt: buildTaggingPrompt(batch),
                temperature: 0.3, maxTokens: 200 + batch.length * MAX_TOKENS_PER_TRACK, stream: false, reasoningMode: 'disabled',
            },
        });
        if (!reply.ok) return { descriptions, error: reply.error?.message ?? 'The model did not answer.' };
        parseTaggingReply(reply.value, batch.length).forEach((text, index) => { if (text) descriptions.set(batch[index].id, text); });
        done += batch.length;
        onProgress({ done, total: items.length });
    }
    return { descriptions };
}
