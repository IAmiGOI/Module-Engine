import { computeDuckDuckGoResults, computeWikipediaResults, computeReadableText, computePageText, computeMediaWikiParseUrls, computeMediaWikiText, isReadableWebUrl, DEFAULT_READ_CHARS } from '../libraries/core/web-text.js';
import { createPageStore, sliceText, pickSection, findInText, OVERVIEW_HEAD_CHARS } from '../libraries/core/web-pages.js';
import { ANILIST_URL, VNDB_URL, buildAnilistBody, buildVndbBody, buildJikanUrl, computeAnilistCandidates, computeVndbCandidates, computeJikanCandidates, rankCandidates, describeCandidate, computeCharacterPageText } from '../libraries/core/web-character-sources.js';
import { isWikiHost, computeWikiSearchUrl, computeWikiResults, computeWikiSlugs, computeWikiProbeUrl } from '../libraries/core/web-wiki.js';

/**
 * Сервис поиска в сети — единственное место, которое ходит за страницами. Страницы отдаёт сервер SillyTavern (`/api/search/visit`): у браузера
 * нет права читать чужие сайты, а ключи платных поисковиков у пользователя не обязаны быть. Поиск: выдача DuckDuckGo через тот же эндпоинт; если она
 * пуста (DuckDuckGo нередко показывает серверам проверку), — API Википедии, которое браузеру разрешено напрямую. Для персонажей — открытые API без ключей
 * (AniList, VNDB, Jikan), для вики — их MediaWiki API (поиск внутри вики, страницы с инфобоксом). Все ответы кэшируются в памяти, к каждому узлу — пауза
 * между запросами (у AniList лимит 30 в минуту).
 *
 * Контракты: `stWebSearch.search { query }` → `{ source, results: [{ title, url, snippet }] }`; `stWebSearch.read { url, maxChars? }` → `{ url, text }` (одним куском, для коротких
 * случаев). Длинные страницы — через хранилище в бэкенде (web-pages.js): `stWebSearch.open { url | ref }` кладёт ВСЮ страницу и отдаёт только оглавление и начало
 * (`{ id, url, chars, outline, head }`), `stWebSearch.view { id, section? | offset?, chars? }` — кусок, `stWebSearch.find { id, query }` — места с контекстом.
 * `stWebSearch.characters { query, franchise? }` → `{ candidates: [{ ref, line }], failed: [источник] }` (ref открывается через `open`); `stWebSearch.wiki { host, query }` — поиск
 * внутри вики; `stWebSearch.wikiGuess { franchise }` — какие вики с таким названием существуют (`[{ host, name }]`).
 */
const SEARCH_PAGE = 'https://html.duckduckgo.com/html/?q=';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=';
const MAX_QUERY_LENGTH = 200;
const CACHE_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 200;
/** Пауза между запросами к одному узлу: AniList пускает 30 запросов в минуту, остальным хватает короткой вежливости. */
const HOST_GAP_MS = Object.freeze({ 'graphql.anilist.co': 2100, default: 250 });

