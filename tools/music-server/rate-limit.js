import { Transform } from 'node:stream';

/**
 * Лимиты для публичной части сервера (владелец: «просто лимит скорости»). Два слоя:
 *  - число запросов с одного адреса в минуту (каталог и аудио считаются отдельно) — обход каталога с сотнями запросов упирается в 429;
 *  - скорость отдачи одного аудиопотока в байтах/с — обычному плееру хватает с запасом (320 кбит/с = 40 КБ/с), а массовое скачивание становится медленным.
 * Состояние в памяти; владелец (токен) не ограничивается. Адрес клиента берётся из `X-Forwarded-For` только от своего прокси (Caddy на 127.0.0.1).
 */

const WINDOW_MS = 60_000;

export function createRateLimiter({ perMinute, now = () => Date.now() }) {
    const hits = new Map();   // ключ → метки времени внутри окна
    let lastSweep = now();

    /** `{ ok: true }` или `{ ok: false, retryAfter }` в секундах. */
    function take(key) {
        const time = now();
        if (time - lastSweep > WINDOW_MS) {   // редкая уборка, чтобы карта не росла от одноразовых адресов
            for (const [name, marks] of hits) if (!marks.length || time - marks[marks.length - 1] > WINDOW_MS) hits.delete(name);
            lastSweep = time;
        }
        const marks = (hits.get(key) ?? []).filter(mark => time - mark < WINDOW_MS);
        if (marks.length >= perMinute) {
            hits.set(key, marks);
            return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (time - marks[0])) / 1000)) };
        }
        marks.push(time);
        hits.set(key, marks);
        return { ok: true };
    }
    return { take };
}

/** Адрес клиента: за своим прокси — первый адрес из `X-Forwarded-For`, иначе адрес соединения. */
export function clientAddress(req) {
    const direct = req.socket.remoteAddress ?? 'unknown';
    const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
    return local ? (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || direct) : direct;
}

/** Пропускает байты не быстрее `bytesPerSecond`: куски отдаются порциями по 100 мс. */
export function throttle(bytesPerSecond) {
    const slice = Math.max(1, Math.floor(bytesPerSecond / 10));
    return new Transform({
        transform(chunk, _encoding, done) {
            let offset = 0;
            const push = () => {
                if (offset >= chunk.length) return done();
                this.push(chunk.subarray(offset, offset + slice));
                offset += slice;
                setTimeout(push, 100);
            };
            push();
        },
    });
}
