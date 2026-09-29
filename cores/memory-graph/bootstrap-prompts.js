/**
 * Промпты и разбор ответов LLM-driven бутстрапа из Lorebook — MEMORY_GRAPH_FIX_PLAN.md, Этап 9 (необязательный,
 * ROADMAP 5.107и): перенесено из верха `cores/memory-graph/index.js` БЕЗ ИЗМЕНЕНИЯ ПОВЕДЕНИЯ, тем же приёмом, что
 * и `cores/memory-graph/math.js` (см. его doc-comment) — `index.js` реэкспортирует всё отсюда.
 *
 * Три прогона (Проход 1 — раскладка по базовым регионам, Проход 2 — новые центры сверху, Проход 3 — связи внутри
 * региона/орфанов) плюс их чанкованные (map-reduce) варианты для Lorebook крупнее одного вызова модели — см.
 * MEMORY_GRAPH.md за полным разбором самого алгоритма; здесь — только промпты и парсеры их ответов, оркестрация
 * (`bootstrapFromLorebook()`) остаётся в `index.js`.
 */

import { cosineSimilarity } from '../../libraries/core/embedding.js';
import { estimateTokens } from '../../libraries/core/entry-chunker.js';

// --- LLM-driven семантические регионы бутстрапа (решено с пользователем,
// после живого разбора: старый дартборд-бутстрап давал ~80% нод без единой
// связи — единственный механизм связывания, extractCharacterNames(), ловит
// только дословное упоминание чужого имени, для локаций/фракций почти
// никогда не срабатывает; сама раскладка по 15 абстрактным ячейкам не
// несёт смысла). Три прогона SideCar + эмбединг-присвоение, см.
// MEMORY_GRAPH.md за полным разбором. Органический рост (`checkAndPlace`)
// этого не касается — остаётся на дартборде, решено явно: цена LLM здесь
// приемлема, потому что бутстрап — один раз на Lorebook, не на каждый ход.

/**
 * Общий system-prompt для всех трёх LLM-вызовов бутстрапа (решено с
 * пользователем явно: одного сэмплера/эффорта мало для воркеров не
 * OpenRouter-формата, где `reasoningEffort` не действует вовсе — эта
 * инструкция подкрепляет ту же цель словами). Задача механическая — точная
 * раскладка по заданным правилам, не творчество, поэтому явно запрещаем
 * долгие раздумья и отклонение от инструкции.
 */
export const BOOTSTRAP_SYSTEM_PROMPT = 'Follow the instructions in the user message exactly and literally. Do not add items beyond what is asked, do not skip required ones, do not rename or invent things the instructions did not ask for. This is a mechanical structured-data task, not a creative one — decide quickly without extended reasoning and reply with ONLY the requested JSON, nothing else.';

/**
 * Проход 1 — весь Lorebook целиком, раскладка ТОЛЬКО по `baseRegionNames`
 * (решено с пользователем: Проход 1 больше не может изобретать свои
 * регионы — за один прогон одновременно раскладывать под-центры И
 * добавлять новые центры было ошибкой, разделено на два прогона; изобретение
 * НОВЫХ регионов сверх базового списка — исключительно Проход 2, см.
 * buildAdditionalCentersPrompt()). Просим по 2 записи-под-центра на
 * каждый подходящий регион ИЗ ЭТОГО списка. Чистая функция — составление
 * текста промпта, ответ модели разбирается отдельно
 * (`parseRegionSkeletonResponse`), как и остальные SideCar-промпты в файле.
 */
/**
 * Номера записей в промптах бутстрапа. uid уникален только ВНУТРИ книги — при нескольких активных
 * Lorebook два разных WI могут иметь запись с одним и тем же uid, и номера в промптах/разборе ответов
 * склеились бы. Все uid уникальны → остаются как есть (один Lorebook ведёт себя как раньше);
 * иначе — сквозная нумерация 0..N-1 в порядке чтения.
 */
export function assignBootstrapUids(sourceUids) {
    return new Set(sourceUids).size === sourceUids.length ? sourceUids.slice() : sourceUids.map((_, index) => index);
}

/** Как запись называется в промптах: метка + [книга], когда активных книг несколько (два WI могут содержать одноимённые записи). */
export function entryTitle(entry) {
    return `${entry.label}${entry.book ? ` [${entry.book}]` : ''}`;
}

/**
 * Ужимает тексты записей так, чтобы список влез в `maxTokens` (грубо 4 символа на токен). 0/не число — без изменений.
 * Ужимаются только копии для ПРОМПТА — сами записи (и то, что попадёт в граф) остаются целыми.
 */
