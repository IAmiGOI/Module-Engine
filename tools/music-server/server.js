import path from 'node:path';
import { createApp } from './app.js';
import { embedPassage } from './embed.js';

/**
 * Запуск: `ADMIN_TOKEN=... [READ_KEY=...] [PORT=8787] [DATA_DIR=./data] node server.js`.
 * Модель эмбеддингов (~50 МБ) скачивается один раз при первой загрузке трека с тегом и кэшируется в `DATA_DIR/models`.
 */

const dir = path.resolve(process.env.DATA_DIR ?? './data');
const port = Number(process.env.PORT ?? 8787);

const server = await createApp({
    dir,
    adminToken: process.env.ADMIN_TOKEN,
    readKey: process.env.READ_KEY ?? '',
    embed: text => embedPassage(text, { cacheDir: path.join(dir, 'models') }),
});
// Слушаем только локальный адрес: наружу сервер смотрит через Caddy с HTTPS (`HOST=0.0.0.0`, если прокси не нужен).
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`[music-server] http://localhost:${port}  данные: ${dir}${process.env.READ_KEY ? '  (чтение по ключу)' : '  (чтение открыто)'}`));
