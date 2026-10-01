/**
 * Разбор веб-страниц для гида: чистые функции над текстом страницы. Результаты поиска — из HTML-выдачи DuckDuckGo и из ответа API Википедии, читаемый
 * текст — из любой HTML-страницы. Сервис (`services/st-web-search.js`) только достаёт страницы; здесь решается, что из них считать ответом.
 */

import { computeInfoboxText } from './web-infobox.js';

const HTML_ENTITIES = Object.freeze({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#x27;': '\'', '&nbsp;': ' ', '&apos;': '\'', '&ndash;': '–', '&mdash;': '—', '&hellip;': '…' });
const decodeEntities = text => text.replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp|apos|ndash|mdash|hellip);/g, entity => HTML_ENTITIES[entity]).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
const stripTags = html => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

export const MAX_SEARCH_RESULTS = 6;
export const DEFAULT_READ_CHARS = 4000;

// DuckDuckGo оборачивает каждую ссылку в свой редирект; настоящий адрес лежит в параметре `uddg`.
function unwrapDuckDuckGoLink(href) {
    const decoded = decodeEntities(href);
    const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
    const url = wrapped ? decodeURIComponent(wrapped[1]) : decoded;
    return url.startsWith('//') ? `https:${url}` : url;
}

/** Результаты из HTML-выдачи DuckDuckGo (`html.duckduckgo.com/html/`): `[{ title, url, snippet }]`; пустая выдача или страница-проверка — `[]`. */
export function computeDuckDuckGoResults(html) {
    const results = [];
    const pattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/g;
    for (const [, href, titleHtml, rest] of String(html ?? '').matchAll(pattern)) {
        const url = unwrapDuckDuckGoLink(href);
        if (!/^https?:\/\//i.test(url)) continue;
        const snippetHtml = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(rest)?.[1] ?? '';
        results.push({ title: stripTags(titleHtml), url, snippet: stripTags(snippetHtml) });
        if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    return results;
}

/** Результаты из ответа `action=query&list=search` API Википедии: сниппет приходит с пометками совпадений в HTML. */
export function computeWikipediaResults(json, { host = 'en.wikipedia.org' } = {}) {
    return (json?.query?.search ?? []).slice(0, MAX_SEARCH_RESULTS).map(item => ({
        title: String(item.title ?? ''), url: `https://${host}/wiki/${encodeURIComponent(String(item.title ?? '').replace(/ /g, '_'))}`, snippet: stripTags(String(item.snippet ?? '')),
    }));
}

/** Полный читаемый текст страницы: без скриптов, стилей, навигации и подвала; абзацы — строки, заголовки — отдельные строки `## Название` (по ним web-pages.js строит оглавление). */
export function computePageText(html) {
    const infobox = computeInfoboxText(html);
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(String(html ?? ''))?.[1] ?? String(html ?? '');
    const cleaned = body
        .replace(infobox ? /<table[^>]*class="[^"]*\binfobox\b[\s\S]*?<\/table>/i : /^$/, ' ') // инфобокс уже разобран в пары «поле: значение» и идёт первым разделом
        .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner) => `\n## ${stripTags(inner)}\n`)
        .replace(/<\/(p|div|li|tr|br|section|article)>|<br\s*\/?>/gi, '\n');
    const lines = decodeEntities(cleaned.replace(/<[^>]*>/g, '')).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.length > 1);
    return [infobox, lines.join('\n')].filter(Boolean).join('\n');
}

/** Читаемый текст страницы, обрезанный до `maxChars`; обрезка помечена, чтобы гид знала, что видела не всё. */
export function computeReadableText(html, maxChars = DEFAULT_READ_CHARS) {
    const text = computePageText(html);
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n[cut: the page has ${text.length} characters, this is the first ${maxChars}]` : text;
}

/**
 * Адреса API вики-движка (MediaWiki) для страницы вида `https://host/wiki/Title`: Fandom, Википедия и сотни других вики отдают страницу через
 * `action=parse` с `origin=*`, то есть браузеру напрямую, когда сам сайт отказывает серверному запросу ST. `[]` — адрес не похож на страницу вики.
 */
export function computeMediaWikiParseUrls(pageUrl) {
    let url;
    try { url = new URL(String(pageUrl)); } catch { return []; }
    const title = /^\/wiki\/(.+)$/.exec(url.pathname)?.[1];
    if (!title || url.protocol !== 'https:') return [];
    const query = `?action=parse&prop=text&format=json&origin=*&disableeditsection=1&redirects=1&page=${title}`;
    return [`${url.origin}/api.php${query}`, `${url.origin}/w/api.php${query}`];
}

/** Ответ `action=parse` → читаемый текст страницы (пусто, если в ответе нет страницы). */
export function computeMediaWikiText(json, maxChars = DEFAULT_READ_CHARS) {
    const html = json?.parse?.text?.['*'];
    if (typeof html !== 'string') return '';
    return maxChars === Infinity ? computePageText(html) : computeReadableText(html, maxChars);
}

/** Адрес, который можно открыть: только http(s) и без адресов-литералов (как и сам ST на `/api/search/visit`). */
export function isReadableWebUrl(value) {
    try {
        const url = new URL(String(value));
        return (url.protocol === 'https:' || url.protocol === 'http:') && !url.port && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':');
    } catch {
        return false;
    }
}
