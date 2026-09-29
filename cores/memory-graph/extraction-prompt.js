/**
 * Промпт извлечения фактов и разбор его ответа — MEMORY_GRAPH_FIX_PLAN.md, Этап 8 (ROADMAP 5.107з, П7 плана).
 * Старый промпт (`askSideCarForNode()`, cores/memory-graph/index.js) просил РОВНО один факт за раз и не знал о уже
 * существующих узлах рядом — похожий, но не идентичный факт ("Кира — наследница трона" → позже "Кира — наследница
 * ИМЕННО Варехского трона") плодил почти-дубль вместо уточнения уже созданной ноды, который потом приходилось
 * сливать отдельным, более дорогим проходом (`sweepMergeQueue`/SideCar). Новый формат просит модель САМУ решить —
 * создать новый факт или уточнить один из показанных рядом — и разрешает до 3 фактов за один ход вместо одного.
 */

/**
 * `nearestNodes` — до 6 ближайших к контексту узлов (`{id, label, content}`, ищет и сортирует вызывающий —
 * `cores/memory-graph/index.js`, по косинусу к contextEmbedding), показаны как готовые кандидаты на `"op":"update"`.
 * `isFirstNode` — та же подсказка "пустой граф", что была у старого промпта (см. её собственный смысл там).
 */
export function buildExtractionPrompt({ contextText, nearestNodes = [], isFirstNode = false } = {}) {
    const bootstrapHint = isFirstNode
        ? ' This is the very first memory in a fresh graph — consider whether the protagonist, another character, or a location is the most natural starting point, but decide freely.'
        : '';
    // Список кандидатов на обновление — только если он вообще есть (пустой граф/первый факт до этого не доживает).
    const nearestListing = nearestNodes.length
        ? `\n\nExisting nearby memories you may UPDATE instead of duplicating (use their id EXACTLY as given below, never invent one):\n${nearestNodes.map(node => `${node.id}: ${node.label} — ${node.content}`).join('\n')}`
        : '';
    return `Recent story context:\n\n${contextText}\n\nDoes this contain one or more facts worth remembering LONG-TERM — something that will still matter dozens of turns from now (a lasting character trait, a place, an established relationship, a major event or revelation)? Do NOT extract a short-term or purely situational arrangement that resolves on its own within the next few messages (a plan to meet somewhere, a small trade, a scheduling detail, idle small talk) — those are plot mechanics, not memories. If the text clearly establishes a new, lasting fact about a character, place, relationship, or event, extract it — do not default to skipping just because you are not 100% sure of the exact wording.${bootstrapHint}${nearestListing}

Examples of the judgment call:
- "The player agrees to meet the merchant at noon tomorrow." — resolves on its own within a few messages -> {"facts": []}
- "Kira admits, quietly, that she is the last surviving heir to the Varekh throne." -> {"facts": [{"op": "create", "label": "Kira's heritage", "content": "Kira is the last surviving heir to the Varekh throne.", "importance": 9}]}
- "Behind the waterfall the party finds a door that must lead into the old mine." -> {"facts": [{"op": "create", "label": "Hidden mine entrance", "content": "A hidden door behind the waterfall leads into the old mine.", "importance": 6}]}
- An existing memory above reads "node_3: Kira's heritage — Kira is royalty" and the text now reveals she is SPECIFICALLY the heir to the Varekh throne -> {"facts": [{"op": "update", "id": "node_3", "content": "Kira is the last surviving heir to the Varekh throne.", "importance": 9}]} (refines the SAME fact, does not create a near-duplicate)

Write every "content" so it reads correctly on its OWN, weeks later, without the surrounding scene: name every person/place/thing explicitly instead of "he"/"she"/"it"/"this place", and state the concrete detail instead of a vague summary like "something important happened". Reply with ONLY a JSON object: {"facts": [...]}, with UP TO 3 entries, each either {"op": "create", "label": short name, "content": the self-contained fact itself, "importance": a 0-10 score where 0-3 is minor/situational detail unlikely to matter again, 4-7 is a meaningful but secondary fact, and 8-10 permanently defines the character or world} or {"op": "update", "id": the exact id from the list above, "content": the corrected/expanded self-contained fact, "importance": same 0-10 scale}. If nothing here rises to that bar, reply with ONLY: {"facts": []}.`;
}

/**
 * Нормализует ответ модели в `{ facts: [...] }` независимо от формата. Обратная совместимость (П5 плана) — старый
 * голый `{label, content, importance}` (без `facts` вовсе) и `{skip: true}` тоже принимаются, оба сворачиваются в
 * этот же контракт (`{facts:[{op:'create',...}]}` / `{facts:[]}`) — вызывающему (`checkAndPlace()`) не нужно знать,
 * какая версия SideCar ответила. Невалидные записи (неизвестный `op`, отсутствующие обязательные поля, `id`
 * обновления не из `nearestNodeIds`) молча пропускаются — не роняют весь ответ целиком. Максимум 3 факта (П3 плана).
 */
