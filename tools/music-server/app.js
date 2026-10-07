import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { openStore, HttpError, AUDIO_EXT } from './store.js';
import { MODEL_ID, DIM } from './embed.js';
import { pickTrack, scoreItems } from './pick.js';
import { decidePattern, explainPatterns } from './patterns.js';
import { shiftScene, shiftPrototypes } from './alignment.js';
import { CORS, sendJson, sendFile, readJson, sameSecret } from './http-utils.js';
import { createRateLimiter, clientAddress } from './rate-limit.js';

/**
 * HTTP-приложение музыкального сервера. Публичное (по ключу чтения, если задан): `/api/sections`, `/api/sections/:id`, `/audio/:id.:ext` — то, что читает ME.
 * Админское (токен владельца в `Authorization: Bearer`): `/api/admin/*` и консоль на `/`. Наружу из публичных ответов уходят только id, расширение и вектор —
 * ни названий треков, ни текста тегов.
 */

const CONSOLE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'console.html');
const DEFAULT_MAX_UPLOAD = 200 * 1024 * 1024;

/** Лимиты по умолчанию: каталог 60 запросов/мин, аудио 90 запросов/мин (плеер на одну смену трека делает несколько Range-запросов) и 2 МБ/с на поток; на адрес. 0 — без ограничения. */
export const DEFAULT_LIMITS = Object.freeze({ feedbackPerMinute: 20, pickPerMinute: 60, catalogPerMinute: 60, audioPerMinute: 90, audioBytesPerSecond: 2 * 1024 * 1024 });

