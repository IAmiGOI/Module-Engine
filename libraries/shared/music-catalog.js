/**
 * Каталог музыкального сервера владельца (план: .hermes/plans/music-server.md). Чистые функции без сети и DOM: адреса и разбор ответов.
 *
 * Пользователь ME серверных треков не видит: у них нет имени, описания и тегов — только вектор (для подбора по сцене) и адрес аудио. Вектор считает сервер
 * той же моделью, что стоит в ME; ответ другой модели или другой длины отбрасывается целиком — косинус между разными моделями ничего не значит.
 */

import { SOURCE_KINDS } from './music-source.js';

export const SERVER_TRACK_PREFIX = 'srv_';

const trimSlash = url => String(url ?? '').trim().replace(/\/+$/, '');
const withKey = (url, key) => (key ? `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}` : url);

/** Сервер настроен, если есть http(s)-адрес. Пустой конфиг — функция выключена, в интерфейсе ничего не появляется. */
export function isServerConfigured(server) {
    return /^https?:\/\//i.test(trimSlash(server?.url));
}

export const sectionsUrl = ({ url, key }) => withKey(`${trimSlash(url)}/api/sections`, key);
export const sectionUrl = ({ url, key }, sectionId) => withKey(`${trimSlash(url)}/api/sections/${encodeURIComponent(sectionId)}`, key);
export const audioUrl = ({ url, key }, id, ext) => withKey(`${trimSlash(url)}/audio/${encodeURIComponent(id)}.${encodeURIComponent(ext)}`, key);

function parseJson(text) {
    try { return JSON.parse(String(text ?? '')); } catch { return null; }
}

/** Ответ несравним с моделью ME (другая модель или длина) → `null`. */
const compatible = (data, { model, dim }) => data && data.model === model && (dim === undefined || data.dim === dim);

/** Список разделов: `[{ id, name, tracks }]`, пустой раздел и мусор отбрасываются. `null` — ответ негоден. */
export function parseSections(text, { model }) {
    const data = parseJson(text);
    if (!data || data.model !== model || !Array.isArray(data.sections)) return null;
    return data.sections
        .filter(section => section && typeof section.id === 'string' && section.id && Number.isFinite(section.tracks) && section.tracks > 0)
        .map(section => ({ id: section.id, name: String(section.name ?? section.id), tracks: section.tracks }));
}

/**
 * Треки раздела → треки для подбора (`tracks.js`-форма): `source` — прямая ссылка, `server: true` отличает их от пользовательских (не сохраняются, не показываются).
 * Трек с битым вектором пропускается, остальные работают. `null` — раздел целиком негоден.
 */
export function parseSectionTracks(text, { server, sectionId, model, dim }) {
    const data = parseJson(text);
    if (!compatible(data, { model, dim }) || !Array.isArray(data.tracks)) return null;
    const tracks = [];
    for (const entry of data.tracks) {
        if (!entry || typeof entry.id !== 'string' || !/^[\w-]+$/.test(entry.id) || !/^[a-z0-9]{2,5}$/i.test(String(entry.ext ?? ''))) continue;
        if (!Array.isArray(entry.v) || entry.v.length !== dim || !entry.v.every(Number.isFinite)) continue;
        tracks.push({
            id: `${SERVER_TRACK_PREFIX}${sectionId}_${entry.id}`, name: '', description: '', vector: entry.v, playCount: 0,
            source: { kind: SOURCE_KINDS.URL, ref: audioUrl(server, entry.id, entry.ext) }, artist: '', tagged: 'manual', server: true,
        });
    }
    return { name: String(data.name ?? sectionId), tracks };
}

export const isServerTrack = track => track?.server === true;
