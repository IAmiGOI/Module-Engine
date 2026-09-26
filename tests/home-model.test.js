import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterItems, BLOCK_KINDS, QUICK_ACTIONS, FIRST_START_ITEMS, RECENT_MAX_ROWS, BLOCK_SPACING, buildBlocks, blockSize, checklistProgress, itemsForEvent, composeHome, clampPlacement, toSaved,
    fromSaved, dragPlacement, isDrag, rectsCollide, findFreeSpot, characterBlockId,
} from '../libraries/shared/home-model.js';

const box = (id, w = 300, h = 100) => ({ id, kind: 'recent', w, h });
const overlapAny = list => list.some((a, i) => list.slice(i + 1).some(b => rectsCollide(a, b, 0)));

test('blocks: checklist first (until done or dismissed), then quick actions, the recent-chats list, then the character cards the user made', () => {
    assert.deepEqual(buildBlocks({}).map(block => block.kind), ['checklist', 'actions', 'recent']);
    const all = new Set(FIRST_START_ITEMS.map(item => item.id));
    assert.deepEqual(buildBlocks({ checklistDone: all }).map(block => block.kind), ['actions', 'recent'], 'a finished checklist goes away');
    assert.deepEqual(buildBlocks({ checklistDismissed: true }).map(block => block.kind), ['actions', 'recent'], 'a dismissed checklist goes away');
    const withCards = buildBlocks({ checklistDismissed: true, characterCards: ['a.png', 'b.png'] });
    assert.deepEqual(withCards.slice(2).map(block => [block.id, block.kind, block.avatar]), [['character:a.png', 'character', 'a.png'], ['character:b.png', 'character', 'b.png']]);
    assert.equal(characterBlockId('x.png'), 'character:x.png');
});

test('the recent-chats block is as tall as its rows (at least one — the empty message — and at most the cap)', () => {
    const h = count => blockSize(BLOCK_KINDS.RECENT, { count }).h;
    assert.equal(h(0), h(1));
    assert.ok(h(3) > h(2));
    assert.equal(h(50), h(RECENT_MAX_ROWS));
    assert.deepEqual(blockSize(BLOCK_KINDS.CHARACTER), { w: 150, h: 196 });
});

test('checklist progress counts the ticked items, names the next one and knows when it is complete; events tick the auto items', () => {
    assert.deepEqual(checklistProgress(new Set()), { done: 0, total: FIRST_START_ITEMS.length, next: FIRST_START_ITEMS[0].id, complete: false });
    const all = new Set(FIRST_START_ITEMS.map(item => item.id));
    assert.equal(checklistProgress(all).complete, true);
    assert.equal(checklistProgress(all).next, null);
    assert.deepEqual(itemsForEvent('model.workers.changed'), ['model']);
    assert.deepEqual(itemsForEvent('nothing'), []);
});

test('the start composition flows blocks into the shortest column, columns centered on the stage', () => {
    const blocks = [box('a', 300, 100), box('b', 300, 200), box('c', 300, 100)];
    const wide = composeHome({ width: 1000, height: 700, blocks });
    assert.equal(new Set(wide.map(p => p.x)).size, 3, 'three columns fit');
    const xs = wide.map(p => p.x);
    assert.equal(xs[0] + (xs[2] + 300 - xs[0]) / 2, 500, 'the composition is centered');
    const narrow = composeHome({ width: 340, height: 700, blocks });
    assert.equal(new Set(narrow.map(p => p.x)).size, 1, 'one column on a narrow stage');
    assert.ok(narrow[1].y > narrow[0].y && narrow[2].y > narrow[1].y, 'stacked in order');
});

test('every placement is fully inside the stage, even on a stage smaller than the block', () => {
    for (const stage of [{ width: 1920, height: 1080 }, { width: 320, height: 400 }, { width: 200, height: 60 }]) {
        const [p] = composeHome({ ...stage, blocks: [box('a')] });
        assert.ok(p.x >= 0 && p.y >= 0);
        assert.ok(p.x + p.w <= Math.max(stage.width, p.w) && p.y + p.h <= Math.max(stage.height, p.h));
    }
});

