import { buildCallRecord, filterCalls, summarize, toCsv, priceTable } from '../../libraries/core/telemetry.js';
import { request } from '../../libraries/shared/request.js';

const PRICES_KEY = 'openrouter-prices';
const PRICES_TTL_MS = 24 * 60 * 60 * 1000;
const PRICES_URL = 'https://openrouter.ai/api/v1/models';
const CHAT_TTL_MS = 30 * 1000;
const FEED_LIMIT = 500;

/**
 * Ядро телеметрии: ловит события вызовов (`model.generate.telemetry` от ядра моделей, `classifier.telemetry` от
 * классификатора), дописывает цену по таблице OpenRouter, когда провайдер её не отдал, и пишет запись в хранилище
 * (сервис `telemetry.*`). Ошибка телеметрии никогда не ломает вызов: всё в try/catch, событие уже случилось.
 * Наружу — выборка ленты и сводки для вкладки Telemetry в The Court.
 */
export function createTelemetryCore(host, { now = () => Date.now() } = {}) {
    const callService = (contract, params) => request(host.services, contract, { params }).then(result => (result.ok ? result.value : null)).catch(() => null);
    let prices = null;
    let pricesAt = 0;
    let pricesLoading = null;
    let chat = { id: '', at: 0 };

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
        } catch { /* телеметрия не ломает ход */ }
    }

    async function query(params = {}) {
        const all = (await callService('telemetry.list')) ?? [];
        const calls = filterCalls(all, params.filters ?? {});
        const by = String(params.by ?? 'purpose');
        return {
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
        host.own.register('telemetry.reset', () => callService('telemetry.clear')),
    ];
    return {
        record, query,
        unregister: () => { for (const off of [...subscriptions, ...unregisters]) off?.(); },
    };
}