export async function createApp({ dir, embed, embedQuery = embed, adminToken, readKey = '', maxUpload = DEFAULT_MAX_UPLOAD, limits = DEFAULT_LIMITS, legacyCatalog = false }) {
    if (!adminToken) throw new Error('ADMIN_TOKEN обязателен: без него консоль была бы открыта всем');
    const store = await openStore({ dir, embed, embedQuery });
    const tmpDir = path.join(dir, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });

    /** Сцена и эталоны (это тоже сцены) сдвигаются на разницу «регистров» сцена↔теги раздела (alignment.js): иначе «хабы» выигрывают где попало. Одно место для выбора и проверки. */
    function sceneFor(sectionId, vector, { align = true } = {}) {
        const alignment = align ? store.alignmentFor(sectionId) : null;
        return { alignment, vector: shiftScene(vector, alignment), prototypes: shiftPrototypes(store.prototypesFor(sectionId), alignment) };
    }

    const catalogLimiter = limits.catalogPerMinute > 0 ? createRateLimiter({ perMinute: limits.catalogPerMinute }) : null;
    const feedbackLimiter = (limits.feedbackPerMinute ?? DEFAULT_LIMITS.feedbackPerMinute) > 0 ? createRateLimiter({ perMinute: limits.feedbackPerMinute ?? DEFAULT_LIMITS.feedbackPerMinute }) : null;
    const pickLimiter = limits.pickPerMinute > 0 ? createRateLimiter({ perMinute: limits.pickPerMinute }) : null;
    const plays = new Map();   // сколько раз каждый трек выбирался (в памяти, до перезапуска): ротация внутри раздела
    const audioLimiter = limits.audioPerMinute > 0 ? createRateLimiter({ perMinute: limits.audioPerMinute }) : null;
    /** Владелец не ограничивается. Ответ 429 несёт `Retry-After`. */
    function limited(req, res, limiter) {
        if (!limiter || adminAllowed(req)) return false;
        const verdict = limiter.take(clientAddress(req));
        if (verdict.ok) return false;
        res.writeHead(429, { ...CORS, 'Retry-After': String(verdict.retryAfter), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'слишком много запросов' }));
        return true;
    }

    const readAllowed = url => !readKey || sameSecret(url.searchParams.get('k'), readKey);
    const adminAllowed = req => sameSecret(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1], adminToken);

    /** Загрузка: байты → временный файл рядом (тот же диск, rename атомарный), потом запись в каталог. Лимит режет поток на лету. */
    async function upload(req, url) {
        const ext = String(url.searchParams.get('ext') ?? '').replace(/^\./, '');
        if (!AUDIO_EXT.test(ext)) throw new HttpError(400, 'нужен аудиофайл: mp3, ogg, m4a, flac, wav…');
        const tmpFile = path.join(tmpDir, crypto.randomBytes(6).toString('hex'));
        let size = 0;
        const limit = async function* (source) {
            for await (const chunk of source) {
                size += chunk.length;
                if (size > maxUpload) throw new HttpError(413, 'файл слишком большой');
                yield chunk;
            }
        };
        try {
            await pipeline(req, limit, fs.createWriteStream(tmpFile));
            return await store.addTrack({ title: url.searchParams.get('title'), ext, tmpFile });
        } catch (error) {
            await fsp.rm(tmpFile, { force: true });
            throw error;
        }
    }

    /** Проверка подбора для владельца: сообщения → вектор сцены (как в ME, `query:`) → что выберет сервер и как расставлены кандидаты. Счётчики проигрываний не трогает. */
    async function preview(body) {
        const section = String(body.section ?? '');
        if (!store.hasSection(section)) throw new HttpError(404, 'нет такого раздела');
        const messages = (Array.isArray(body.messages) ? body.messages : [body.text]).map(text => String(text ?? '').trim()).filter(Boolean);
        if (!messages.length) throw new HttpError(400, 'вставьте хотя бы одно сообщение');
        const vector = await embedQuery(messages.join('\n'));
        // `rawOnly` — замер самого эмбеддинга (сравнение моделей): теги «не включать» не участвуют.
        const items = store.previewItems(section).map(item => (body.rawOnly ? { ...item, negVector: null } : item));
        const minSimilarity = Number.isFinite(body.minSimilarity) ? body.minSimilarity : undefined;
        const { alignment, vector: sceneVector, prototypes } = sceneFor(section, vector, { align: body.align !== false });   // как на настоящем выборе; `align: false` — сравнить «до»
        const picked = pickTrack({ items, vector: sceneVector, dim: DIM, minSimilarity, force: false, prototypes });
        // Кандидаты: в групповом разделе — по группам, иначе по трекам. `score` — оценка, по которой сервер решает (z при ≥3 разных векторах), `similarity` — сырой косинус.
        const { relative, rows } = scoreItems({ items, vector: sceneVector, prototypes });
        const byKey = new Map();
        for (const row of rows) {
            const key = row.item.group ?? row.item.id;
            const entry = byKey.get(key) ?? { groupId: row.item.group ?? null, label: row.item.groupName ?? row.item.title, group: Boolean(row.item.group), tracks: 0, score: row.value, similarity: row.cosine, penalty: row.penalty, vetoed: row.vetoed, gap: row.gap ?? null, proto: row.proto ?? null };
            entry.tracks += 1;
            byKey.set(key, entry);
        }
        const ranking = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 8);
        const chosen = picked.action === 'play' ? items.find(item => item.id === picked.id) : null;
        return { action: picked.action, aligned: Boolean(alignment), relative, similarity: picked.similarity ?? null, chosen: chosen ? { title: chosen.title, group: chosen.groupName } : null, ranking };
    }


    /** Что сделают паттерны раздела на сцене из сообщений (для редактора): войдёт ли паттерн и по какой ветке пойдёт. Ничего не меняет и не считает проигрываний. */
    async function patternPreview(body) {
        const section = String(body.section ?? '');
        if (!store.hasSection(section)) throw new HttpError(404, 'нет такого раздела');
        const messages = (Array.isArray(body.messages) ? body.messages : [body.text]).map(text => String(text ?? '').trim()).filter(Boolean);
        if (!messages.length) throw new HttpError(400, 'вставьте хотя бы одно сообщение');
        const { vector, prototypes } = sceneFor(section, await embedQuery(messages.join('\n')), { align: body.align !== false });
        const minSimilarity = Number.isFinite(body.minSimilarity) ? body.minSimilarity : undefined;
        return explainPatterns({ nodes: store.patternNodes(section), items: store.pickItems(section), vector, dim: DIM, minSimilarity, switchMargin: Number.isFinite(body.switchMargin) ? body.switchMargin : undefined, prototypes });
    }

    async function route(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);   // ['api','sections','fantasy']
        const method = req.method;

        if (method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

        if (method === 'GET' && parts.length === 0) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(await fsp.readFile(CONSOLE_FILE));
        }

        if ((method === 'GET' || method === 'HEAD') && parts[0] === 'audio' && parts.length === 2) {
            if (limited(req, res, audioLimiter)) return;
            const owner = adminAllowed(req);   // владелец слушает и неразмеченные треки (консоль передаёт токен заголовком)
            if (!owner && !readAllowed(url)) return sendJson(res, 401, { error: 'нет доступа' });
            const match = /^([\w-]+)\.([a-z0-9]+)$/i.exec(parts[1]);
            const item = match && store.track(match[1]);
            if (!item || (!owner && !store.isPlayable(item.id)) || item.ext !== match[2].toLowerCase()) return sendJson(res, 404, { error: 'нет такого трека' });
            return sendFile(req, res, store.audioPath(item), item.ext, { bytesPerSecond: owner ? 0 : limits.audioBytesPerSecond });
        }

        if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sections') {
            if (limited(req, res, catalogLimiter)) return;
            if (!readAllowed(url)) return sendJson(res, 401, { error: 'нет доступа' });
            if (parts.length === 2) return sendJson(res, 200, { model: MODEL_ID, dim: DIM, sections: store.publicSections() });
            if (!legacyCatalog) return sendJson(res, 404, { error: 'векторы не отдаются: подбор идёт на сервере' });   // прежний режим (подбор в ME) выключен
            const found = store.publicSection(decodeURIComponent(parts[2]));
            return found ? sendJson(res, 200, { model: MODEL_ID, dim: DIM, ...found }) : sendJson(res, 404, { error: 'нет такого раздела' });
        }

        if (method === 'POST' && parts[0] === 'api' && parts[1] === 'feedback' && parts.length === 2) {
            // Отметка «верно/неверно» из ME: только в очередь на проверку (см. store.addFeedback), поэтому ключа чтения достаточно, а частота ограничена.
            if (!readAllowed(url)) return sendJson(res, 401, { error: 'нет доступа' });
            if (limited(req, res, feedbackLimiter)) return;
            const body = await readJson(req, 64 * 1024);
            if (body.model !== MODEL_ID) return sendJson(res, 200, { ok: false, reason: 'model mismatch' });
            const queued = await store.addFeedback({ sectionId: String(body.section ?? ''), vector: body.vector, trackId: body.track, mark: body.mark, dim: DIM });
            return sendJson(res, 200, { ok: true, ...queued });
        }

        if (method === 'POST' && parts[0] === 'api' && parts[1] === 'pick') {
            if (!readAllowed(url)) return sendJson(res, 401, { error: 'нет доступа' });
            if (limited(req, res, pickLimiter)) return;
            const body = await readJson(req, 64 * 1024);
            // Вектор сцены обязан быть посчитан той же моделью, что и теги. Старые версии ME модель не присылали (и считали мультиязычной) — им молча «подобрать» нельзя.
            if (body.model !== MODEL_ID) return sendJson(res, 200, { action: 'none', reason: 'model mismatch' });
            if (!store.hasSection(String(body.section))) return sendJson(res, 404, { error: 'нет такого раздела' });
            const nodes = store.patternNodes(body.section);
            const finite = value => (Number.isFinite(value) ? value : null);
            const { vector: sceneVector, prototypes } = sceneFor(body.section, body.vector);
            const items = store.pickItems(body.section);
            // Паттерны (порядок групп/треков): входят в игру, ведут по веткам и сами отпускают; нет паттернов или он не уместен — обычный выбор ниже.
            const patterned = nodes.length ? decidePattern({ nodes, patternId: typeof body.pattern === 'string' ? body.pattern : null, tracks: store.patternTracks(body.section), items, vector: sceneVector, dim: DIM, currentId: body.current ?? null, ended: body.ended === true, force: body.force === true, minSimilarity: body.minSimilarity, switchMargin: body.switchMargin, prototypes, plays, elapsed: finite(body.elapsed), remaining: finite(body.remaining) }) : null;
            if (patterned) {
                if (patterned.action === 'play') { plays.set(patterned.id, (plays.get(patterned.id) ?? 0) + 1); plays.set(patterned.pattern, (plays.get(patterned.pattern) ?? 0) + 1); }
                return sendJson(res, 200, patterned);
            }
            const result = pickTrack({ prototypes, graph: store.graphOf(body.section), items, vector: sceneVector, dim: DIM, currentId: body.current ?? null, ended: body.ended === true, force: body.force === true, minSimilarity: body.minSimilarity, switchMargin: body.switchMargin, plays, smart: body.smart === true, answers: body.answers && typeof body.answers === 'object' ? body.answers : null, elapsed: Number.isFinite(body.elapsed) ? body.elapsed : null, remaining: Number.isFinite(body.remaining) ? body.remaining : null, lastIntensity: Number.isFinite(body.lastIntensity) ? body.lastIntensity : null });
            if (result.action === 'play') plays.set(result.id, (plays.get(result.id) ?? 0) + 1);
            return sendJson(res, 200, result);
        }

        if (parts[0] === 'api' && parts[1] === 'admin') {
            if (!adminAllowed(req)) return sendJson(res, 401, { error: 'неверный токен' });
            const [, , what, id] = parts;
            if (what === 'preview' && method === 'POST') return sendJson(res, 200, await preview(await readJson(req, 256 * 1024)));
            if (what === 'catalog' && method === 'GET') return sendJson(res, 200, store.adminCatalog());
            if (what === 'sections') {
                if (method === 'POST') { const body = await readJson(req); return sendJson(res, 201, await store.addSection(body.name, body.mode)); }
                if (method === 'PATCH' && id) {
                    const body = await readJson(req, 256 * 1024);
                    if (body.graph !== undefined) return sendJson(res, 200, await store.setGraph(id, body.graph));
                    if (body.alignStrength !== undefined) return sendJson(res, 200, await store.setAlignStrength(id, body.alignStrength));
                    return sendJson(res, 200, await store.renameSection(id, body.name));
                }
                if (method === 'DELETE' && id) { await store.deleteSection(id); return sendJson(res, 200, { ok: true }); }
            }
            if (what === 'examples') {
                if (method === 'POST' && !id) {
                    const body = await readJson(req, 1 << 20);
                    return sendJson(res, 201, await store.addExamples({ sectionId: body.section, groupId: body.group, texts: Array.isArray(body.texts) ? body.texts : [body.text], names: Array.isArray(body.names) ? body.names : [] }));
                }
                if (method === 'POST' && id === 'reclean') {
                    const body = await readJson(req, 64 * 1024);
                    return sendJson(res, 200, await store.recleanExamples({ sectionId: body.section, limit: body.limit, names: Array.isArray(body.names) ? body.names : [] }));
                }
                if (method === 'DELETE' && id) { await store.deleteExample(id); return sendJson(res, 200, { ok: true }); }
            }
            if (what === 'groups') {
                if (method === 'POST' && !id) { const body = await readJson(req); return sendJson(res, 201, await store.addGroup({ sectionId: body.section, name: body.name, description: body.description, negative: body.negative })); }
                if (method === 'PATCH' && id) return sendJson(res, 200, await store.updateGroup(id, await readJson(req)));
                if (method === 'DELETE' && id) { await store.deleteGroup(id); return sendJson(res, 200, { ok: true }); }
            }
            if (what === 'feedback') {
                if (method === 'POST' && id) { const body = await readJson(req, 16 * 1024); return sendJson(res, 200, await store.resolveFeedback(id, { group: body.group })); }
                if (method === 'DELETE' && id) { await store.dismissFeedback(id); return sendJson(res, 200, { ok: true }); }
            }
            if (what === 'patterns') {
                if (method === 'POST' && id === 'chain') { const body = await readJson(req, 64 * 1024); return sendJson(res, 201, await store.addPatternChain({ sectionId: body.section, parent: body.parent ?? null, steps: body.steps })); }
                if (method === 'POST' && id === 'preview') return sendJson(res, 200, await patternPreview(await readJson(req, 256 * 1024)));
                if (method === 'POST' && !id) { const body = await readJson(req, 64 * 1024); return sendJson(res, 201, await store.addPatternNode({ sectionId: body.section, parent: body.parent ?? null, kind: body.kind, ref: body.ref, name: body.name, description: body.description, negative: body.negative })); }
                if (method === 'PATCH' && id) return sendJson(res, 200, await store.updatePatternNode(id, await readJson(req, 64 * 1024)));
                if (method === 'DELETE' && id) return sendJson(res, 200, { ok: true, ...(await store.deletePatternNode(id)) });
            }
            if (what === 'tracks') {
                if (method === 'POST' && !id) return sendJson(res, 201, await upload(req, url));   // трек попадает в ПУЛ; раздел и группа назначаются отдельно
                if (method === 'PATCH' && id) return sendJson(res, 200, await store.updateTrack(id, await readJson(req)));
                if (method === 'DELETE' && id) { await store.deleteTrack(id); return sendJson(res, 200, { ok: true }); }
            }
            if (what === 'assignments') {
                if (method === 'POST' && id === 'bulk') { const body = await readJson(req, 128 * 1024); return sendJson(res, 201, await store.addAssignments({ trackIds: body.tracks, sectionId: body.section, groupId: body.group ?? null })); }
                if (method === 'POST' && !id) { const body = await readJson(req, 64 * 1024); return sendJson(res, 201, await store.addAssignment({ trackId: body.track, sectionId: body.section, groupId: body.group ?? null, description: body.description, negative: body.negative, intensity: body.intensity })); }
                if (method === 'PATCH' && id) return sendJson(res, 200, await store.updateAssignment(id, await readJson(req)));
                if (method === 'DELETE' && id) { await store.deleteAssignment(id); return sendJson(res, 200, { ok: true }); }
            }
        }
        return sendJson(res, 404, { error: 'не найдено' });
    }

    const server = http.createServer((req, res) => {
        route(req, res).catch(error => {
            if (res.headersSent) return res.destroy();
            if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
            console.error('[music-server]', error);
            return sendJson(res, 500, { error: 'ошибка сервера' });
        });
    });
    return server;
}
