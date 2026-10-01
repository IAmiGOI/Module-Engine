import path from 'node:path';
import { createApp, DEFAULT_LIMITS } from './app.js';
import { embedPassage } from './embed.js';

/**
 * Запуск: `ADMIN_TOKEN=... [READ_KEY=...] [PORT=8787] [LIMIT_CATALOG_PER_MIN=60 LIMIT_AUDIO_PER_MIN=90 LIMIT_AUDIO_BYTES_PER_SEC=2097152] [DATA_DIR=./data] node server.js`.
 * Модель эмбеддингов (~50 МБ) скачивается один раз при первой загрузке трека с тегом и кэшируется в `DATA_DIR/models`.
 */

const dir = path.resolve(process.env.DATA_DIR ?? './data');
const port = Number(process.env.PORT ?? 8787);

const server = await createApp({
    dir,
    adminToken: process.env.ADMIN_TOKEN,
    readKey: process.env.READ_KEY ?? '',
    legacyCatalog: process.env.LEGACY_CATALOG === '1',   // прежний режим: ME сам подбирает по векторам, которые сервер тогда обязан отдавать
    limits: {
        pickPerMinute: Number(process.env.LIMIT_PICK_PER_MIN ?? DEFAULT_LIMITS.pickPerMinute),
        catalogPerMinute: Number(process.env.LIMIT_CATALOG_PER_MIN ?? DEFAULT_LIMITS.catalogPerMinute),
        audioPerMinute: Number(process.env.LIMIT_AUDIO_PER_MIN ?? DEFAULT_LIMITS.audioPerMinute),
        audioBytesPerSecond: Number(process.env.LIMIT_AUDIO_BYTES_PER_SEC ?? DEFAULT_LIMITS.audioBytesPerSecond),
    },
    embed: text => embedPassage(text, { cacheDir: path.join(dir, 'models') }),
});
// Слушаем только локальный адрес: наружу сервер смотрит через Caddy с HTTPS (`HOST=0.0.0.0`, если прокси не нужен).
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`[music-server] http://localhost:${port}  данные: ${dir}${process.env.READ_KEY ? '  (чтение по ключу)' : '  (чтение открыто)'}`));
