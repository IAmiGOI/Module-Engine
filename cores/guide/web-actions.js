/**
 * Действия гида «посмотреть в сети»: найти страницы и прочитать одну. Безопасные (`safe`): ничего не меняют, поэтому модель может запускать их сама,
 * без кнопки. Канон персонажа, названия, факты берутся отсюда, а не из памяти модели. В чат идёт короткая заметка («искала, нашла 6»), а полный текст —
 * только модели (`detail`); после результата гид получает ещё один ход (`thenContinue`) и сама им распоряжается.
 */
export function createWebActions({ callService }) {
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
        'web.read': {
            safe: true,
            thenContinue: true,
            description: 'Read the text of a web page. Params: {"url": "https://…", "maxChars": 4000 (optional, up to 12000)}. Use an address from web.search or one the user gave. Only ordinary http(s) pages.',
            async run({ url, maxChars } = {}) {
                const page = await callService('stWebSearch.read', { url, maxChars });
                if (!page.ok) return buildFailure(`The page did not open: ${page.error.message}`);
                return { ok: true, message: `Read a page from ${hostOf(page.value.url)} (${page.value.text.length} characters).`, detail: `Page ${page.value.url}:\n${page.value.text}` };
            },
        },
    };
}
