import { request } from '../../libraries/shared/request.js';
import { EMBEDDING_MODEL_ID } from '../../libraries/core/embedding.js';
import { isServerConfigured, sectionsUrl, sectionUrl, pickUrl, placesUrl, parsePlaces, timesUrl, parseTimes, parseSections, parseSectionTracks, parsePick } from '../../libraries/shared/music-catalog.js';

/**
 * Ядро музыкального сервера: единственное место, где Music ходит в сеть (Модуль — сообщество, `http.request` ему закрыт). Читает разделы и векторы треков раздела
 * с сервера владельца (адрес в конфиге сборки, `harness/engine-wiring.js`); аудио потом тянет сам плеер по прямой ссылке. Никогда не бросает: нет сети, чужая модель,
 * мусорный ответ — `{ ok: false, reason }`, и Music тихо играет только то, что есть у пользователя. Ответы живут в памяти до перезагрузки (владелец: без кэша на диске).
 */

const TIMEOUT_MS = 20000;
const VECTOR_DIM = 384;   // e5-small-v2

const ID_PATTERN = /^[\w-]+$/;

/** Счётчики мест для сервера: `{ id: целое > 0 }`, не больше 64 ключей. Всё остальное отбрасывается; нет ни одного — `null` (поле не отправляется). */
function cleanCounts(places) {
    if (!places || typeof places !== 'object' || Array.isArray(places)) return null;
    const entries = Object.entries(places).filter(([id, count]) => ID_PATTERN.test(id) && Number.isInteger(count) && count > 0).slice(0, 64);
    return entries.length ? Object.fromEntries(entries) : null;
}

export function createMusicServerCore(host, { server = {}, timeoutMs = TIMEOUT_MS, dim = VECTOR_DIM } = {}) {
    const model = EMBEDDING_MODEL_ID;
    const cache = new Map();

    async function fetchText(url) {
        const result = await request(host.network, 'http.request', { params: { url, method: 'GET' }, timeoutMs });
        if (!result.ok || !result.value?.ok) return { error: result.error?.message ?? `HTTP ${result.value?.status ?? '?'}` };
        return { text: result.value.text };
    }

    /** `{ configured, ok, sections: [{id, name, tracks}] }`. */
    async function sections({ force = false } = {}) {
        if (!isServerConfigured(server)) return { configured: false, ok: false, sections: [] };
        if (!force && cache.has('sections')) return cache.get('sections');
        const got = await fetchText(sectionsUrl(server));
        const parsed = got.text === undefined ? null : parseSections(got.text, { model });
        if (!parsed) return { configured: true, ok: false, reason: got.error ?? 'unreadable or incompatible catalog', sections: [] };
        const result = { configured: true, ok: true, sections: parsed };
        cache.set('sections', result);
        return result;
    }

    /** `{ ok, name, tracks }` — треки в форме подбора (вектор + ссылка на аудио), без имён и тегов. */
    async function section({ id, force = false } = {}) {
        const sectionId = String(id ?? '');
        if (!isServerConfigured(server) || !sectionId) return { ok: false, reason: 'no section', tracks: [] };
        const key = `section:${sectionId}`;
        if (!force && cache.has(key)) return cache.get(key);
        const got = await fetchText(sectionUrl(server, sectionId));
        const parsed = got.text === undefined ? null : parseSectionTracks(got.text, { server, sectionId, model, dim });
        if (!parsed) return { ok: false, reason: got.error ?? 'unreadable or incompatible section', tracks: [] };
        const result = { ok: true, name: parsed.name, tracks: parsed.tracks };
        cache.set(key, result);
        return result;
    }

    /**
     * Выбор трека делает сервер: ME присылает только вектор сцены (и что сейчас играет), в ответ — один трек или «оставь/ничего». `ended` — трек доиграл, `force` — кнопка «следующий».
     * Сбой сети — `none`: играющее продолжается.
     */
    async function pick({ section: id, vector, current = null, ended = false, force = false, minSimilarity, switchMargin, smart = false, answers = null, elapsed = null, remaining = null, lastIntensity = null, pattern = null, places = null, place = null, time = null } = {}) {
        const sectionId = String(id ?? '');
        if (!isServerConfigured(server) || !sectionId) return { action: 'none' };
        const counts = cleanCounts(places);
        const body = JSON.stringify({ model, section: sectionId, vector, current, ended, force, minSimilarity, switchMargin, smart, answers, elapsed, remaining, lastIntensity, pattern, ...(counts ? { places: counts } : {}), ...(typeof place === 'string' && ID_PATTERN.test(place) ? { place } : {}), ...(Number.isInteger(time) && time >= 0 && time <= 7 ? { time } : {}) });
        const result = await request(host.network, 'http.request', { params: { url: pickUrl(server), method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, timeoutMs });
        return result.ok && result.value?.ok ? parsePick(result.value.text, { server, sectionId }) : { action: 'none' };
    }


    /** Реестр мест сервера: `{ ok, places: [{ id, keywords }] }`. Сбой или чужая модель — `{ ok: false, places: [] }`; ответы в память не кладём (кэш держит Music). */
    async function places() {
        if (!isServerConfigured(server)) return { ok: false, places: [] };
        const got = await fetchText(placesUrl(server));
        if (got.text === undefined) return { ok: false, places: [] };
        const list = parsePlaces(got.text, { model });
        return { ok: list.length > 0, places: list };
    }

    /** Реестр времени суток сервера: `{ ok, slots: [{ id, keywords }] }`. Сбой или чужая модель — `{ ok: false, slots: [] }`. */
    async function times() {
        if (!isServerConfigured(server)) return { ok: false, slots: [] };
        const got = await fetchText(timesUrl(server));
        if (got.text === undefined) return { ok: false, slots: [] };
        const list = parseTimes(got.text, { model });
        return { ok: list.length > 0, slots: list };
    }

    const unregisters = [
        host.own.register('musicServer.times', () => times()),
        host.own.register('musicServer.places', () => places()),
        host.own.register('musicServer.pick', params => pick(params)),
        host.own.register('musicServer.sections', params => sections(params)),
        host.own.register('musicServer.section', params => section(params)),
    ];
    return { sections, section, pick, places, times, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
