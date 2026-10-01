/**
 * Базы персонажей для гида: AniList (аниме и манга), VNDB (визуальные новеллы), Jikan/MyAnimeList (запасной). Открытые API без ключей — надёжнее и короче, чем
 * разбирать страницы: имена и прозвища, возраст, описание, тайтлы. Чистые функции: тело запроса, разбор ответа в единый вид, подбор кандидатов и текст страницы
 * для хранилища (web-pages.js): разделы `## …`, по которым Mea потом ходит. Сеть — в Сервисе (`services/st-web-search.js`).
 *
 * Кандидат: `{ ref: 'anilist:88572', source, id, name, native, aliases[], titles[], favourites, url, facts: [[поле, значение]], description }`.
 */

export const ANILIST_URL = 'https://graphql.anilist.co';
export const VNDB_URL = 'https://api.vndb.org/kana/character';
export const JIKAN_URL = 'https://api.jikan.moe/v4/characters';
export const MAX_CANDIDATES = 6;
const DESCRIPTION_LIMIT = 40000;

const ANILIST_QUERY = 'query($search: String, $id: Int) { Page(perPage: 8) { characters(search: $search, id: $id, sort: FAVOURITES_DESC) { id name { full native alternative alternativeSpoiler } description(asHtml: false) gender age dateOfBirth { year month day } bloodType favourites siteUrl media(perPage: 6, sort: POPULARITY_DESC) { nodes { type title { romaji english } } } } } }';

export const buildAnilistBody = ({ search, id } = {}) => ({ query: ANILIST_QUERY, variables: id ? { id: Number(id) } : { search: String(search ?? '').slice(0, 100) } });

export const buildVndbBody = ({ search, id } = {}) => ({
    filters: id ? ['id', '=', String(id)] : ['search', '=', String(search ?? '').slice(0, 100)],
    fields: 'id,name,original,aliases,description,age,birthday,blood_type,height,weight,bust,waist,hips,sex,vns.title',
    results: 8, sort: 'searchrank',
});

export const buildJikanUrl = ({ search, id } = {}) => (id ? `${JIKAN_URL}/${Number(id)}/full` : `${JIKAN_URL}?limit=8&order_by=favorites&sort=desc&q=${encodeURIComponent(String(search ?? '').slice(0, 100))}`);

const clean = text => String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, DESCRIPTION_LIMIT);

/** AniList пишет спойлеры как `~!текст!~`, а жирный и ссылки — markdown: оставляем читаемый текст и помечаем спойлеры. */
export function computeAnilistDescription(text) {
    return clean(String(text ?? '')
        .replace(/~!([\s\S]*?)!~/g, '[spoiler: $1]')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/(\*\*|__)(.*?)\1/g, '$2'));
}

/** VNDB пишет BBCode: `[url=/c15]текст[/url]`, `[spoiler]…[/spoiler]`. */
export function computeVndbDescription(text) {
    return clean(String(text ?? '')
        .replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '[spoiler: $1]')
        .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, '$1')
        .replace(/\[\/?(?:b|i|u|s|quote|raw|code)\]/gi, ''));
}

const birthday = date => (date?.month ? `${date.year ? `${date.year}-` : ''}${String(date.month).padStart(2, '0')}-${String(date.day ?? 0).padStart(2, '0')}` : '');
const facts = pairs => pairs.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '').map(([field, value]) => [field, String(value)]);

export function computeAnilistCandidates(json) {
    return (json?.data?.Page?.characters ?? []).map(item => ({
        ref: `anilist:${item.id}`, source: 'AniList', id: item.id, name: item.name?.full ?? '', native: item.name?.native ?? '',
        aliases: [...(item.name?.alternative ?? []), ...(item.name?.alternativeSpoiler ?? [])].filter(Boolean),
        titles: (item.media?.nodes ?? []).map(node => node.title?.english || node.title?.romaji).filter(Boolean),
        favourites: item.favourites ?? 0, url: item.siteUrl ?? `https://anilist.co/character/${item.id}`,
        facts: facts([['Gender', item.gender], ['Age', item.age], ['Birthday', birthday(item.dateOfBirth)], ['Blood type', item.bloodType]]),
        description: computeAnilistDescription(item.description),
    }));
}

