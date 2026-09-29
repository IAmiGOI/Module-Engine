import { cosineSimilarity } from '../../../libraries/core/embedding.js';
import { labelMentioned } from '../beacons.js';
import { isCore, isEvent } from '../kinds.js';
import { addDirectedEdge } from '../edges.js';
import { addAliases } from '../subjects.js';

const MAX_CARD_LINKS = 8;
const MIN_HUB_LINKS = 3; // герой связан минимум с тремя ближайшими по смыслу центрами регионов
const MAX_HUB_LINKS = 6;
const HERO_IMPORTANCE = 9; // герой карточки в structured — среди самых важных нод графа (в legacy остаётся прежняя важность)

/**
 * Карточка персонажа в графе (structured): сущность-Core, ЦЕНТРАЛЬНАЯ для графа, и без дублей. Героя нельзя привязать только по
 * упоминаниям (в лоре его имя может не встречаться вовсе, хотя он связан со всем): поэтому он — узел-хаб, связанный с центрами
 * ближайших по смыслу регионов, плюс явные упоминания. Раньше нода карточки
 * создавалась «сама по себе» — без единого ребра, а при первом упоминании героя в чате появлялась ВТОРАЯ нода-заглушка под тем же
 * именем (граф, собранный вне чата или открытый из библиотеки, карточки не знал). Теперь: (1) если нода героя уже есть (заглушка,
 * прежняя карточка) — она дополняется, а не дублируется; (2) новая нода связывается с нодами, где упомянуто имя героя, и с нодами,
 * чьи названия упомянуты в самой карточке (до 8, Core первыми). `ctx` — доступ к состоянию Ядра, см. `core-ops.js`.
 */
export function createCardOps(ctx) {
    async function readCard() {
        const result = await ctx.callService('stCharacter.current');
        if (!result.ok || !result.value) return null;
        const label = String(result.value.name ?? '').trim() || 'Main Character';
        const content = [result.value.description, result.value.personality].map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n');
        return { label, content, keys: [] };
    }

    /** Имя активного персонажа или `null` (для распознавания героя в извлечении). */
    async function characterName() {
        const card = await readCard();
        return card ? card.label : null;
    }

    const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

    /** Уже существующая нода героя: карточка прежнего запуска или заглушка сущности с тем же именем (не событие). */
    function findExisting(label) {
        const candidates = Object.values(ctx.nodes).filter(node => !isEvent(node) && (same(node.label, label) || (node.aliases ?? []).some(alias => same(alias, label))));
        return candidates.find(node => node.source === 'card') ?? candidates.find(node => (node.kind ?? 'fact') === 'entity') ?? null;
    }

    /** Центры регионов, ближайшие по смыслу к карточке: заметно выше среднего сходства (mean + 0.5σ), но не меньше `MIN_HUB_LINKS` и не больше `MAX_HUB_LINKS`. */
    function hubCenters(node) {
        if (!Array.isArray(node.embedding)) return [];
        const centers = Object.values(ctx.regions).map(region => ctx.nodes[region.centerNodeId]).filter(center => center?.embedding && center.id !== node.id && !isEvent(center));
        const scored = centers.map(center => ({ center, similarity: cosineSimilarity(node.embedding, center.embedding) })).sort((a, b) => b.similarity - a.similarity);
        if (!scored.length) return [];
        const mean = scored.reduce((sum, item) => sum + item.similarity, 0) / scored.length;
        const std = Math.sqrt(scored.reduce((sum, item) => sum + (item.similarity - mean) ** 2, 0) / scored.length);
        const close = scored.filter(item => item.similarity >= mean + 0.5 * std);
        return (close.length >= MIN_HUB_LINKS ? close : scored.slice(0, MIN_HUB_LINKS)).slice(0, MAX_HUB_LINKS).map(item => item.center);
    }

    /** Рёбра карточки: к центрам ближайших регионов (хаб) и к нодам, где упомянут герой / чьи названия упомянуты в карточке. Число созданных. Только structured. */
    function linkCard(node, content) {
        if (!ctx.features.kinds) return 0;
        const mentioned = Object.values(ctx.nodes)
            .filter(other => other.id !== node.id && !isEvent(other) && (
                labelMentioned(node.label, `${other.content ?? ''}\n${other.label ?? ''}`)
                || labelMentioned(other.label, content)))
            .sort((a, b) => Number(isCore(b)) - Number(isCore(a)) || (b.importance ?? 0) - (a.importance ?? 0))
            .slice(0, MAX_CARD_LINKS);
        let created = 0;
        for (const other of [...hubCenters(node), ...mentioned]) {
            if ((node.edges ?? []).some(edge => edge.to === other.id)) continue; // уже связаны (например, `mentions` при размещении)
            if (!ctx.edgeAllowed(node, other)) continue;
            if (addDirectedEdge(node, other, 'related').created) created += 1;
        }
        return created;
    }

    /**
     * Создать (или дополнить) ноду карточки. НЕ ставит запись в очередь и не сохраняет — вызывающий уже внутри `enqueueWrite`
     * и сохраняет сам. `{ ok, nodeId, status, label, reused?, links }`; чат сменился по ходу — `{ status: 'chat-changed' }`.
     */
    async function applyCharacterCard({ epoch }) {
        const card = await readCard();
        if (!card) return { ok: false, error: 'No active character.' };
        if (!card.content) return { ok: false, error: 'Character card has no description/personality to import.' };
        const embeddingResult = await ctx.callService('embedding.compute', { text: `${card.label}: ${card.content}`, kind: 'passage' });
        if (!ctx.stillSameChat(epoch)) return { status: 'chat-changed' };
        if (!embeddingResult.ok) return { ok: false, error: embeddingResult.error.message };

        const existing = ctx.features.kinds ? findExisting(card.label) : null;
        if (existing) {
            // Заглушка/прежняя карточка дополняется настоящим описанием — второй ноды под тем же именем не появляется.
            Object.assign(existing, { content: card.content, embedding: embeddingResult.value, source: 'card', kind: 'entity', importance: Math.max(existing.importance ?? 0, HERO_IMPORTANCE) });
            addAliases(existing, [card.label]);
            ctx.promoteToCore(existing.id, { manual: true });
            return { ok: true, nodeId: existing.id, status: 'placed', label: card.label, reused: true, links: linkCard(existing, card.content) };
        }
        const placed = ctx.placeNewNode({ label: card.label, content: card.content, embedding: embeddingResult.value, importance: ctx.features.kinds ? HERO_IMPORTANCE : ctx.mainCharacterImportance, kind: 'entity' }, { source: 'card' });
        const node = ctx.nodes[placed.nodeId];
        if (node && ctx.features.core) ctx.promoteToCore(placed.nodeId, { manual: true }); // главный герой — Core (этап 4 плана типов)
        return { ok: true, nodeId: placed.nodeId, status: placed.status, label: card.label, links: node ? linkCard(node, card.content) : 0 };
    }

    /** Есть ли в графе нода героя ЭТОГО чата, уже ставшая карточкой (источник `card`) и Core. */
    async function hasHeroCard() {
        const name = await characterName();
        if (!name) return true; // нет персонажа — и добавлять нечего
        const existing = findExisting(name);
        return Boolean(existing && existing.source === 'card' && isCore(existing));
    }

    return { applyCharacterCard, characterName, hasHeroCard };
}
