import { sanitizeSource } from '../../libraries/shared/music-source.js';
import { sanitizeTagKind } from '../../libraries/shared/music-tagging.js';

/** Данные Модуля Music без замыканий: настройки по умолчанию, нормализация списка треков, текст сцены. Отдельный файл — чтобы `index.js` держал только поведение. */

export const DEFAULTS = Object.freeze({
    autoSwitch: true,     // менять трек по сцене или только вручную
    contextMessages: 4,   // сколько последних реплик складывать в вектор сцены
    minSimilarity: 0.55,  // ниже — «ничего не подходит», играем дальше
    switchMargin: 0.05,   // насколько кандидат должен быть лучше играющего
    volume: 0.7,
    smart: true,          // умное определение сцены через Jev (если подключён); частоту и набор категорий задаёт сервер
    autoTag: true,        // размечать новые треки моделью сразу после импорта
    player: {},           // позиция/размер/свёрнутость FloatingPanel
});

/** Строгая нормализация списка треков из стора — мусор из JSON не должен доходить до плеера. */
export function sanitizeTracks(tracks) {
    if (!Array.isArray(tracks)) return [];
    return tracks
        .filter(track => track && typeof track === 'object' && track.source?.kind !== 'youtube')   // записи прежней сборки с YouTube больше не играют — убираем
        .map((track, index) => ({
            id: String(track.id ?? `track_${index}`),
            name: String(track.name ?? 'Untitled'),
            description: String(track.description ?? ''),
            vector: Array.isArray(track.vector) ? track.vector : null,
            playCount: Number.isFinite(track.playCount) ? track.playCount : 0,
            source: sanitizeSource(track.source),   // откуда играть: свой файл (по умолчанию) или прямая ссылка
            artist: String(track.artist ?? ''),
            tagged: sanitizeTagKind(track.tagged), // чем размечен: названием / моделью / рукой (руку модель не перетирает)
        }));
}

/** Реплики сцены: последние `limit` не системных, непустые — по одной (свежие в конце). */
export function sceneMessages(messages, limit) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => !message?.isSystem)
        .slice(-Math.max(1, limit))
        .map(message => String(message?.text ?? ''))
        .filter(Boolean);
}

/** Имена участников сцены (героев и персоны пользователя) — их вычёркивают из текста перед эмбедингом: вектор должен нести настроение, а не имена. */
export function sceneNames(messages) {
    return [...new Set((Array.isArray(messages) ? messages : []).filter(message => !message?.isSystem).map(message => String(message?.name ?? '').trim()).filter(Boolean))];
}

/** Текст сцены: последние реплики (системные — мусор для атмосферы, выкидываем). */
export function buildSceneText(messages, limit) {
    return sceneMessages(messages, limit).join('\n').trim();
}

/**
 * Вектор сцены из векторов реплик: свежая реплика весит вдвое больше предыдущей (2^позиция), результат нормируется. Раньше реплики склеивались в один текст — длинное старое
 * сообщение с «военными» словами перевешивало короткую свежую реплику и тянуло музыку не туда.
 */
export function blendSceneVectors(vectors) {
    const usable = vectors.map((vector, index) => ({ vector, weight: 2 ** index })).filter(item => Array.isArray(item.vector) && item.vector.length);
    if (!usable.length) return null;
    const dim = usable[0].vector.length;
    const sum = Array(dim).fill(0);
    for (const { vector, weight } of usable) if (vector.length === dim) vector.forEach((x, i) => { sum[i] += x * weight; });
    const norm = Math.sqrt(sum.reduce((total, x) => total + x * x, 0));
    return norm > 0 ? sum.map(x => x / norm) : null;
}