export function fitEntriesToTokenBudget(entries, maxTokens) {
    const budgetChars = Math.floor(Number(maxTokens) * 4);
    if (!(budgetChars > 0) || !entries.length) return entries;
    const overhead = entries.reduce((sum, entry) => sum + String(entry.label).length + 12, 0);
    const total = overhead + entries.reduce((sum, entry) => sum + entry.content.length, 0);
    if (total <= budgetChars) return entries;
    const perEntry = Math.max(80, Math.floor((budgetChars - overhead) / entries.length));
    return entries.map(entry => (entry.content.length > perEntry ? { ...entry, content: `${entry.content.slice(0, perEntry)}…` } : entry));
}

export function buildRegionSkeletonPrompt(entries, baseRegionNames) {
    const listing = entries.map(entry => `${entry.uid}. ${entryTitle(entry)}: ${entry.content}`).join('\n');
    return `Here is the FULL World Info / Lorebook for this story (${entries.length} entries, numbered):\n\n${listing}\n\nWe are organizing this into semantic regions of a memory graph. Use ONLY these regions — do NOT invent, rename, merge, or add any others: ${baseRegionNames.join(', ')}.\n\nFor EACH region that genuinely fits this lore, pick exactly 2 entries (by number) that best represent it — the most foundational, representative entries for that region. Skip a region if nothing in the lore fits it.\n\nReply with ONLY a JSON array, using EXACTLY the region names given above: [{"region": "region name", "subCenterUids": [number, number]}, ...]`;
}

/** Разбор ответа Прохода 1 — терпимо к частично неверным полям (регион без валидного uid отбрасывается целиком, не роняет остальные). */
export function parseRegionSkeletonResponse(parsed, entries) {
    if (!Array.isArray(parsed)) return [];
    const validUids = new Set(entries.map(entry => entry.uid));
    const seenUids = new Set();
    const regions = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.region ?? '').trim();
        if (!name) continue;
        const uids = Array.isArray(item.subCenterUids)
            ? item.subCenterUids.map(Number).filter(uid => validUids.has(uid) && !seenUids.has(uid))
            : [];
        if (!uids.length) continue; // регион без единого валидного под-центра — не заводим
        for (const uid of uids) seenUids.add(uid);
        regions.push({ name, subCenterUids: uids.slice(0, 2) });
    }
    return regions;
}

/**
 * Проход 2 — центр для КАЖДОГО региона из Прохода 1 (у него пока только
 * под-центры) плюс новые регионы сверх них, чтобы дойти до целевой
 * плотности (`entriesPerRegionCenter` — один центр примерно на N записей).
 */
export function buildAdditionalCentersPrompt(entries, existingRegionNames, targetTotalRegions, entriesPerRegionCenter) {
    const listing = entries.map(entry => `${entry.uid}. ${entryTitle(entry)}: ${entry.content}`).join('\n');
    return `The same World Info (${entries.length} entries, numbered) is being organized into these regions, each already has 2 representative entries: ${existingRegionNames.join(', ')}.\n\nWe need:\n1. A CENTER entry for EACH of these ${existingRegionNames.length} regions — the single most defining entry for that region (can be one of its own 2 representatives, or a different entry that fits better).\n2. Enough NEW regions (with their own center entry) so the total region count reaches about ${targetTotalRegions} (roughly one region per ${entriesPerRegionCenter} entries is the target density — deviate if the lore genuinely doesn't split that way).\n\nAll entries:\n${listing}\n\nReply with ONLY a JSON array covering ALL regions (the ${existingRegionNames.length} existing ones AND any new ones): [{"region": "region name", "centerUid": number}, ...]`;
}

/** Разбор ответа Прохода 2 — дедуп и по имени региона, и по uid центра (модель могла назначить один и тот же uid двум регионам). */
export function parseAdditionalCentersResponse(parsed, entries) {
    if (!Array.isArray(parsed)) return [];
    const validUids = new Set(entries.map(entry => entry.uid));
    const seenNames = new Set();
    const seenUids = new Set();
    const result = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.region ?? '').trim();
        const uid = Number(item.centerUid);
        if (!name || seenNames.has(name) || !validUids.has(uid) || seenUids.has(uid)) continue;
        seenNames.add(name);
        seenUids.add(uid);
        result.push({ name, centerUid: uid });
    }
    return result;
}

