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
    const validVector = vector => Array.isArray(vector) && vector.length === dim && vector.every(Number.isFinite);
    // Раздел «по группам»: вектор один на группу, у трека только ссылка `g`. Для подбора каждый трек получает вектор своей группы — группа с лучшим счётом выигрывает целиком, а трек внутри неё выбирается по очереди.
    const groups = new Map((Array.isArray(data.groups) ? data.groups : [])
        .filter(group => group && typeof group.id === 'string' && /^[\w-]+$/.test(group.id) && validVector(group.v))
        .map(group => [group.id, group.v]));
    const tracks = [];
    for (const entry of data.tracks) {
        if (!entry || typeof entry.id !== 'string' || !/^[\w-]+$/.test(entry.id) || !/^[a-z0-9]{2,5}$/i.test(String(entry.ext ?? ''))) continue;
        const grouped = entry.g !== undefined;
        const vector = grouped ? groups.get(entry.g) : entry.v;
        if (!validVector(vector)) continue;
        tracks.push({
            id: `${SERVER_TRACK_PREFIX}${sectionId}_${entry.id}`, name: '', description: '', vector, playCount: 0,
            source: { kind: SOURCE_KINDS.URL, ref: audioUrl(server, entry.id, entry.ext) }, artist: '', tagged: 'manual', server: true,
            ...(grouped ? { group: `${sectionId}_${entry.g}` } : {}),
        });
    }
    return { name: String(data.name ?? sectionId), tracks };
}

export const pickUrl = ({ url, key }) => withKey(`${trimSlash(url)}/api/pick`, key);
export const feedbackUrl = ({ url, key }) => withKey(`${trimSlash(url)}/api/feedback`, key);
export const choicesUrl = ({ url, key }, sectionId) => withKey(`${trimSlash(url)}/api/choices?section=${encodeURIComponent(sectionId)}`, key);

/**
 * Варианты «нужной музыки» раздела: `[{ id, label }]` (только то, что показывает сервер). Мусор, чужая модель или пустой список — пустой массив: кнопка выбора просто не появится.
 */
export function parseChoices(text, { model } = {}) {
    let data;
    try { data = JSON.parse(text); } catch { return []; }
    if (!data || typeof data !== 'object' || (model && data.model !== model) || !Array.isArray(data.choices)) return [];
    const seen = new Set();
    const list = [];
    for (const item of data.choices) {
        const id = typeof item?.id === 'string' ? item.id.trim() : '';
        const label = typeof item?.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
        if (!id || id.length > 64 || !label || seen.has(id)) continue;
        seen.add(id); list.push({ id, label });
        if (list.length >= 40) break;
    }
    return list;
}

/** Трек, который выбрал сервер: у ME нет о нём ничего, кроме id и адреса аудио. `rawId` нужен, чтобы сказать серверу, что сейчас играет. */
export const serverTrackFrom = ({ server, sectionId, id, ext }) => ({
    id: `${SERVER_TRACK_PREFIX}${sectionId}_${id}`, rawId: id, name: '', description: '', vector: null, playCount: 0,
    source: { kind: SOURCE_KINDS.URL, ref: audioUrl(server, id, ext) }, artist: '', tagged: 'manual', server: true,
});

const MAX_QUESTIONS = 12, MAX_QUESTION_LENGTH = 400;

/**
 * Ответ сервера на выбор → `{ action: 'play' | 'keep' | 'none' | 'ask', track?, similarity?, intensity?, questions? }`; мусор и недопустимые id — `none`.
 * `ask` — сервер просит спросить Jev: `questions` = `{ id: утверждение }` (чужой текст ограничен по числу и длине — это данные, не команды).
 */
export function parsePick(text, { server, sectionId }) {
    const data = parseJson(text);
    const intensity = Number.isFinite(data?.intensity) ? data.intensity : null;
    const pattern = /^[\w-]+$/.test(String(data?.pattern ?? '')) ? String(data.pattern) : null;   // узел паттерна, который играет: ME лишь возвращает его серверу
    if (data?.action === 'keep') return { action: 'keep', intensity, pattern };
    if (data?.action === 'ask' && data.questions && typeof data.questions === 'object') {
        const questions = Object.fromEntries(Object.entries(data.questions)
            .filter(([id, statement]) => /^[ci]\d{1,2}$/.test(id) && typeof statement === 'string' && statement.trim())
            .slice(0, MAX_QUESTIONS).map(([id, statement]) => [id, statement.slice(0, MAX_QUESTION_LENGTH)]));
        return Object.keys(questions).length ? { action: 'ask', questions } : { action: 'none' };
    }
    if (data?.action === 'play' && /^[\w-]+$/.test(String(data.id)) && /^[a-z0-9]{2,5}$/i.test(String(data.ext))) {
        return { action: 'play', intensity, pattern, similarity: Number.isFinite(data.similarity) ? data.similarity : null, track: serverTrackFrom({ server, sectionId, id: data.id, ext: data.ext }) };
    }
    return { action: 'none' };
}

export const isServerTrack = track => track?.server === true;
