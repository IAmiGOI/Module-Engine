import { entryTitle, labelIndexListing, fullTextListing, candidateListing, CANDIDATE_REPLY_SHAPE, CHUNK_CANDIDATES_SKELETON } from './bootstrap-prompts.js';

/**
 * Тематические регионы бутстрапа (MEMORY_GRAPH_TYPES_PLAN.md, этап 4): вместо заданных заранее «Locations / Main Characters /
 * Factions» модель сама предлагает регионы по темам лора («Наследование Варехов», «Порт и контрабанда») — центры такого региона
 * становятся якорями темы, а не корзиной вида. Работает, когда `baseRegionNames` пуст; иначе действует прежний промпт.
 * Ответ у всех трёх промптов — тот же, что у прежнего Прохода 1 (`[{region, subCenterUids}]` / кандидаты), разбор не меняется.
 */

const THEME_RULES = 'Name every region by its THEME, specific to this story (for example "The Varekh succession", "Harbor and smuggling"), never by a bare kind of thing ("Locations", "Characters", "Items"). A region groups entries that a reader would think of together.';

/** Проход 1 целиком (лорбук влез в один вызов): темы и по 2 представительные записи на каждую. */
export function buildThematicSkeletonPrompt(entries, targetRegions, maxRegions) {
    const listing = entries.map(entry => `${entry.uid}. ${entryTitle(entry)}: ${entry.content}`).join('\n');
    return `Here is the FULL World Info / Lorebook for this story (${entries.length} entries, numbered):\n\n${listing}\n\nWe are organizing this into thematic regions of a memory graph. Propose about ${targetRegions} regions (at most ${maxRegions}). ${THEME_RULES}\n\nFor EACH region pick exactly 2 entries (by number) that best represent its theme — the most foundational, representative ones. Every entry may represent only one region.\n\nReply with ONLY a JSON array: [{"region": "theme name", "subCenterUids": [number, number]}, ...]`;
}

/** Проход 1, map — темы и кандидаты из записей ЭТОГО чанка (части называют регионы независимо, склеит reduce). */
export function buildThematicSkeletonPartPrompt({ partEntries, allEntries, partNumber, partCount, targetRegions, candidatesPerRegion = CHUNK_CANDIDATES_SKELETON }) {
    return `A story's World Info / Lorebook (${allEntries.length} entries) is too large to read at once, so it is analyzed in ${partCount} parts. This is part ${partNumber} of ${partCount}.\n\nINDEX of ALL entries (labels only, for awareness of what exists in other parts):\n${labelIndexListing(allEntries)}\n\nFULL TEXT of the entries in THIS part (${partEntries.length} entries):\n\n${fullTextListing(partEntries)}\n\nWe are organizing the whole lore into about ${targetRegions} thematic regions. For THIS part's entries ONLY, propose the themes they form. ${THEME_RULES}\n\nFor EACH theme give up to ${candidatesPerRegion} candidates (uids from the full-text section above) that best represent it, best first, each with a short note.\n\nReply with ONLY a JSON array: ${CANDIDATE_REPLY_SHAPE}`;
}

/** Проход 1, reduce — главное место тематического режима: слить одинаковые темы из разных частей и выбрать по 2 записи. */
export function buildThematicSkeletonReducePrompt(groups, targetRegions, maxRegions) {
    return `A story's World Info was analyzed in parts. Each part proposed thematic regions independently; for each, the best candidate entries are listed below, best first.\n\n${candidateListing(groups)}\n\nSeveral proposed regions may be the SAME theme under different names — merge those into one region with the clearest name. Return about ${targetRegions} regions in total (at most ${maxRegions}). ${THEME_RULES}\n\nFor EACH resulting region choose exactly 2 entries (by number, only from the listed candidates) that best represent it. An entry may represent only one region.\n\nReply with ONLY a JSON array: [{"region": "theme name", "subCenterUids": [number, number]}, ...]`;
}

/** Имена регионов из ответа: обрезка до 60 символов, дедуп без учёта регистра, не больше `maxRegions` (лишние отбрасываются с конца). */
export function normalizeThematicRegions(regions, maxRegions) {
    const seen = new Set();
    const result = [];
    for (const region of regions) {
        const name = region.name.slice(0, 60).trim();
        const key = name.toLowerCase();
        if (!name || seen.has(key)) continue;
        seen.add(key);
        result.push({ ...region, name });
        if (result.length >= maxRegions) break;
    }
    return result;
}
