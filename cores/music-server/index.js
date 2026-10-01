import { request } from '../../libraries/shared/request.js';
import { EMBEDDING_MODEL_ID } from '../../libraries/core/embedding.js';
import { isServerConfigured, sectionsUrl, sectionUrl, pickUrl, parseSections, parseSectionTracks, parsePick } from '../../libraries/shared/music-catalog.js';

/**
 * Ядро музыкального сервера: единственное место, где Music ходит в сеть (Модуль — сообщество, `http.request` ему закрыт). Читает разделы и векторы треков раздела
 * с сервера владельца (адрес в конфиге сборки, `harness/engine-wiring.js`); аудио потом тянет сам плеер по прямой ссылке. Никогда не бросает: нет сети, чужая модель,
 * мусорный ответ — `{ ok: false, reason }`, и Music тихо играет только то, что есть у пользователя. Ответы живут в памяти до перезагрузки (владелец: без кэша на диске).
 */

const TIMEOUT_MS = 20000;
const VECTOR_DIM = 384;   // multilingual-e5-small

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
    async function pick({ section: id, vector, current = null, ended = false, force = false, minSimilarity, switchMargin } = {}) {
        const sectionId = String(id ?? '');
        if (!isServerConfigured(server) || !sectionId) return { action: 'none' };
        const body = JSON.stringify({ section: sectionId, vector, current, ended, force, minSimilarity, switchMargin });
        const result = await request(host.network, 'http.request', { params: { url: pickUrl(server), method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, timeoutMs });
        return result.ok && result.value?.ok ? parsePick(result.value.text, { server, sectionId }) : { action: 'none' };
    }

    const unregisters = [
        host.own.register('musicServer.pick', params => pick(params)),
        host.own.register('musicServer.sections', params => sections(params)),
        host.own.register('musicServer.section', params => section(params)),
    ];
    return { sections, section, pick, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
