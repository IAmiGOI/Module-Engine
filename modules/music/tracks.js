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

/** Текст сцены: последние реплики (системные — мусор для атмосферы, выкидываем). */
export function buildSceneText(messages, limit) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => !message?.isSystem)
        .slice(-Math.max(1, limit))
        .map(message => String(message?.text ?? ''))
        .filter(Boolean)
        .join('\n')
        .trim();
}
