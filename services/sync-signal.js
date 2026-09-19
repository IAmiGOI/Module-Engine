/**
 * Сервис канала сигналов синхронизации — «доска объявлений», через которую два устройства находят друг друга и обмениваются
 * данными для установки прямого соединения (WebRTC). Файлы через неё НЕ идут: только короткие зашифрованные конверты (их шифрует
 * Ядро, см. [sync-secrets.js](../libraries/core/sync-secrets.js)), так что сам сервис доски ничего прочитать не может.
 *
 * Реализация — публичный ntfy (`https://ntfy.sh` по умолчанию, адрес настраивается: можно свой сервер): публикация — обычный
 * POST в тему, подписка — потоковый GET `/<тема>/json`, по строке на событие. Тема выводится из секрета пары и ничего не выдаёт.
 * Обрыв потока переподключается с нарастающей паузой.
 *
 * Живёт на сетевой Шине (как `http.request`): выход в интернет проходит сетевой Гейт, дать его можно только Ядру с правом
 * `networkAccess`.
 */

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000];

export function registerSyncSignalService(networkBus, {
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    backoff = DEFAULT_BACKOFF,
} = {}) {
    const subscriptions = new Map();   // id -> { abort, timer, stopped }
    let nextId = 1;

    async function publish({ server, topic, lines } = {}) {
        for (const line of lines ?? []) {
            const response = await fetchImpl(`${server}/${topic}`, { method: 'POST', body: line });
            if (!response.ok) throw new Error(`signal publish: HTTP ${response.status}`);
        }
        return true;
    }

    function subscribe({ server, topic, since = '1m', handler, onState = () => {} } = {}) {
        const id = nextId; nextId += 1;
        const entry = { controller: null, timer: null, stopped: false, attempt: 0, since };
        subscriptions.set(id, entry);

        async function run() {
            if (entry.stopped) return;
            entry.controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            try {
                const response = await fetchImpl(`${server}/${topic}/json?since=${encodeURIComponent(entry.since)}`, { signal: entry.controller?.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                entry.attempt = 0;
                onState('connected');
                await readLines(response, line => {
                    let event;
                    try { event = JSON.parse(line); } catch { return; }
                    if (event?.event === 'message' && typeof event.message === 'string') {
                        entry.since = String(event.time ?? entry.since);   // после переподключения не читаем уже виденное
                        handler?.(event.message);
                    }
                });
            } catch (error) {
                if (entry.stopped) return;
                onState('error', error?.message);
            }
            if (entry.stopped) return;
            onState('reconnecting');
            const delay = backoff[Math.min(entry.attempt, backoff.length - 1)];
            entry.attempt += 1;
            entry.timer = setTimer(run, delay);
        }
        run();
        return { id };
    }

    function unsubscribe({ id } = {}) {
        const entry = subscriptions.get(id);
        if (!entry) return false;
        entry.stopped = true;
        clearTimer(entry.timer);
        entry.controller?.abort();
        subscriptions.delete(id);
        return true;
    }

    const unregisters = [
        networkBus.register('syncSignal.publish', params => publish(params), { loadMetric: () => 0 }),
        networkBus.register('syncSignal.subscribe', params => subscribe(params), { loadMetric: () => 0 }),
        networkBus.register('syncSignal.unsubscribe', params => unsubscribe(params), { loadMetric: () => 0 }),
    ];
    return () => { for (const id of [...subscriptions.keys()]) unsubscribe({ id }); for (const unregister of unregisters) unregister(); };
}

/** Читает потоковый ответ по строкам; без `response.body.getReader()` (тестовый двойник) — по целому тексту. */
async function readLines(response, onLine) {
    if (typeof response.body?.getReader !== 'function') {
        for (const line of (await response.text()).split('\n')) if (line.trim()) onLine(line);
        return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) onLine(line);
            newline = buffer.indexOf('\n');
        }
    }
    if (buffer.trim()) onLine(buffer.trim());
}