export function computeVndbCandidates(json) {
    return (json?.results ?? []).map(item => ({
        ref: `vndb:${item.id}`, source: 'VNDB', id: item.id, name: item.name ?? '', native: item.original ?? '', aliases: item.aliases ?? [],
        titles: (item.vns ?? []).map(vn => vn.title).filter(Boolean).slice(0, 6), favourites: 0, url: `https://vndb.org/${item.id}`,
        facts: facts([['Sex', Array.isArray(item.sex) ? item.sex[0] : item.sex], ['Age', item.age], ['Birthday', Array.isArray(item.birthday) ? item.birthday.join('-') : item.birthday], ['Blood type', item.blood_type], ['Height', item.height && `${item.height} cm`], ['Weight', item.weight && `${item.weight} kg`], ['Bust / waist / hips', item.bust ? `${item.bust} / ${item.waist} / ${item.hips}` : '']]),
        description: computeVndbDescription(item.description),
    }));
}

export function computeJikanCandidates(json) {
    const list = Array.isArray(json?.data) ? json.data : json?.data ? [json.data] : [];
    return list.map(item => ({
        ref: `jikan:${item.mal_id}`, source: 'MyAnimeList', id: item.mal_id, name: item.name ?? '', native: item.name_kanji ?? '', aliases: item.nicknames ?? [],
        titles: [...(item.anime ?? []), ...(item.manga ?? [])].map(entry => entry.anime?.title ?? entry.manga?.title).filter(Boolean).slice(0, 6), favourites: item.favorites ?? 0,
        url: item.url ?? `https://myanimelist.net/character/${item.mal_id}`, facts: [], description: clean(item.about),
    }));
}

const normalise = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Единый список кандидатов: из названной франшизы (если есть) — выше всех; точное совпадение имени или прозвища — выше, дальше по числу «избранного»; тот же персонаж из разных баз не склеивается (разные
 * описания полезны), но порядок такой, что лучшие — первыми. Не больше MAX_CANDIDATES.
 */
export function rankCandidates(candidates, query, franchise = '') {
    const needle = normalise(query);
    const series = normalise(franchise);
    const inSeries = item => (series && item.titles.some(title => normalise(title).includes(series)) ? 1 : 0);
    const score = item => {
        const names = [item.name, item.native, ...item.aliases].map(normalise);
        if (names.includes(needle)) return 3;
        if (names.some(name => name && (name.includes(needle) || needle.includes(name)))) return 2;
        return 1;
    };
    return [...candidates].sort((a, b) => inSeries(b) - inSeries(a) || score(b) - score(a) || b.favourites - a.favourites).slice(0, MAX_CANDIDATES);
}

/** Строка кандидата для списка выбора: кто, откуда, чем отличается. */
export function describeCandidate(item) {
    const where = item.titles.slice(0, 3).join(', ');
    const aliases = item.aliases.slice(0, 4).join(', ');
    const snippet = item.description.replace(/\s+/g, ' ').slice(0, 160);
    return `${item.ref} — ${item.name}${item.native ? ` (${item.native})` : ''}, ${item.source}${where ? `; from: ${where}` : ''}${aliases ? `; also called: ${aliases}` : ''}${item.favourites ? `; ${item.favourites} favourites` : ''}${snippet ? `\n   ${snippet}…` : ''}`;
}

/** Текст страницы кандидата для хранилища: разделы `## …`, чтобы по ним ходить. */
export function computeCharacterPageText(item) {
    const parts = [`## ${item.name}`, `Source: ${item.source} — ${item.url}`];
    const names = [item.native && `Native: ${item.native}`, item.aliases.length && `Also called: ${item.aliases.join(', ')}`].filter(Boolean);
    if (names.length) parts.push('## Names', ...names);
    if (item.facts.length) parts.push('## Facts', ...item.facts.map(([field, value]) => `${field}: ${value}`));
    if (item.titles.length) parts.push('## Appears in', ...item.titles);
    if (item.description) parts.push('## Description', item.description);
    return parts.join('\n');
}