// --- Чанкованные Проходы 1-2 (map-reduce над вызовами, не над текстом) ------
// Лорбук больше `bootstrapChunkTokens` не режется и не сжимается: он делится
// на ЧАНКИ ЗАПИСЕЙ ЦЕЛИКОМ (libraries/core/entry-chunker.js), каждый чанк —
// отдельный вызов ("map"), где модель видит полный текст своих записей плюс
// индекс меток ВСЕХ записей (знает, что существует за пределами чанка).
// Затем один маленький вызов ("reduce") выбирает итог среди кандидатов. Почему
// Проход 1 не теряет: глобальные лучшие 2 региона всегда входят в лучшие 2 СВОЕГО
// чанка (иначе в чанке их обошли бы двое — и глобально тоже), поэтому
// кандидатов на чанк достаточно; берём с запасом на непоследовательность
// модели между вызовами.

export const CHUNK_CANDIDATES_SKELETON = 3;
export const CHUNK_CANDIDATES_CENTERS = 2;

export function labelIndexListing(allEntries) {
    return allEntries.map(entry => `${entry.uid}. ${entryTitle(entry)}`).join('\n');
}

export function fullTextListing(entries) {
    return entries.map(entry => `${entry.uid}. ${entryTitle(entry)}: ${entry.content}`).join('\n');
}

export const CANDIDATE_REPLY_SHAPE = '[{"region": "region name", "candidates": [{"uid": number, "note": "max 15 words: what this entry is"}, ...]}, ...]';

/** Проход 1, map — кандидаты в под-центры по базовым регионам из записей ЭТОГО чанка. */
export function buildSkeletonPartPrompt({ partEntries, allEntries, partNumber, partCount, baseRegionNames, candidatesPerRegion = CHUNK_CANDIDATES_SKELETON }) {
    return `A story's World Info / Lorebook (${allEntries.length} entries) is too large to read at once, so it is analyzed in ${partCount} parts. This is part ${partNumber} of ${partCount}.\n\nINDEX of ALL entries (labels only, for awareness of what exists in other parts):\n${labelIndexListing(allEntries)}\n\nFULL TEXT of the entries in THIS part (${partEntries.length} entries):\n\n${fullTextListing(partEntries)}\n\nWe are organizing the lore into semantic regions of a memory graph. Use ONLY these regions — do NOT invent, rename, merge, or add any others: ${baseRegionNames.join(', ')}.\n\nFor EACH region, choose from THIS part's entries ONLY (uids listed in the full-text section above) up to ${candidatesPerRegion} candidates that best represent it — the most foundational, representative entries — ranked best first, each with a short note. Skip a region if nothing in this part fits.\n\nReply with ONLY a JSON array, using EXACTLY the region names above: ${CANDIDATE_REPLY_SHAPE}`;
}

/** Проход 2, map — кандидаты в центры существующих регионов и предложения НОВЫХ регионов из записей ЭТОГО чанка. */
export function buildCentersPartPrompt({ partEntries, allEntries, partNumber, partCount, existingRegionNames, targetTotalRegions, entriesPerRegionCenter, candidatesPerRegion = CHUNK_CANDIDATES_CENTERS }) {
    return `A story's World Info / Lorebook (${allEntries.length} entries) is too large to read at once, so it is analyzed in ${partCount} parts. This is part ${partNumber} of ${partCount}.\n\nINDEX of ALL entries (labels only, for awareness of what exists in other parts):\n${labelIndexListing(allEntries)}\n\nFULL TEXT of the entries in THIS part (${partEntries.length} entries):\n\n${fullTextListing(partEntries)}\n\nThe whole lore is being organized into semantic regions. These regions already exist: ${existingRegionNames.join(', ')}.\n\nFrom THIS part's entries ONLY (uids listed in the full-text section above):\n1. For EACH existing region this part has material for, propose up to ${candidatesPerRegion} candidates for its CENTER — the single most defining entry for that region — ranked best first, each with a short note.\n2. If this part's entries genuinely form a coherent group that fits none of the existing regions, propose a NEW region for it (with its own center candidates). The target for the WHOLE lore is about ${targetTotalRegions} regions in total (roughly one per ${entriesPerRegionCenter} entries) — do not over-propose.\n\nSkip anything this part has no material for.\n\nReply with ONLY a JSON array: ${CANDIDATE_REPLY_SHAPE}`;
}

