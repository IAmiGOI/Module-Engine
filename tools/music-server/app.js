import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { openStore, HttpError, AUDIO_EXT } from './store.js';
import { MODEL_ID, DIM } from './embed.js';
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
export const DEFAULT_LIMITS = Object.freeze({ catalogPerMinute: 60, audioPerMinute: 90, audioBytesPerSecond: 2 * 1024 * 1024 });

export async function createApp({ dir, embed, adminToken, readKey = '', maxUpload = DEFAULT_MAX_UPLOAD, limits = DEFAULT_LIMITS }) {
    if (!adminToken) throw new Error('ADMIN_TOKEN обязателен: без него консоль была бы открыта всем');
    const store = await openStore({ dir, embed });
    const tmpDir = path.join(dir, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });

    const catalogLimiter = limits.catalogPerMinute > 0 ? createRateLimiter({ perMinute: limits.catalogPerMinute }) : null;
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
            return await store.addTrack({ sectionId: url.searchParams.get('section'), title: url.searchParams.get('title'), description: url.searchParams.get('description'), ext, tmpFile });
        } catch (error) {
            await fsp.rm(tmpFile, { force: true });
            throw error;
        }
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
            if (!item || (!owner && !Array.isArray(item.vector)) || item.ext !== match[2].toLowerCase()) return sendJson(res, 404, { error: 'нет такого трека' });
            return sendFile(req, res, store.audioPath(item), item.ext, { bytesPerSecond: owner ? 0 : limits.audioBytesPerSecond });
        }

        if (method === 'GET' && parts[0] === 'api' && parts[1] === 'sections') {
            if (limited(req, res, catalogLimiter)) return;
            if (!readAllowed(url)) return sendJson(res, 401, { error: 'нет доступа' });
            if (parts.length === 2) return sendJson(res, 200, { model: MODEL_ID, dim: DIM, sections: store.publicSections() });
            const found = store.publicSection(decodeURIComponent(parts[2]));
            return found ? sendJson(res, 200, { model: MODEL_ID, dim: DIM, ...found }) : sendJson(res, 404, { error: 'нет такого раздела' });
        }

        if (parts[0] === 'api' && parts[1] === 'admin') {
            if (!adminAllowed(req)) return sendJson(res, 401, { error: 'неверный токен' });
            const [, , what, id] = parts;
            if (what === 'catalog' && method === 'GET') return sendJson(res, 200, store.adminCatalog());
            if (what === 'sections') {
                if (method === 'POST') return sendJson(res, 201, await store.addSection((await readJson(req)).name));
                if (method === 'PATCH' && id) return sendJson(res, 200, await store.renameSection(id, (await readJson(req)).name));
                if (method === 'DELETE' && id) { await store.deleteSection(id); return sendJson(res, 200, { ok: true }); }
            }
            if (what === 'tracks') {
                if (method === 'POST' && !id) return sendJson(res, 201, await upload(req, url));
                if (method === 'PATCH' && id) return sendJson(res, 200, await store.updateTrack(id, await readJson(req)));
                if (method === 'DELETE' && id) { await store.deleteTrack(id); return sendJson(res, 200, { ok: true }); }
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
