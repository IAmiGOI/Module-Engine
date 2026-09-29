import { labelMentioned } from '../beacons.js';
import { isCore, isEvent } from '../kinds.js';
import { addDirectedEdge } from '../edges.js';
import { addAliases } from '../subjects.js';

const MAX_CARD_LINKS = 8;

/**
 * Карточка персонажа в графе (structured): сущность-Core, связанная с тем, что о ней говорится, и без дублей. Раньше нода карточки
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

    /** Рёбра карточки к связанным нодам; возвращает число созданных. Только structured (в legacy рёбра по имени создаёт размещение). */
    function linkCard(node, content) {
        if (!ctx.features.kinds) return 0;
        const related = Object.values(ctx.nodes)
            .filter(other => other.id !== node.id && !isEvent(other) && (
                labelMentioned(node.label, `${other.content ?? ''}\n${other.label ?? ''}`)
                || labelMentioned(other.label, content)))
            .sort((a, b) => Number(isCore(b)) - Number(isCore(a)) || (b.importance ?? 0) - (a.importance ?? 0))
            .slice(0, MAX_CARD_LINKS);
        let created = 0;
        for (const other of related) {
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
            Object.assign(existing, { content: card.content, embedding: embeddingResult.value, source: 'card', kind: 'entity', importance: Math.max(existing.importance ?? 0, ctx.mainCharacterImportance) });
            addAliases(existing, [card.label]);
            ctx.promoteToCore(existing.id, { manual: true });
            return { ok: true, nodeId: existing.id, status: 'placed', label: card.label, reused: true, links: linkCard(existing, card.content) };
        }
        const placed = ctx.placeNewNode({ label: card.label, content: card.content, embedding: embeddingResult.value, importance: ctx.mainCharacterImportance, kind: 'entity' }, { source: 'card' });
        const node = ctx.nodes[placed.nodeId];
        if (node && ctx.features.core) ctx.promoteToCore(placed.nodeId, { manual: true }); // главный герой — Core (этап 4 плана типов)
        return { ok: true, nodeId: placed.nodeId, status: placed.status, label: card.label, links: node ? linkCard(node, card.content) : 0 };
    }

    return { applyCharacterCard, characterName };
}
