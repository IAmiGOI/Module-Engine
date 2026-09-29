import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimelineSection } from '../cores/memory-graph/timeline-prompt.js';
import { addDirectedEdge } from '../cores/memory-graph/edges.js';

const make = (id, kind, extra = {}) => ({ id, label: id, content: `${id} content`, kind, edges: [], degree: 0, createdTurn: 0, ...extra });

function world() {
    const hero = make('Hero', 'entity');
    const events = [make('Duel', 'event', { gameTime: 10 }), make('Feast', 'event', { gameTime: 20 }), make('Exile', 'event', { gameTime: 30 })];
    for (const event of events) addDirectedEdge(hero, event);
    return { hero, events, byId: Object.fromEntries([hero, ...events].map(n => [n.id, n])) };
}

test('events of an anchor node are listed in time order under Recent events', () => {
    const { byId } = world();
    const text = buildTimelineSection(byId, ['Hero']);
    assert.match(text, /^Recent events:\n- Duel: Duel content\n- Feast: Feast content\n- Exile: Exile content/);
});

test('only the latest events are shown when there are more than the limit, still in time order', () => {
    const { byId } = world();
    const text = buildTimelineSection(byId, ['Hero'], { max: 2 });
    assert.equal(text.includes('Duel'), false);
    assert.ok(text.indexOf('Feast') < text.indexOf('Exile'));
});

test('a next chain among shown events is added as one line with arrows', () => {
    const { byId, events } = world();
    addDirectedEdge(events[0], events[1]);
    addDirectedEdge(events[1], events[2]);
    assert.match(buildTimelineSection(byId, ['Hero']), /Order: Duel -> Feast -> Exile$/);
});

test('events already shown by the main block are not repeated, and no events means no section', () => {
    const { byId } = world();
    assert.equal(buildTimelineSection(byId, ['Hero'], { excludeIds: new Set(['Duel']) }).includes('Duel'), false);
    assert.equal(buildTimelineSection({ Lone: make('Lone', 'entity') }, ['Lone']), null);
});