test('a saved position is kept as fractions of the free room: the block stays at "its" place when the window changes', () => {
    const block = box('a');
    const saved = toSaved({ x: 350, y: 300, w: 300, h: 100 }, { width: 1000, height: 700 });
    assert.deepEqual(saved, { fx: 0.5, fy: 0.5 });
    const [big] = composeHome({ width: 2000, height: 1000, blocks: [block], saved: { a: saved } });
    assert.deepEqual([big.x, big.y], [850, 450]);
    const [small] = composeHome({ width: 500, height: 400, blocks: [block], saved: { a: saved } });
    assert.deepEqual([small.x, small.y], [100, 150]);
    assert.deepEqual(fromSaved({ fx: 1, fy: 1 }, block, { width: 1000, height: 700 }), { x: 700, y: 600 });
});

test('saved blocks leave the flow: the rest still lay out from the top', () => {
    const placed = composeHome({ width: 340, height: 700, blocks: [box('a'), box('b')], saved: { a: { fx: 1, fy: 1 } } });
    assert.equal(placed.find(p => p.id === 'b').y, 24, 'b took the first slot');
    assert.deepEqual([placed.find(p => p.id === 'a').x, placed.find(p => p.id === 'a').y], [40, 600]);
});

test('blocks never overlap in the composition: two saved blocks on the same spot and a flowed block in their way are pushed apart', () => {
    const blocks = [box('a'), box('b'), box('c'), box('d')];
    const placed = composeHome({ width: 1000, height: 700, blocks, saved: { a: { fx: 0.5, fy: 0.5 }, b: { fx: 0.5, fy: 0.5 } } });
    assert.equal(placed.length, 4);
    assert.equal(overlapAny(placed), false);
    for (const p of placed) assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= 1000 && p.y + p.h <= 700, `${p.id} inside the stage`);
    const shrunk = composeHome({ width: 700, height: 500, blocks, saved: { a: { fx: 0.9, fy: 0.9 }, b: { fx: 0.9, fy: 0.85 } } });
    assert.equal(overlapAny(shrunk), false, 'still apart after the window got smaller');
});

test('a free spot is the NEAREST place where the block does not collide, keeps the spacing, and falls back to the clamped spot when the stage is full', () => {
    const others = [{ x: 100, y: 100, w: 200, h: 100 }];
    const stage = { width: 800, height: 600 };
    const desired = { x: 120, y: 110, w: 100, h: 50 };
    const spot = findFreeSpot(desired, others, stage);
    assert.equal(rectsCollide(spot, others[0]), false);
    assert.ok(Math.hypot(spot.x - desired.x, spot.y - desired.y) < 120, 'moved only as far as needed');
    assert.deepEqual(findFreeSpot({ x: 500, y: 400, w: 100, h: 50 }, others, stage), { x: 500, y: 400, w: 100, h: 50 }, 'already free — untouched');
    const full = findFreeSpot({ x: 0, y: 0, w: 100, h: 50 }, [{ x: 0, y: 0, w: 200, h: 200 }], { width: 200, height: 200 });
    assert.deepEqual([full.x, full.y], [0, 0], 'no room at all — better an overlap than a lost block');
    assert.equal(BLOCK_SPACING > 0, true);
});

test('dragging moves by the cursor delta and never leaves the stage; a small move is a click, not a drag', () => {
    const start = { id: 'a', x: 100, y: 100, w: 300, h: 100 };
    assert.deepEqual(dragPlacement(start, { dx: 50, dy: -30 }, { width: 1000, height: 700 }), { ...start, x: 150, y: 70 });
    const clamped = dragPlacement(start, { dx: 5000, dy: 5000 }, { width: 1000, height: 700 });
    assert.deepEqual([clamped.x, clamped.y], [700, 600]);
    assert.deepEqual(clampPlacement({ x: -40, y: -9, w: 10, h: 10 }, { width: 100, height: 100 }), { x: 0, y: 0, w: 10, h: 10 });
    assert.equal(isDrag({ dx: 2, dy: 2 }), false);
    assert.equal(isDrag({ dx: 6, dy: 0 }), true);
    assert.ok(blockSize('actions', { count: 7 }).h > blockSize('actions', { count: 2 }).h);
});