/**
 * Разбор ответа map-вызова — терпимо к частично неверным полям. `allowedRegionNames` (Проход 1) —
 * только эти имена, иначе регион отбрасывается; `null` (Проход 2) — любые (новые регионы разрешены).
 * Возвращает [{region, candidates: [{uid, note}]}] с рангом по порядку в ответе; дубли uid внутри региона убираются.
 */
export function parseCandidatesResponse(parsed, validUids, { allowedRegionNames = null, maxPerRegion = 3 } = {}) {
    if (!Array.isArray(parsed)) return [];
    const allowed = allowedRegionNames ? new Map(allowedRegionNames.map(name => [normalizeRegionName(name), name])) : null;
    const groups = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const rawName = String(item.region ?? '').trim();
        if (!rawName) continue;
        const name = allowed ? allowed.get(normalizeRegionName(rawName)) : rawName;
        if (!name) continue;
        const seen = new Set();
        const candidates = [];
        for (const candidate of Array.isArray(item.candidates) ? item.candidates : []) {
            const uid = Number(candidate?.uid);
            if (!validUids.has(uid) || seen.has(uid)) continue;
            seen.add(uid);
            candidates.push({ uid, note: String(candidate?.note ?? '').trim() });
            if (candidates.length >= maxPerRegion) break;
        }
        if (candidates.length) groups.push({ region: name, candidates });
    }
    return groups;
}

