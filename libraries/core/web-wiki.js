/**
 * Поиск ВНУТРИ вики франшизы (Fandom, wiki.gg и любые на MediaWiki): адреса API, разбор результатов, догадки об адресе вики по названию франшизы. Чистые
 * функции; сеть — в Сервисе (`services/st-web-search.js`). Общий каталог вики Fandom закрыт защитой от ботов, поэтому адрес вики подбирается по названию
 * (`madeinabyss.fandom.com`) и проверяется запросом `siteinfo`.
 */

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const MAX_SLUGS = 4;

/** Годный адрес вики: только имя узла (без схемы, пути и порта), не числовой. */
export const isWikiHost = host => typeof host === 'string' && HOST.test(host) && !/^[\d.]+$/.test(host);

export const computeWikiSearchUrl = (host, query) => `https://${host}/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=${encodeURIComponent(query)}`;
export const computeWikiProbeUrl = host => `https://${host}/api.php?action=query&meta=siteinfo&siprop=general&format=json&origin=*`;

const stripTags = text => String(text ?? '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/\s+/g, ' ').trim();

/** Результаты поиска MediaWiki → `[{ title, url, snippet }]`. */
export function computeWikiResults(json, host) {
    return (json?.query?.search ?? []).map(item => ({
        title: String(item.title ?? ''), url: `https://${host}/wiki/${encodeURIComponent(String(item.title ?? '').replace(/ /g, '_')).replace(/%2F/g, '/')}`, snippet: stripTags(item.snippet),
    }));
}

/**
 * Названия поддоменов вики по названию франшизы: «Made in Abyss» → `madeinabyss`, `made-in-abyss`; «The Witcher» → ещё и без «the». Не больше четырёх.
 */
export function computeWikiSlugs(franchise) {
    const words = String(franchise ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
    if (!words.length) return [];
    const variants = [words.join(''), words.join('-')];
    if (words[0] === 'the' && words.length > 1) variants.push(words.slice(1).join(''), words.slice(1).join('-'));
    return [...new Set(variants)].filter(slug => slug.length > 1).slice(0, MAX_SLUGS);
}