test('dragging into another block: it stops at the neighbour, slides along it, and never lands on it', () => {
    const stage = { width: 1000, height: 700 };
    const wall = { id: 'w', x: 500, y: 100, w: 200, h: 300 };
    const start = { id: 'a', x: 100, y: 200, w: 300, h: 100 };
    const blocked = dragPlacement(start, { dx: 250, dy: 0 }, stage, { others: [wall], last: start });
    assert.deepEqual([blocked.x, blocked.y], [100, 200], 'straight into the neighbour: stays on the last valid spot');
    const slide = dragPlacement(start, { dx: 250, dy: 300 }, stage, { others: [wall], last: start });
    assert.equal(rectsCollide(slide, wall), false);
    assert.notDeepEqual([slide.x, slide.y], [start.x, start.y], 'it slid instead of freezing');
    const free = dragPlacement(start, { dx: 20, dy: 20 }, stage, { others: [wall], last: start });
    assert.deepEqual([free.x, free.y], [120, 220]);
});

test('the character picker hides cards that already exist and filters by a name fragment, ignoring case', async () => {
    const { filterCharacters } = await import('../libraries/shared/home-model.js');
    const list = [{ avatar: 'a.png', name: 'Alice' }, { avatar: 'b.png', name: 'Bob' }, { avatar: 'c.png', name: 'Alicia' }];
    assert.deepEqual(filterCharacters(list).map(c => c.name), ['Alice', 'Bob', 'Alicia']);
    assert.deepEqual(filterCharacters(list, ' ALI ').map(c => c.name), ['Alice', 'Alicia']);
    assert.deepEqual(filterCharacters(list, 'ali', ['a.png']).map(c => c.name), ['Alicia']);
    assert.deepEqual(filterCharacters(list, 'zzz'), []);
});

test('widgets on the desktop come after the recent-chats list, sized by their definition (default when unknown), each with its own block id', () => {
    const blocks = buildBlocks({ checklistDismissed: true, widgets: [{ instanceId: 'w1', widgetId: 'clock', size: { w: 230, h: 130 } }, { instanceId: 'w2', widgetId: 'ghost' }] });
    assert.deepEqual(blocks.map(block => block.kind), ['actions', 'recent', 'widget', 'widget']);
    const [first, second] = blocks.slice(2);
    assert.deepEqual([first.id, first.instanceId, first.widgetId, first.w, first.h], ['widget:w1', 'w1', 'clock', 230, 130]);
    assert.deepEqual([second.id, second.w, second.h], ['widget:w2', 220, 130], 'an unknown widget keeps a default-size placeholder');
});

test('the quick actions: four links (Docs, Discord, GitHub ST, GitHub ME) and "Add widget" as its own full-width row at the end', () => {
    assert.deepEqual(QUICK_ACTIONS.map(action => action.id), ['docs', 'discord', 'github-st', 'github-me', 'add-widget']);
    assert.ok(QUICK_ACTIONS.filter(action => action.href).every(action => action.href.startsWith('https://')));
    const last = QUICK_ACTIONS.at(-1);
    assert.deepEqual([last.own, last.wide], ['addWidget', true]);
    assert.equal(QUICK_ACTIONS.filter(action => action.wide).length, 1, 'only that one is wide');
    assert.equal(QUICK_ACTIONS.find(action => action.id === 'github-me').href, 'https://github.com/IAmiGOI/Module-Engine');
});

test('the generic picker filter works on any list (by id, hiding the added ones)', () => {
    const items = [{ id: 'clock', name: 'Clock' }, { id: 'notes', name: 'Notes' }];
    assert.deepEqual(filterItems(items, 'no').map(item => item.id), ['notes']);
    assert.deepEqual(filterItems(items, '', ['clock']).map(item => item.id), ['notes']);
});