function normalizeRegionName(name) {
    return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Сливает результаты всех чанков по региону: кандидаты упорядочены по РАНГУ (все первые места чанков раньше
 * всех вторых и т.д.), затем по номеру чанка; дубли uid убираются. `regionOrder` — канонические имена
 * (регионы, уже известные раньше, идут первыми и в своём написании); остальные — в порядке появления.
 */
export function mergeCandidateGroups(partResults, entryByUid, regionOrder = []) {
    const canonicalNames = new Map(regionOrder.map(name => [normalizeRegionName(name), name]));
    const byKey = new Map(regionOrder.map(name => [normalizeRegionName(name), { region: name, ranked: [] }]));
    partResults.forEach((groups, partIndex) => {
        for (const group of groups) {
            const key = normalizeRegionName(group.region);
            if (!byKey.has(key)) { byKey.set(key, { region: canonicalNames.get(key) ?? group.region, ranked: [] }); }
            const bucket = byKey.get(key);
            group.candidates.forEach((candidate, rank) => bucket.ranked.push({ ...candidate, rank, partIndex }));
        }
    });
    const merged = [];
    for (const { region, ranked } of byKey.values()) {
        ranked.sort((a, b) => a.rank - b.rank || a.partIndex - b.partIndex);
        const seen = new Set();
        const candidates = [];
        for (const candidate of ranked) {
            const entry = entryByUid.get(candidate.uid);
            if (!entry || seen.has(candidate.uid)) continue;
            seen.add(candidate.uid);
            candidates.push({ uid: candidate.uid, label: entryTitle(entry), note: candidate.note });
        }
        if (candidates.length) merged.push({ region, candidates });
    }
    return merged;
}

function candidateLine(candidate) {
    return `  ${candidate.uid}. ${candidate.label}${candidate.note ? ` — ${candidate.note}` : ''}`;
}

/**
 * Если список кандидатов не влезает в бюджет — сначала убираем худшие по рангу (по одному, у региона с
 * наибольшим списком, минимум 1 на регион). Это управляемая деградация: отбрасываются только кандидаты
 * с низшим рангом, а не текст записей. `trimmed` — сколько убрано (для лога).
 */
export function trimCandidatesToBudget(groups, budgetTokens) {
    const working = groups.map(group => ({ region: group.region, candidates: [...group.candidates] }));
    const cost = () => working.reduce((sum, group) => sum + estimateTokens(group.region) + group.candidates.reduce((s, c) => s + estimateTokens(candidateLine(c)), 0), 0);
    let trimmed = 0;
    if (!(Number(budgetTokens) > 0)) return { groups: working, trimmed };
    while (cost() > budgetTokens) {
        const widest = working.reduce((best, group) => (group.candidates.length > best.candidates.length ? group : best), working[0]);
        if (!widest || widest.candidates.length <= 1) break;
        widest.candidates.pop();
        trimmed += 1;
    }
    return { groups: working, trimmed };
}

export function candidateListing(groups) {
    return groups.map(group => `Region "${group.region}":\n${group.candidates.map(candidateLine).join('\n')}`).join('\n\n');
}

/** Проход 1, reduce — итоговые 2 под-центра на регион среди кандидатов всех чанков. Ответ разбирает parseRegionSkeletonResponse(). */
export function buildSkeletonReducePrompt(groups, baseRegionNames) {
    return `A story's World Info was analyzed in parts. For each region, the best candidate entries from every part are listed below, best first (the note describes what each entry is).\n\n${candidateListing(groups)}\n\nFor EACH region choose exactly 2 entries (by number) that best represent it — the most foundational, representative ones. Use ONLY these regions, exactly as named: ${baseRegionNames.join(', ')}. Skip a region if none of its candidates truly fits. Choose only from the listed numbers.\n\nReply with ONLY a JSON array: [{"region": "region name", "subCenterUids": [number, number]}, ...]`;
}

/** Проход 2, reduce — центр для каждого региона + слияние одинаковых по смыслу НОВЫХ регионов. Ответ разбирает parseAdditionalCentersResponse(). */
export function buildCentersReducePrompt(groups, existingRegionNames, targetTotalRegions, entriesPerRegionCenter) {
    return `A story's World Info was analyzed in parts. These regions already exist: ${existingRegionNames.join(', ')}. Below, for every region (existing ones and NEW ones proposed by individual parts), the candidate CENTER entries from every part are listed, best first (the note describes what each entry is).\n\n${candidateListing(groups)}\n\nWe need:\n1. A CENTER entry (by number, chosen from the listed candidates) for EACH existing region — the single most defining entry for it.\n2. The NEW regions worth keeping, each with its center. Parts worked independently, so several proposed regions may be the SAME region under different names — merge those into one, using the clearest name. The target for the whole lore is about ${targetTotalRegions} regions in total (roughly one per ${entriesPerRegionCenter} entries) — deviate if the lore genuinely does not split that way. Do not assign one entry as the center of two regions.\n\nReply with ONLY a JSON array covering ALL regions (the ${existingRegionNames.length} existing ones AND any new ones): [{"region": "region name", "centerUid": number}, ...]`;
}

/**
 * Присвоение ОСТАЛЬНЫХ записей — argmax косинуса к уже размещённым
 * центрам/под-центрам (не ко всем 15 дартборд-ячейкам — у семантических
 * регионов их просто нет). `anchors` — ноды с известным `regionId`
 * (центры/под-центры). Всегда находит регион, если есть хоть один якорь —
 * нет "накопителя"/неуверенности, как у дартборд-каскада: сравнение с
 * реальными эмбедингами однозначно.
 */
export function pickNearestRegion(embedding, anchors) {
    let bestRegionId = null;
    let bestScore = -Infinity;
    for (const anchor of anchors) {
        if (!anchor?.embedding || !anchor?.regionId) continue;
        const score = cosineSimilarity(embedding, anchor.embedding);
        if (score > bestScore) { bestScore = score; bestRegionId = anchor.regionId; }
    }
    return bestRegionId;
}

/**
 * Проход 3 — по ОДНОМУ вызову на КАЖДЫЙ регион, уже над реальными нодами
 * графа (`id` — id ноды, не lorebook uid: Проход 3 идёт ПОСЛЕ размещения).
 * Межрегиональные связи сюда не относятся — те продолжают ловиться
 * `extractCharacterNames()` внутри `attachToRegionByKey()`, как и раньше
 * (решено с пользователем: "пока оставим старым").
 */
export function buildRegionEdgesPrompt(regionNodes, { withKinds = false } = {}) {
    const listing = regionNodes.map(node => `${node.id}. ${node.label}: ${node.content}`).join('\n');
    if (withKinds) return `These entries all belong to the SAME region of a memory graph:\n\n${listing}\n\nDo two things.\n1. Propose meaningful connections BETWEEN these entries — which ones are genuinely related (not every pair needs one).\n2. Classify entries that are NOT plain lore facts: \"entity\" (a living being: character, creature), \"object\" (a thing, place or group; add \"subtype\": \"item\" | \"place\" | \"group\"). Leave out anything that is simply a fact or piece of world lore.\n\nReply with ONLY a JSON object, using the exact ids given above: {\"edges\": [{\"from\": \"id\", \"to\": \"id\"}, ...], \"kinds\": {\"id\": {\"kind\": \"entity\" | \"object\", \"subtype\": \"item\" | \"place\" | \"group\"}, ...}} (empty edges / kinds if nothing applies).`;
    return `These entries all belong to the SAME region of a memory graph:\n\n${listing}\n\nPropose meaningful connections BETWEEN these entries — which ones are genuinely related and would benefit from being linked (not every pair needs one). Reply with ONLY a JSON array of pairs, using the exact ids given above: [{"from": "id", "to": "id"}, ...] (empty array if truly nothing connects).`;
}

/** Разбор ответа Прохода 3 — фильтрует к валидным id региона, без петель на себя, без дублей (неориентированная пара). */
export function parseRegionEdgesResponse(parsed, regionNodes) {
    // Старый ответ — массив рёбер; расширенный (`withKinds`) — объект `{edges, kinds}`, здесь берутся только рёбра.
    if (!Array.isArray(parsed)) parsed = parsed && typeof parsed === 'object' ? parsed.edges : null;
    if (!Array.isArray(parsed)) return [];
    const validIds = new Set(regionNodes.map(node => node.id));
    const seen = new Set();
    const edges = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const from = String(item.from ?? '');
        const to = String(item.to ?? '');
        if (!validIds.has(from) || !validIds.has(to) || from === to) continue;
        const key = [from, to].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to });
    }
    return edges;
}