export function registerStWebSearchService(bus, { getContext, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), hostGapMs = HOST_GAP_MS, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const buildHeaders = () => ({ 'Content-Type': 'application/json', ...(getContext()?.getRequestHeaders?.() ?? {}) });

    const cache = new Map();
    const remember = (key, value) => { cache.delete(key); cache.set(key, { value, at: now() }); while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value); return value; };
    const recall = key => { const hit = cache.get(key); return hit && now() - hit.at < CACHE_MS ? hit.value : undefined; };
    const nextSlot = new Map();
    async function politely(url) {
        let host = 'default';
        try { host = new URL(url, 'http://local').hostname; } catch { /* относительный адрес — ST */ }
        const gap = hostGapMs[host] ?? hostGapMs.default ?? 0;
        const at = Math.max(now(), nextSlot.get(host) ?? 0);
        nextSlot.set(host, at + gap);
        if (at > now()) await sleep(at - now());
    }
    /** Запрос с кэшем в памяти (тот же запрос в течение получаса не повторяется) и паузой на узел. */
    async function cached(key, run) {
        const hit = recall(key);
        if (hit !== undefined) return hit;
        return remember(key, await run());
    }

    const visitPage = url => cached(`visit:${url}`, async () => {
        await politely(url);
        const response = await fetchImpl('/api/search/visit', { method: 'POST', headers: buildHeaders(), body: JSON.stringify({ url, html: true }), cache: 'no-store' });
        if (!response.ok) throw new Error(`The page did not open (HTTP ${response.status}).`);
        return response.text();
    });

    const getJson = (url, { body, label } = {}) => cached(`json:${url}:${body ? JSON.stringify(body) : ''}`, async () => {
        await politely(url);
        const response = await fetchImpl(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' } : { cache: 'no-store' });
        if (!response.ok) throw new Error(`${label ?? url} did not answer (HTTP ${response.status}).`);
        return response.json();
    });

    async function searchWikipedia(query) {
        return computeWikipediaResults(await getJson(`${WIKIPEDIA_API}${encodeURIComponent(query)}`, { label: 'Wikipedia' }));
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

    // --- Персонажи (AniList, VNDB, Jikan) --------------------------------------------------------------------------------------------------------------------
    const candidates = new Map(); // ref → кандидат: `open` берёт его отсюда, без повторного запроса

    async function lookupCharacters({ query, franchise } = {}) {
        const text = String(query ?? '').trim().slice(0, 100);
        if (!text) throw new Error('Whose character should I look up?');
        const sources = [
            ['AniList', () => getJson(ANILIST_URL, { body: buildAnilistBody({ search: text }), label: 'AniList' }).then(computeAnilistCandidates)],
            ['VNDB', () => getJson(VNDB_URL, { body: buildVndbBody({ search: text }), label: 'VNDB' }).then(computeVndbCandidates)],
            ['MyAnimeList', () => getJson(buildJikanUrl({ search: text }), { label: 'Jikan (MyAnimeList)' }).then(computeJikanCandidates)],
        ];
        const settled = await Promise.allSettled(sources.map(([, run]) => run()));
        const found = settled.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
        const failed = settled.map((result, index) => (result.status === 'rejected' ? sources[index][0] : null)).filter(Boolean);
        const ranked = rankCandidates(found, text, String(franchise ?? '').slice(0, 100));
        for (const item of ranked) candidates.set(item.ref, item);
        return { candidates: ranked.map(item => ({ ref: item.ref, line: describeCandidate(item) })), failed };
    }

    async function fetchCandidate(ref) {
        const [source, id] = String(ref).split(':');
        if (source === 'anilist') return (await getJson(ANILIST_URL, { body: buildAnilistBody({ id }), label: 'AniList' }).then(computeAnilistCandidates))[0];
        if (source === 'vndb') return (await getJson(VNDB_URL, { body: buildVndbBody({ id }), label: 'VNDB' }).then(computeVndbCandidates))[0];
        if (source === 'jikan') return computeJikanCandidates(await getJson(buildJikanUrl({ id }), { label: 'Jikan (MyAnimeList)' }))[0];
        return null;
    }

    // --- Вики ---------------------------------------------------------------------------------------------------------------------------------------------
    async function searchWiki({ host, query } = {}) {
        if (!isWikiHost(host)) throw new Error('Give the wiki address as a host, like madeinabyss.fandom.com.');
        const text = String(query ?? '').trim().slice(0, MAX_QUERY_LENGTH);
        if (!text) throw new Error('What should I search for?');
        return { host, results: computeWikiResults(await getJson(computeWikiSearchUrl(host, text), { label: host }), host) };
    }

    async function guessWikis({ franchise } = {}) {
        const slugs = computeWikiSlugs(franchise);
        if (!slugs.length) throw new Error('Which franchise?');
        const probes = slugs.flatMap(slug => ['fandom.com', 'wiki.gg'].map(domain => `${slug}.${domain}`));
        const checked = await Promise.allSettled(probes.map(async host => ({ host, name: (await getJson(computeWikiProbeUrl(host), { label: host }))?.query?.general?.sitename ?? '' })));
        return { wikis: checked.filter(item => item.status === 'fulfilled' && item.value.name).map(item => item.value) };
    }

    // Fandom и многие другие вики закрыты для серверного запроса ST (HTTP 500), но их API открыт браузеру, и отдаёт страницу вместе с инфобоксом: на вики-адресе это первый путь.
    async function readViaMediaWiki(url, limit) {
        for (const apiUrl of computeMediaWikiParseUrls(url)) {
            try {
                const text = computeMediaWikiText(await getJson(apiUrl, { label: 'The wiki' }), limit);
                if (text) return text;
            } catch { /* следующий адрес API, затем общий отказ */ }
        }
        return '';
    }

    const pages = createPageStore();

    // Страница целиком (без обрезки): вики — через её API; остальное — ST-сервер, а на вики при его отказе уже пробовали API.
    async function fetchFullText(url) {
        const fromWiki = await readViaMediaWiki(url, Infinity);
        if (fromWiki) return fromWiki;
        return computePageText(await visitPage(url));
    }

    async function open({ url, ref } = {}) {
        if (ref) {
            const item = candidates.get(ref) ?? await fetchCandidate(ref);
            if (!item) throw new Error(`I have no character “${ref}”. Look one up first with web.character.`);
            const page = pages.open({ url: item.url, text: computeCharacterPageText(item) });
            return { id: page.id, url: item.url, chars: page.text.length, outline: page.outline, head: page.text.slice(0, OVERVIEW_HEAD_CHARS) };
        }
        if (!isReadableWebUrl(url)) throw new Error('Only ordinary http(s) page addresses can be opened.');
        const text = await fetchFullText(url);
        if (!text) throw new Error('The page has no readable text.');
        const page = pages.open({ url, text });
        return { id: page.id, url, chars: page.text.length, outline: page.outline, head: page.text.slice(0, OVERVIEW_HEAD_CHARS) };
    }

    /** Свой текст как страница (лорбук гида и подобное): тот же просмотр, разделы и поиск, что и у веб-страницы; `url` — ключ (то же `url` заменяет прежнюю страницу). */
    function openText({ url, text, maxChars } = {}) {
        if (!url || !String(text ?? '').trim()) throw new Error('A page needs an address key and some text.');
        const page = pages.open({ url: String(url), text, maxChars });
        return { id: page.id, url: page.url, chars: page.text.length, outline: page.outline, head: page.text.slice(0, OVERVIEW_HEAD_CHARS) };
    }

    function requirePage(id) {
        const page = pages.get(id);
        if (!page) throw new Error(`There is no open page “${id ?? ''}”. Open it first with web.read; open pages: ${pages.list().map(item => item.id).join(', ') || 'none'}.`);
        return page;
    }

    function view({ id, section, offset, chars } = {}) {
        const page = requirePage(id);
        const picked = pickSection(page.outline, section);
        if (section !== undefined && section !== null && section !== '' && !picked) throw new Error(`The page has no section “${section}”. Its sections: ${page.outline.map(item => `${item.number}. ${item.title}`).join('; ')}.`);
        const piece = sliceText(page.text, { offset: picked ? picked.offset : offset, chars: chars ?? (picked ? Math.min(picked.chars, 8000) : undefined) });
        // Короткий раздел не должен дочитываться до соседнего: срез минимум в 200 знаков, поэтому конец режем по границе раздела.
        if (picked && picked.offset + picked.chars < piece.to) Object.assign(piece, { to: picked.offset + picked.chars, text: page.text.slice(piece.from, picked.offset + picked.chars), next: picked.offset + picked.chars });
        return { id: page.id, url: page.url, section: picked ? `${picked.number}. ${picked.title}` : '', ...piece };
    }

    function find({ id, query } = {}) {
        const page = requirePage(id);
        if (!String(query ?? '').trim()) throw new Error('What should I look for on the page?');
        return { id: page.id, url: page.url, matches: findInText(page.text, query, page.outline) };
    }

    // Текст открытой страницы целиком — для поиска по смыслу в Ядре (куски и векторы считает оно, Сервис только хранит страницу).
    const textOf = ({ id } = {}) => { const page = requirePage(id); return { id: page.id, url: page.url, text: page.text, outline: page.outline }; };

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
        bus.register('stWebSearch.open', params => open(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.openText', params => openText(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.view', params => view(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.find', params => find(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.text', params => textOf(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.characters', params => lookupCharacters(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.wiki', params => searchWiki(params), { loadMetric: () => 1 }),
        bus.register('stWebSearch.wikiGuess', params => guessWikis(params), { loadMetric: () => 1 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}
