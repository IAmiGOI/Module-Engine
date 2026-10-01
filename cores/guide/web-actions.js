import { createPageSearch } from './page-search.js';

/**
 * Действия гида «посмотреть в сети»: найти страницы и прочитать одну. Безопасные (`safe`): ничего не меняют, поэтому модель может запускать их сама,
 * без кнопки. Канон персонажа, названия, факты берутся отсюда, а не из памяти модели. Страница открывается целиком в бэкенде (Сервис хранит её, web-pages.js), а в разговор идёт только оглавление; дальше она читает разделы и ищет слова. В чат идёт короткая заметка («искала, нашла 6»), а полный текст —
 * только модели (`detail`); после результата гид получает ещё один ход (`thenContinue`) и сама им распоряжается.
 */
/** Страница короче этого приходит в ответ целиком; длиннее — только оглавление, остальное она берёт кусками. */
const SMALL_PAGE_CHARS = 3000;

export function createWebActions({ callService }) {
    const pageSearch = createPageSearch({ callService });
    const buildFailure = message => ({ ok: false, message });
    const hostOf = address => { try { return new URL(address).hostname; } catch { return address; } };

    return {
        'web.search': {
            safe: true,
            thenContinue: true,
            description: 'Search the web (used to check the facts of a canon character, a place, a term — never guess canon). Params: {"query": "Faputa Made in Abyss appearance tails"}. Returns up to 6 results (title, address, snippet). Then open the best page with web.read.',
            async run({ query } = {}) {
                const found = await callService('stWebSearch.search', { query });
                if (!found.ok) return buildFailure(`The search failed: ${found.error.message}`);
                const { source, results } = found.value;
                if (!results.length) return { ok: true, message: `Searched for “${query}”: nothing found.`, detail: `Nothing found for “${query}”. Try other words, or ask the user.` };
                const where = source === 'wikipedia' ? 'Wikipedia' : 'web';
                const listing = results.map((item, index) => `${index + 1}. ${item.title} — ${item.url}\n   ${item.snippet}`).join('\n');
                return { ok: true, message: `Searched ${source === 'wikipedia' ? 'Wikipedia' : 'the web'} for “${query}”: ${results.length} result${results.length === 1 ? '' : 's'}.`, detail: `Search results for “${query}” (${where}):\n${listing}` };
            },
        },
        'web.character': {
            safe: true,
            thenContinue: true,
            description: 'FIRST STEP for an anime, manga, visual novel or game character: look the name up in AniList, VNDB and MyAnimeList (open databases — names, nicknames, age, description, the titles she appears in). Params: {"name": "Emilia", "franchise": "Re:Zero" (optional — candidates from it come first; keep the name itself short, the databases match names, not sentences)}. Returns up to 6 candidates, best first, each with a ref; the same name can belong to several characters, so check the titles and ask the user if it is unclear which one. Then open one with web.read {"ref": …}. The databases give the basics; the franchise wiki (web.wikis, web.wiki) gives the depth.',
            async run({ name, franchise } = {}) {
                const found = await callService('stWebSearch.characters', { query: name, franchise });
                if (!found.ok) return buildFailure(`The character search failed: ${found.error.message}`);
                const { candidates, failed } = found.value;
                const skipped = failed.length ? ` (${failed.join(', ')} did not answer)` : '';
                if (!candidates.length) return { ok: true, message: `Looked up “${name}” in the character databases: nothing${skipped}.`, detail: `No character named “${name}” in the databases${skipped}. Try another spelling or a nickname, search the web, or ask the user.` };
                return {
                    ok: true,
                    message: `Looked up “${name}” in the character databases: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}${skipped}.`,
                    detail: `Candidates for “${name}”${skipped}:\n${candidates.map((item, index) => `${index + 1}. ${item.line}`).join('\n')}`,
                };
            },
        },
        'web.wikis': {
            safe: true,
            thenContinue: true,
            description: 'Find the fan wiki of a franchise (Fandom, wiki.gg). Params: {"franchise": "Made in Abyss"}. Returns the wiki hosts that exist (like madeinabyss.fandom.com). Then search inside it with web.wiki. If none is found, use web.search ("<franchise> fandom wiki").',
            async run({ franchise } = {}) {
                const found = await callService('stWebSearch.wikiGuess', { franchise });
                if (!found.ok) return buildFailure(`The wiki search failed: ${found.error.message}`);
                const { wikis } = found.value;
                if (!wikis.length) return { ok: true, message: `No wiki guessed for “${franchise}”.`, detail: `No wiki at the usual addresses for “${franchise}”. Use web.search with “${franchise} fandom wiki” to find its address.` };
                return { ok: true, message: `Found ${wikis.length} wiki${wikis.length === 1 ? '' : 's'} for “${franchise}”.`, detail: `Wikis for “${franchise}”:\n${wikis.map(item => `- ${item.host} (${item.name})`).join('\n')}` };
            },
        },
        'web.wiki': {
            safe: true,
            thenContinue: true,
            description: 'Search INSIDE one wiki. Params: {"host": "madeinabyss.fandom.com", "query": "Faputa"}. Returns up to 6 pages (title, address, snippet); open the best with web.read {"url"} — wiki pages come with their Infobox and sections. Much better than a general web search for canon facts.',
            async run({ host, query } = {}) {
                const found = await callService('stWebSearch.wiki', { host, query });
                if (!found.ok) return buildFailure(`The wiki search failed: ${found.error.message}`);
                const { results } = found.value;
                if (!results.length) return { ok: true, message: `Searched ${host} for “${query}”: nothing.`, detail: `Nothing on ${host} for “${query}”. Try other words.` };
                return { ok: true, message: `Searched ${host} for “${query}”: ${results.length} result${results.length === 1 ? '' : 's'}.`, detail: `Results on ${host} for “${query}”:\n${results.map((item, index) => `${index + 1}. ${item.title} — ${item.url}\n   ${item.snippet}`).join('\n')}` };
            },
        },
        'web.read': {
            safe: true,
            thenContinue: true,
            description: 'Open a web page in the engine memory WITHOUT pulling it into the chat. Params: {"url": "https://…"} or {"ref": "anilist:88572"} (a character found with web.character). Use an address from web.search / web.wiki or one the user gave. You get the page id, its size, the list of its sections and the first lines; a short page comes whole. A wiki page starts with its Infobox (age, height, voice actors…). Then read only what you need: web.page for a section or a stretch of text, web.find to look for words. Open pages stay available for the whole work on the card.',
            async run({ url, ref } = {}) {
                const opened = await callService('stWebSearch.open', { url, ref });
                if (!opened.ok) return buildFailure(`The page did not open: ${opened.error.message}`);
                const page = opened.value;
                const where = hostOf(page.url);
                if (page.chars <= SMALL_PAGE_CHARS) {
                    const whole = await callService('stWebSearch.view', { id: page.id, offset: 0, chars: SMALL_PAGE_CHARS });
                    if (whole.ok) return { ok: true, message: `Opened a short page from ${where} (${page.chars} characters).`, detail: `Page ${page.id} — ${page.url} (${page.chars} characters, whole):\n${whole.value.text}` };
                }
                const outline = page.outline.map(item => `${item.number}. ${item.title} (${item.chars} characters, from ${item.offset})`).join('\n');
                return {
                    ok: true,
                    message: `Opened a page from ${where}: ${page.chars} characters, ${page.outline.length} section${page.outline.length === 1 ? '' : 's'}.`,
                    detail: `Page ${page.id} — ${page.url} (${page.chars} characters). Only the overview is here; read the rest with web.page / web.find.\nSections:\n${outline}\nBeginning:\n${page.head}`,
                };
            },
        },
        'web.page': {
            safe: true,
            thenContinue: true,
            description: 'Read a piece of a page opened with web.read. Params: {"id": "p1", "section": 2 or part of its title} or {"id": "p1", "offset": 3000, "chars": 3000 (default 3000, up to 8000)}. The result tells where the piece ends and from which offset to continue.',
            async run({ id, section, offset, chars } = {}) {
                const piece = await callService('stWebSearch.view', { id, section, offset, chars });
                if (!piece.ok) return buildFailure(piece.error.message);
                const view = piece.value;
                const label = view.section ? `section “${view.section}”` : `characters ${view.from}–${view.to}`;
                const tail = view.next === null ? 'This is the end of the page.' : `The page goes on: continue with offset ${view.next}.`;
                return { ok: true, message: `Read ${label} of page ${view.id} (${view.to - view.from} characters).`, detail: `Page ${view.id}, ${label} (of ${view.total} characters):\n${view.text}\n[${tail}]` };
            },
        },
        'web.find': {
            safe: true,
            thenContinue: true,
            description: 'Look for something on a page opened with web.read — by the words AND by the meaning ("how she behaves in a fight" finds "attacks fiercely and never retreats"). Params: {"id": "p1", "query": "tails height" or a short phrase}. Returns the best places with a bit of text around each, the section and how it was found (words / meaning / both); read more of a place with web.page and its offset. The first search on a page takes a few seconds while the page is prepared.',
            async run({ id, query } = {}) {
                const found = await pageSearch.search({ id, query });
                if (!found.ok) return buildFailure(found.error.message);
                const { matches, meaning } = found.value;
                const mode = meaning === 'unavailable' ? ' (by words only: the meaning search is not available right now)' : '';
                if (!matches.length) return { ok: true, message: `Looked for “${query}” on page ${id}: nothing.`, detail: `Nothing on page ${id} for “${query}”${mode}. Try other words, or another section.` };
                const listing = matches.map((item, index) => `${index + 1}. offset ${item.offset}${item.section ? `, section ${item.section}` : ''}${item.via ? ` [${item.via}]` : ''}: …${item.snippet}…`).join('\n');
                return { ok: true, message: `Looked for “${query}” on page ${id}: ${matches.length} place${matches.length === 1 ? '' : 's'}.`, detail: `Places on page ${id} for “${query}”${mode}:\n${listing}` };
            },
        },
    };
}