export function parseExtractionResponse(parsed, nearestNodeIds = [], { structured = false } = {}) {
    if (!parsed || typeof parsed !== 'object') return { facts: [] };
    if (parsed.skip) return { facts: [] };
    if (!Array.isArray(parsed.facts)) {
        // Старый формат (до Этапа 8) — один голый факт, без обёртки `facts`/`op`.
        return parsed.label && parsed.content
            ? { facts: [{ op: 'create', label: String(parsed.label), content: String(parsed.content), importance: Number(parsed.importance) || 0 }] }
            : { facts: [] };
    }

    const knownIds = new Set(nearestNodeIds);
    const facts = [];
    for (const raw of parsed.facts) {
        if (facts.length >= (structured ? 4 : 3)) break; // П3 плана — максимум 3 факта за один check() (structured: 4 — событие и установленный им факт идут парой)
        if (!raw || typeof raw !== 'object') continue;
        if (raw.op === 'create') {
            if (!raw.label || !raw.content) continue;
            facts.push({ op: 'create', label: String(raw.label), content: String(raw.content), importance: Number(raw.importance) || 0, ...(structured ? parseStructuredFields(raw) : {}) });
        } else if (raw.op === 'update') {
            if (!raw.id || !knownIds.has(raw.id) || !raw.content) continue; // неизвестный/чужой id — игнорируется (П4 плана)
            facts.push({ op: 'update', id: String(raw.id), content: String(raw.content), importance: Number(raw.importance) || 0 });
        }
        // любой другой `op` — молча пропускается, не считается ни валидным, ни ошибкой всего ответа
    }
    return { facts };
}

const cleanNames = value => (Array.isArray(value) ? value : []).map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 8);

/**
 * Новые поля structured-ответа (все необязательные; битое поле даёт пустое значение, а не падение). `core` модель лишь
 * ПРЕДЛАГАЕТ — решает граф (этап 6). Неизвестный `kind` — `fact`.
 */
export function parseStructuredFields(raw) {
    const kinds = ['entity', 'object', 'fact', 'event'];
    const related = (Array.isArray(raw.related) ? raw.related : [])
        .map(item => ({ name: String(item?.name ?? '').trim(), relation: String(item?.relation ?? '').trim() }))
        .filter(item => item.name).slice(0, 6);
    const aliases = {};
    if (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)) {
        for (const [name, list] of Object.entries(raw.aliases)) {
            const names = cleanNames(list);
            if (name.trim() && names.length) aliases[name.trim()] = names;
        }
    }
    return {
        kind: kinds.includes(raw.kind) ? raw.kind : 'fact',
        subtype: ['item', 'place', 'group'].includes(raw.subtype) ? raw.subtype : null,
        coreProposed: raw.core === true,
        subjects: cleanNames(raw.subjects),
        related,
        time: typeof raw.time === 'string' && raw.time.trim() ? raw.time.trim() : null,
        aliases,
    };
}

/**
 * Промпт structured-режима: вид ноды, субъекты, связи, время, псевдонимы. Списки известных имён и главных героев не дают модели
 * плодить «Кира» / «принцесса Кира» / «Kira» отдельными нодами. Legacy-промпт не тронут (`buildExtractionPrompt`).
 */
export function buildStructuredExtractionPrompt({ contextText, nearestNodes = [], knownNames = [], mainCharacters = [], isFirstNode = false } = {}) {
    const nearest = nearestNodes.length ? `\n\nExisting nearby memories you may UPDATE instead of duplicating (use their id EXACTLY as given):\n${nearestNodes.map(node => `${node.id}: ${node.label} — ${node.content}`).join('\n')}` : '';
    const names = knownNames.length ? `\n\nKnown characters and objects in memory (use these names EXACTLY; invent a new name only if none fits): ${knownNames.join('; ')}` : '';
    const heroes = mainCharacters.length ? `\nMain characters of this chat: ${mainCharacters.join('; ')}` : '';
    const first = isFirstNode ? ' This is the very first memory of a fresh graph.' : '';
    return `Recent story context:\n\n${contextText}\n\nExtract what is worth remembering LONG-TERM (dozens of turns from now); skip short-term plot mechanics and idle talk.${first}${names}${heroes}${nearest}

Give every memory a "kind":
- "fact": something true that stays true (a trait, a rule of the world, an established relationship).
- "event": something that HAPPENED at a specific moment ("admitted", "left", "was killed") — a point on the timeline.
- "entity": a living being taking part in the story; "object": a thing, place or group (set "subtype": "item" | "place" | "group").
Also give "subjects" (names of who or what it is about; the main one first, names from the list above), optional "related" [{"name", "relation"}] for other participants, "time" (only if the text states when), and "aliases" {"Name": ["other way it is called"]} if the text shows another name for someone.
An event and the facts it established are SEPARATE memories: "Kira admits she is the heir" gives the event "Kira reveals her heritage" AND the fact "Kira is the heir to the Varekh throne".

Write every "content" so it reads on its OWN weeks later: full names instead of "he"/"she"/"it", concrete details. Importance 0-10 (0-3 minor, 4-7 meaningful, 8-10 defines the character or world).
Reply with ONLY JSON: {"facts": [ {"op": "create", "kind": ..., "subtype": ..., "label": short name, "content": ..., "importance": ..., "subjects": [...], "related": [...], "time": ..., "aliases": {...}} or {"op": "update", "id": exact id from the list, "content": ..., "importance": ...} ]} with UP TO 4 entries, or {"facts": []} if nothing qualifies.`;
}
