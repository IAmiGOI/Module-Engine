import { buildCallRecord, filterCalls, summarize, toCsv, priceTable, statistics, timeSeries, latencyBy, bucketFor, detectCacheMiss, appendRing } from '../../libraries/core/telemetry.js';
import { request } from '../../libraries/shared/request.js';

const PRICES_KEY = 'openrouter-prices';
const PRICES_TTL_MS = 24 * 60 * 60 * 1000;
const PRICES_URL = 'https://openrouter.ai/api/v1/models';
const CHAT_TTL_MS = 30 * 1000;
const FEED_LIMIT = 500;
const RECENT_LIMIT = 300;
const ALERTS_LIMIT = 200;
const ALERT_QUIET_MS = 5 * 60e3;

/**
 * Ядро телеметрии: ловит события вызовов (`model.generate.telemetry` от ядра моделей, `classifier.telemetry` от
 * классификатора), дописывает цену по таблице OpenRouter, когда провайдер её не отдал, и пишет запись в хранилище
 * (сервис `telemetry.*`). Ошибка телеметрии никогда не ломает вызов: всё в try/catch, событие уже случилось.
 * Наружу — выборка ленты и сводки для вкладки Telemetry в The Court.
 */
export function createTelemetryCore(host, { publish = () => {}, now = () => Date.now() } = {}) {
    const callService = (contract, params) => request(host.services, contract, { params }).then(result => (result.ok ? result.value : null)).catch(() => null);
    let prices = null;
    let pricesAt = 0;
    let pricesLoading = null;
    let chat = { id: '', at: 0 };
    // Недавние вызовы — в памяти, для поиска промаха кеша без чтения всей базы на каждый вызов.
    let recent = null;
    const lastAlert = new Map();
    const notify = (tone, text) => { request(host.own, 'ui.notify', { params: { tone, text } }).catch(() => {}); };

    async function settings() {
        return { alerts: true, ...((await callService('telemetry.kv.get', { key: 'settings' })) ?? {}) };
    }

    async function checkCacheMiss(entry) {
        if (!recent) recent = ((await callService('telemetry.list')) ?? []).slice(-RECENT_LIMIT);
        const miss = detectCacheMiss(recent, entry);
        recent = appendRing(recent, [entry], RECENT_LIMIT);
        if (!miss) return;
        const alerts = (await callService('telemetry.kv.get', { key: 'alerts' })) ?? [];
        await callService('telemetry.kv.set', { key: 'alerts', value: appendRing(alerts, [miss], ALERTS_LIMIT) });
        publish('telemetry.cacheMiss', miss);
        const key = `${miss.purpose}|${miss.model}`;
        if (!(await settings()).alerts || now() - (lastAlert.get(key) ?? 0) < ALERT_QUIET_MS) return;
        lastAlert.set(key, now());
        notify('warning', `Cache miss: ${miss.purpose} on ${miss.model} sent ${Math.round(miss.lostTokens / 1000)}k tokens without cache (it had ${Math.round((miss.wasRate ?? 0) * 100)}% cached ${Math.round(miss.sinceMs / 60000)} min ago).`);
    }

    async function loadPrices() {
        if (prices && now() - pricesAt < PRICES_TTL_MS) return prices;
        if (pricesLoading) return pricesLoading;
        pricesLoading = (async () => {
            const stored = await callService('telemetry.kv.get', { key: PRICES_KEY });
            if (stored?.table && now() - Number(stored.at) < PRICES_TTL_MS) {
                prices = stored.table; pricesAt = Number(stored.at);
                return prices;
            }
            try {
                const result = await request(host.network, 'http.request', { params: { url: PRICES_URL, method: 'GET' }, timeoutMs: 15000 });
                const body = result.ok ? JSON.parse(result.value?.text ?? 'null') : null;
                const table = priceTable(body);
                if (Object.keys(table).length) {
                    prices = table; pricesAt = now();
                    await callService('telemetry.kv.set', { key: PRICES_KEY, value: { at: pricesAt, table } });
                }
            } catch { /* без таблицы цена остаётся «неизвестна» */ }
            return prices ?? {};
        })().finally(() => { pricesLoading = null; });
        return pricesLoading;
    }

    async function chatId() {
        if (chat.id && now() - chat.at < CHAT_TTL_MS) return chat.id;
        const value = await callService('stChat.chatId');
        chat = { id: String(value ?? ''), at: now() };
        return chat.id;
    }

    async function record(kind, payload) {
        try {
            const table = /openrouter\.ai/i.test(String(payload?.endpoint ?? '')) ? await loadPrices() : {};
            const entry = buildCallRecord({ ...payload, kind, price: table?.[String(payload?.model ?? '')] ?? null, chatId: payload?.chatId || await chatId() });
            await callService('telemetry.append', { records: [entry] });
            await checkCacheMiss(entry);
        } catch { /* телеметрия не ломает ход */ }
    }

    async function query(params = {}) {
        const all = (await callService('telemetry.list')) ?? [];
        const calls = filterCalls(all, params.filters ?? {});
        const by = String(params.by ?? 'purpose');
        const from = Number(params.filters?.from) || 0;
        const bucketMs = bucketFor(from ? now() - from : 0);
        const alerts = ((await callService('telemetry.kv.get', { key: 'alerts' })) ?? []).filter(alert => !from || alert.at >= from).reverse();
        return {
            stats: statistics(calls),
            charts: {
                bucketMs,
                cost: timeSeries(calls, { bucketMs, from, to: now(), metric: 'cost' }),
                calls: timeSeries(calls, { bucketMs, from, to: now(), metric: 'calls' }),
                tokens: timeSeries(calls, { bucketMs, from, to: now(), metric: 'tokens' }),
                cache: timeSeries(calls, { bucketMs, from, to: now(), metric: 'cache' }),
                latency: latencyBy(calls),
            },
            alerts,
            settings: await settings(),
            total: summarize(calls, 'total')[0] ?? null,
            summary: summarize(calls, by),
            calls: calls.slice(-Math.max(1, Number(params.limit) || FEED_LIMIT)).reverse(),
            options: {
                purposes: [...new Set(all.map(r => r.purpose || r.caller).filter(Boolean))].sort(),
                models: [...new Set(all.map(r => r.model).filter(Boolean))].sort(),
                chats: [...new Set(all.map(r => r.chatId).filter(Boolean))].sort(),
            },
            days: (await callService('telemetry.days')) ?? {},
            count: all.length,
        };
    }

    async function exportCalls(params = {}) {
        const calls = filterCalls((await callService('telemetry.list')) ?? [], params.filters ?? {});
        return params.format === 'json' ? JSON.stringify(calls, null, 1) : toCsv(calls);
    }

    const subscriptions = [
        host.events.subscribe('model.generate.telemetry', payload => { record('model', payload); }),
        host.events.subscribe('classifier.telemetry', payload => { record('classifier', payload); }),
    ];
    const unregisters = [
        host.own.register('telemetry.query', params => query(params ?? {})),
        host.own.register('telemetry.export', params => exportCalls(params ?? {})),
        host.own.register('telemetry.reset', async () => { recent = null; await callService('telemetry.kv.set', { key: 'alerts', value: [] }); return callService('telemetry.clear'); }),
        host.own.register('telemetry.settings.set', async params => {
            const next = { ...(await settings()), ...(params && typeof params === 'object' ? params : {}) };
            await callService('telemetry.kv.set', { key: 'settings', value: next });
            return next;
        }),
    ];
    return {
        record, query,
        unregister: () => { for (const off of [...subscriptions, ...unregisters]) off?.(); },
    };
}
