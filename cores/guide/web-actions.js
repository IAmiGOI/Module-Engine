/**
 * Действия гида «посмотреть в сети»: найти страницы и прочитать одну. Безопасные (`safe`): ничего не меняют, поэтому модель может запускать их сама,
 * без кнопки. Канон персонажа, названия, факты берутся отсюда, а не из памяти модели. Ответ уходит заметкой в переписку — по ней гид и продолжает.
 */
export function createWebActions({ callService }) {
    const buildFailure = message => ({ ok: false, message });

    return {
        'web.search': {
            safe: true,
            description: 'Search the web (used to check the facts of a canon character, a place, a term — never guess canon). Params: {"query": "Faputa Made in Abyss appearance tails"}. Returns up to 6 results (title, address, snippet). Then open the best page with web.read.',
            async run({ query } = {}) {
                const found = await callService('stWebSearch.search', { query });
                if (!found.ok) return buildFailure(`The search failed: ${found.error.message}`);
                const { source, results } = found.value;
                if (!results.length) return { ok: true, message: `Nothing found for “${query}”. Try other words, or ask the user.` };
                return { ok: true, message: `Search results for “${query}” (${source === 'wikipedia' ? 'Wikipedia' : 'web'}):\n${results.map((item, index) => `${index + 1}. ${item.title} — ${item.url}\n   ${item.snippet}`).join('\n')}` };
            },
        },
        'web.read': {
            safe: true,
            description: 'Read the text of a web page. Params: {"url": "https://…", "maxChars": 4000 (optional, up to 12000)}. Use an address from web.search or one the user gave. Only ordinary http(s) pages.',
            async run({ url, maxChars } = {}) {
                const page = await callService('stWebSearch.read', { url, maxChars });
                if (!page.ok) return buildFailure(`The page did not open: ${page.error.message}`);
                return { ok: true, message: `Page ${page.value.url}:\n${page.value.text}` };
            },
        },
    };
}
