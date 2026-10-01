import { computeDuckDuckGoResults, computeWikipediaResults, computeReadableText, computeMediaWikiParseUrls, computeMediaWikiText, isReadableWebUrl, DEFAULT_READ_CHARS } from '../libraries/core/web-text.js';

/**
 * Сервис поиска в сети — единственное место, которое ходит за страницами. Страницы отдаёт сервер SillyTavern (`/api/search/visit`): у браузера
 * нет права читать чужие сайты, а ключи платных поисковиков у пользователя не обязаны быть. Поиск: выдача DuckDuckGo через тот же эндпоинт; если она
 * пуста (DuckDuckGo нередко показывает серверам проверку), — API Википедии, которое браузеру разрешено напрямую.
 *
 * Контракты: `stWebSearch.search { query }` → `{ source, results: [{ title, url, snippet }] }`; `stWebSearch.read { url, maxChars? }` → `{ url, text }`.
 */
const SEARCH_PAGE = 'https://html.duckduckgo.com/html/?q=';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=';
const MAX_QUERY_LENGTH = 200;

export function registerStWebSearchService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    const buildHeaders = () => ({ 'Content-Type': 'application/json', ...(getContext()?.getRequestHeaders?.() ?? {}) });

    async function visitPage(url) {
        const response = await fetchImpl('/api/search/visit', { method: 'POST', headers: buildHeaders(), body: JSON.stringify({ url, html: true }), cache: 'no-store' });
        if (!response.ok) throw new Error(`The page did not open (HTTP ${response.status}).`);
        return response.text();
    }

    async function searchWikipedia(query) {
        const response = await fetchImpl(`${WIKIPEDIA_API}${encodeURIComponent(query)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Wikipedia did not answer (HTTP ${response.status}).`);
        return computeWikipediaResults(await response.json());
    }

    async function search({ query } = {}) {
        const text = String(query ?? '').trim().slice(0, MAX_QUERY_LENGTH);
        if (!text) throw new Error('What should I search for?');
        // Поисковая страница — капризный источник: любая её осечка (проверка, блокировка, сеть) не должна лишать гида Википедии.
        try {
            const results = computeDuckDuckGoResults(await visitPage(`${SEARCH_PAGE}${encodeURIComponent(text)}`));
            if (results.length) return { source: 'web', results };
        } catch { /* см. выше */ }
        return { source: 'wikipedia', results: await searchWikipedia(text) };
    }

    // Fandom и многие другие вики закрыты для серверного запроса ST (HTTP 500), но их API открыт браузеру: на вики-адресе это запасной путь.
    async function readViaMediaWiki(url, limit) {
        for (const apiUrl of computeMediaWikiParseUrls(url)) {
            try {
                const response = await fetchImpl(apiUrl, { cache: 'no-store' });
                const text = response.ok ? computeMediaWikiText(await response.json(), limit) : '';
                if (text) return text;
            } catch { /* следующий адрес API, затем общий отказ */ }
        }
        return '';
    }

    async function read({ url, maxChars = DEFAULT_READ_CHARS } = {}) {
        if (!isReadableWebUrl(url)) throw new Error('Only ordinary http(s) page addresses can be opened.');
        const limit = Math.min(Math.max(Number(maxChars) || DEFAULT_READ_CHARS, 500), 12000);
        try {
            return { url, text: computeReadableText(await visitPage(url), limit) };
        } catch (error) {
            const fromWiki = await readViaMediaWiki(url, limit);
            if (fromWiki) return { url, text: fromWiki };
            throw error;
        }
    }

    const unregisters = [
        bus.register('stWebSearch.search', params => search(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.read', params => read(params), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