/**
 * Проход 4 (условный — только если после Прохода 3 + бэкбона реально
 * остались узлы без единой связи) — жалоба пользователя: Проход 3
 * НАМЕРЕННО необязателен ("not every pair needs one", пустой массив — тоже
 * валидный ответ), а `enforceBackboneConnectivity()` гарантирует минимум
 * только центрам/под-центрам, не обычным узлам. Итог — ноды всё ещё МОГУТ
 * остаться полностью изолированными, ровно та же "80% нод без единой связи"
 * проблема Alpha, ради которой весь LLM-бутстрап и затевался. В отличие от
 * ВСЕХ остальных SideCar-промптов файла (у каждого есть путь отказа —
 * `{"skip"/"distinct"/"DISCARD"}`), здесь отказа НЕТ НАМЕРЕННО: узел без
 * связи хуже узла с неидеальной связью, поэтому модели явно запрещено
 * пропустить хоть один запрошенный id.
 */
export function buildOrphanConnectionsPrompt(allNodes, orphanIds) {
    const listing = allNodes.map(node => `${node.id}. ${node.label}: ${node.content}`).join('\n');
    return `This is the full memory graph built so far (${allNodes.length} entries, by id):\n\n${listing}\n\nThe following entries currently have NO connection to anything else in the graph at all: ${orphanIds.join(', ')}.\n\nFor EVERY ONE of these disconnected entries, WITHOUT EXCEPTION, pick at least one OTHER entry from the full list above that it should connect to — the best genuine fit, even if the connection is loose. A disconnected entry is worse than one with an imperfect connection, so do not leave any of them out. Reply with ONLY a JSON array covering ALL ${orphanIds.length} disconnected entries, one item per entry: [{"id": "the disconnected entry's own id", "connectTo": ["id", ...]}, ...]`;
}

/** Разбор ответа Прохода 4 — отвечаем ТОЛЬКО за реально запрошенных сирот (модель не может попутно приписать связь кому-то ещё через этот путь), фильтрует к валидным id, без петель на себя, без дублей. */
export function parseOrphanConnectionsResponse(parsed, allNodes, orphanIds) {
    if (!Array.isArray(parsed)) return [];
    const validIds = new Set(allNodes.map(node => node.id));
    const orphanSet = new Set(orphanIds);
    const seen = new Set();
    const edges = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const from = String(item.id ?? '');
        if (!orphanSet.has(from)) continue;
        const targets = Array.isArray(item.connectTo) ? item.connectTo : [];
        for (const target of targets) {
            const to = String(target ?? '');
            if (!validIds.has(to) || to === from) continue;
            const key = [from, to].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ from, to });
        }
    }
    return edges;
}

/** Виды из расширенного ответа Прохода 3: `{ id: { kind, subtype } }` — только entity/object у известных id; всё остальное молча игнорируется (факт — значение по умолчанию). */
export function parseRegionKindsResponse(parsed, regionNodes) {
    const result = {};
    const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.kinds : null;
    if (!raw || typeof raw !== 'object') return result;
    const validIds = new Set(regionNodes.map(node => node.id));
    for (const [id, value] of Object.entries(raw)) {
        if (!validIds.has(id) || !value || typeof value !== 'object') continue;
        if (!['entity', 'object'].includes(value.kind)) continue;
        result[id] = { kind: value.kind, subtype: value.kind === 'object' && ['item', 'place', 'group'].includes(value.subtype) ? value.subtype : null };
    }
    return result;
}
