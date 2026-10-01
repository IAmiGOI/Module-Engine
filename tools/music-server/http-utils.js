import fs from 'node:fs';
import crypto from 'node:crypto';
import { HttpError } from './store.js';

/** Мелкие помощники HTTP: CORS, JSON, проверка ключей, отдача файла с Range (без Range перемотка в `<audio>` не работает). */

export const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
};

const MIME = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm' };

export function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
}

/** Сравнение секретов за постоянное время (длины хэшируются, чтобы не выдать длину ключа). */
export function sameSecret(given, expected) {
    const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest();
    return Boolean(expected) && crypto.timingSafeEqual(hash(given), hash(expected));
}

export async function readJson(req, limit = 1 << 20) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, 'слишком большое тело запроса');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'не JSON'); }
}

/** Файл целиком или кусок по `Range: bytes=a-b` (одиночный диапазон — больше плееру не нужно). */
export function sendFile(req, res, filePath, ext) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return sendJson(res, 404, { error: 'нет файла' }); }
    const headers = { ...CORS, 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (!range || (!range[1] && !range[2])) {
        res.writeHead(200, { ...headers, 'Content-Length': stat.size });
        return req.method === 'HEAD' ? res.end() : fs.createReadStream(filePath).pipe(res);
    }
    let start = range[1] === '' ? Math.max(0, stat.size - Number(range[2])) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? stat.size - 1 : Math.min(Number(range[2]), stat.size - 1);
    if (start > end || start >= stat.size) {
        res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${stat.size}` });
        return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(filePath, { start, end }).pipe(res);
}
