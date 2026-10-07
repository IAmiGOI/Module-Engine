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
export const placesUrl = ({ url, key }) => withKey(`${trimSlash(url)}/api/places`, key);
export const timesUrl = ({ url, key }) => withKey(`${trimSlash(url)}/api/times`, key);

const MAX_PLACES = 500, MAX_PLACE_KEYWORDS = 60, MAX_KEYWORD_LENGTH = 80;

/**
 * Реестр мест сервера: `[{ id, keywords }]`. Слова ищет ME в тексте чата сам и серверу шлёт только счётчики (текст не уходит). Чужая модель, мусор или неверная форма — пустой массив:
 * без реестра подбор просто идёт без мест. Повторный id и места без слов пропускаются.
 */
export function parsePlaces(text, { model } = {}) {
    const data = parseJson(text);
    if (!data || typeof data !== 'object' || (model && data.model !== model) || !Array.isArray(data.places)) return [];
    const seen = new Set();
    const list = [];
    for (const item of data.places) {
        const id = typeof item?.id === 'string' ? item.id : '';
        if (!/^[\w-]+$/.test(id) || seen.has(id) || !Array.isArray(item.keywords)) continue;
        const keywords = item.keywords
            .filter(word => typeof word === 'string' && word.trim() && word.length <= MAX_KEYWORD_LENGTH)
            .slice(0, MAX_PLACE_KEYWORDS);
        if (!keywords.length) continue;
        seen.add(id); list.push({ id, keywords });
        if (list.length >= MAX_PLACES) break;
    }
    return list;
}

const MAX_TIME_SLOTS = 8, MAX_TIME_KEYWORDS = 80;

/**
 * Реестр времени суток сервера: `[{ id: 0..7, keywords }]` (id — номер трёхчасового слота). Чужая модель, мусор или неверная форма — пустой массив: подбор идёт без догадки по словам.
 */
export function parseTimes(text, { model } = {}) {
    const data = parseJson(text);
    if (!data || typeof data !== 'object' || (model && data.model !== model) || !Array.isArray(data.slots)) return [];
    const seen = new Set();
    const list = [];
    for (const item of data.slots) {
        const id = item?.id;
        if (!Number.isInteger(id) || id < 0 || id >= MAX_TIME_SLOTS || seen.has(id) || !Array.isArray(item.keywords)) continue;
        const keywords = item.keywords
            .filter(word => typeof word === 'string' && word.trim() && word.length <= MAX_KEYWORD_LENGTH)
            .slice(0, MAX_TIME_KEYWORDS);
        if (!keywords.length) continue;
        seen.add(id); list.push({ id, keywords });
        if (list.length >= MAX_TIME_SLOTS) break;
    }
    return list;
}

// Часы и периоды RP Time живут в общем файле сцены (его же использует симулятор на сервере).
export { slotOfHour, parseClockHour, slotOfPeriod } from './music-scene.js';

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
/** План перехода от сервера (доли, бас-своп): только числа в разумных пределах, иначе `null` — ME делает обычный кроссфейд. */
export function cleanTransition(raw) {
    if (!raw || typeof raw !== 'object' || (raw.kind !== 'beat' && raw.kind !== 'plain')) return null;
    const within = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
    if (!within(raw.outAt, 0, 7200) || !within(raw.fadeSec, 0.5, 30)) return null;
    return { kind: raw.kind, outAt: raw.outAt, fadeSec: raw.fadeSec, bassSwapAt: within(raw.bassSwapAt, 0, 30) ? raw.bassSwapAt : null, rate: within(raw.rate, 0.8, 1.25) ? raw.rate : 1 };
}

export function parsePick(text, { server, sectionId }) {
    const data = parseJson(text);
    const intensity = Number.isFinite(data?.intensity) ? data.intensity : null;
    const pattern = /^[\w-]+$/.test(String(data?.pattern ?? '')) ? String(data.pattern) : null;   // узел паттерна, который играет: ME лишь возвращает его серверу
    const place = typeof data?.place === 'string' && /^[\w-]+$/.test(data.place) ? { place: data.place } : {};   // место, которое определил сервер: ME лишь возвращает его в следующем запросе
    if (data?.action === 'keep') return { action: 'keep', intensity, pattern, ...place };
    if (data?.action === 'ask' && data.questions && typeof data.questions === 'object') {
        const questions = Object.fromEntries(Object.entries(data.questions)
            .filter(([id, statement]) => /^[ci]\d{1,2}$/.test(id) && typeof statement === 'string' && statement.trim())
            .slice(0, MAX_QUESTIONS).map(([id, statement]) => [id, statement.slice(0, MAX_QUESTION_LENGTH)]));
        return Object.keys(questions).length ? { action: 'ask', questions } : { action: 'none' };
    }
    if (data?.action === 'play' && /^[\w-]+$/.test(String(data.id)) && /^[a-z0-9]{2,5}$/i.test(String(data.ext))) {
        const transition = cleanTransition(data.transition);
        return { action: 'play', intensity, pattern, ...place, ...(transition ? { transition } : {}), similarity: Number.isFinite(data.similarity) ? data.similarity : null, track: serverTrackFrom({ server, sectionId, id: data.id, ext: data.ext }) };
    }
    return { action: 'none' };
}

export const isServerTrack = track => track?.server === true;
