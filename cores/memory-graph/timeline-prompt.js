import { timelineOf, sortEvents } from './edges.js';
import { isEvent } from './kinds.js';

/**
 * Секция таймлайна для промпта ретрива (MEMORY_GRAPH_TYPES_PLAN.md, этап 7). События — не маяки: они подтягиваются через
 * ноды, которые уже попали в блок (маяки, маршрут, шум), по рёбрам `participates`, и идут отдельной секцией «Recent events» в
 * хронологическом порядке — последние `max`. Цепочки `next` из показанных событий добавляются строкой со стрелками.
 * События, уже показанные основным блоком (`excludeIds`, например попавшие в шум), не повторяются. Нет событий — `null`.
 */
export function buildTimelineSection(nodesById, anchorIds, { max = 5, excludeIds = new Set() } = {}) {
    const found = new Map();
    for (const anchorId of anchorIds) {
        if (isEvent(nodesById[anchorId])) continue;
        for (const event of timelineOf(nodesById, anchorId)) if (!excludeIds.has(event.id)) found.set(event.id, event);
    }
    const shown = sortEvents([...found.values()]).slice(-max);
    if (!shown.length) return null;
    const lines = ['Recent events:', ...shown.map(event => `- ${event.label}: ${event.content}`)];
    const shownIds = new Set(shown.map(event => event.id));
    // Цепочки next среди показанных: начало — событие без входящего next из показанных.
    const nextOf = event => (event.edges ?? []).find(edge => edge.type === 'next' && edge.dir === 'out' && shownIds.has(edge.to))?.to;
    const hasPrevious = new Set(shown.map(nextOf).filter(Boolean));
    for (const event of shown) {
        if (hasPrevious.has(event.id) || !nextOf(event)) continue;
        const chain = [event];
        for (let next = nextOf(chain.at(-1)); next && chain.length < shown.length; next = nextOf(chain.at(-1))) chain.push(nodesById[next]);
        lines.push(`Order: ${chain.map(item => item.label).join(' -> ')}`);
    }
    return lines.join('\n');
}
