import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import characters, { pageCount, pageSlice } from '../widgets/characters/widget.js';
import { normalizeWidget, isValidInstance, WIDGET_LAYOUT } from '../libraries/shared/widget-contract.js';
import { HEAD_H, RECENT_ROW_H } from '../libraries/shared/home-model.js';
import { createCardsApi } from '../cores/ui/home/cards.js';

const people = Array.from({ length: 12 }, (_, i) => ({ avatar: `c${i}.png`, name: `Char ${i}`, thumbnail: `/t/c${i}.png`, image: `/characters/c${i}.png` }));

/** Фейковый host виджета: запросы записываются, ответы — по контрактам. */
function fakeHost({ list = people, cards = [], deleteResult = true } = {}) {
    const calls = [];
    const listeners = new Map();
    let invalidated = 0;
    const state = { list, cards: [...cards] };
    const host = {
        layout: WIDGET_LAYOUT,
        invalidate: () => { invalidated += 1; },
        subscribe: (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); },
        request: async (contract, params, options) => {
            calls.push({ contract, params, via: options?.via });
            if (contract === 'stHome.characters') return { ok: true, value: state.list };
            if (contract === 'desktop.cards.list') return { ok: true, value: state.cards };
            if (contract === 'desktop.cards.add') { state.cards.push(params.avatar); return { ok: true, value: true }; }
            if (contract === 'desktop.cards.remove') { state.cards = state.cards.filter(item => item !== params.avatar); return { ok: true, value: true }; }
            if (contract === 'stHome.deleteCharacter') { if (deleteResult) state.list = state.list.filter(item => item.avatar !== params.avatar); return { ok: true, value: deleteResult }; }
            return { ok: true, value: true };
        },
    };
    return { host, calls, listeners, state, invalidated: () => invalidated };
}

test('the characters widget follows the contract, declares exactly the contracts it uses, imports nothing, and its row layout matches the desktop', () => {
    assert.equal(normalizeWidget(characters).ok, true);
    assert.deepEqual([...characters.rights].sort(), ['desktop.cards.add', 'desktop.cards.list', 'desktop.cards.remove', 'stHome.characters', 'stHome.deleteCharacter', 'stHome.importCharacter', 'stHome.openCharacter']);
    assert.deepEqual([WIDGET_LAYOUT.rowsTop, WIDGET_LAYOUT.rowH], [HEAD_H, RECENT_ROW_H], 'the widget row layout is the recent-chats row layout');
    assert.equal(WIDGET_LAYOUT.searchH, 36);
    assert.equal(characters.size.h, HEAD_H + WIDGET_LAYOUT.searchH + 5 * RECENT_ROW_H + 14, 'the search line and five rows fit exactly');
    assert.equal(/^\s*import\s/m.test(readFileSync(new URL('../widgets/characters/widget.js', import.meta.url), 'utf8')), false, 'no imports — no dependencies');
});

test('paging: five per page, at least one page', () => {
    assert.equal(pageCount(0), 1);
    assert.equal(pageCount(5), 1);
    assert.equal(pageCount(6), 2);
    assert.deepEqual(pageSlice(people, 2).map(item => item.avatar), ['c10.png', 'c11.png']);
});

test('start loads the list and the desktop cards, subscribes to ST/desktop events, and shows page 1 with per-row buttons', async () => {
    const f = fakeHost({ cards: ['c1.png'] });
    const instance = characters.create(f.host);
    assert.equal(isValidInstance(instance), true);
    await instance.start();
    assert.deepEqual(f.calls.map(call => [call.contract, call.via]), [['stHome.characters', 'services'], ['desktop.cards.list', 'cores']]);
    assert.deepEqual([...f.listeners.keys()].sort(), ['st.characterDeleted', 'st.characterPageLoaded', 'ui.home.cardsChanged']);
    const rows = instance.rows();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0].actions.map(action => action.id), ['card-add', 'delete']);
    assert.deepEqual(rows[1].actions.map(action => action.id), ['card-remove', 'delete'], 'a character already on the desktop offers removing its card');
    assert.equal(rows[0].image, '/t/c0.png');
    const html = instance.html();
    assert.ok(html.includes('12 characters') && html.includes('page 1 of 3') && html.includes('Char 0') && html.includes('on the desktop'));
    assert.deepEqual(instance.actions.map(action => action.id), ['import', 'next'], 'import + next on the first page');
    instance.stop();
    assert.equal(f.listeners.size, 0, 'stop unsubscribes everything');
});

test('paging buttons move between pages and the header shows only the arrows that lead somewhere', async () => {
    const f = fakeHost();
    const instance = characters.create(f.host);
    await instance.start();
    await instance.onAction('next');
    assert.deepEqual(instance.actions.map(action => action.id), ['import', 'prev', 'next']);
    assert.equal(instance.rows()[0].id, 'c5.png');
    await instance.onAction('next');
    assert.deepEqual(instance.actions.map(action => action.id), ['import', 'prev']);
    await instance.onAction('next');
    assert.equal(instance.rows().length, 2, 'cannot go past the last page');
    instance.stop();
});

test('import opens the NATIVE ST file dialog through the service (the widget does not parse cards itself)', async () => {
    const f = fakeHost();
    const instance = characters.create(f.host);
    await instance.start();
    await instance.onAction('import');
    assert.deepEqual(f.calls.at(-1), { contract: 'stHome.importCharacter', params: {}, via: 'services' });
    instance.stop();
});

test('adding to the desktop and removing the card go through the desktop contracts and refresh the row buttons', async () => {
    const f = fakeHost();
    const instance = characters.create(f.host);
    await instance.start();
    await instance.onAction('card-add', 'c0.png');
    assert.deepEqual(f.calls.find(call => call.contract === 'desktop.cards.add'), { contract: 'desktop.cards.add', params: { avatar: 'c0.png' }, via: 'cores' });
    assert.equal(instance.rows()[0].actions[0].id, 'card-remove');
    await instance.onAction('card-remove', 'c0.png');
    assert.equal(instance.rows()[0].actions[0].id, 'card-add');
    instance.stop();
});

test('deleting asks first: the first trash click only shows a confirmation; "yes" deletes through ST (and drops the card), "cancel" changes nothing', async () => {
    const f = fakeHost({ cards: ['c0.png'] });
    const instance = characters.create(f.host);
    await instance.start();
    await instance.onAction('delete', 'c0.png');
    assert.equal(f.calls.some(call => call.contract === 'stHome.deleteCharacter'), false, 'nothing deleted by the first click');
    assert.deepEqual(instance.rows()[0].actions.map(action => action.id), ['confirm-delete', 'cancel']);
    assert.ok(instance.html().includes('Delete this character and its chats?'));
    await instance.onAction('cancel', 'c0.png');
    assert.deepEqual(instance.rows()[0].actions.map(action => action.id), ['card-remove', 'delete']);
    await instance.onAction('delete', 'c0.png');
    await instance.onAction('confirm-delete', 'c0.png');
    const order = f.calls.map(call => call.contract).filter(name => name === 'desktop.cards.remove' || name === 'stHome.deleteCharacter');
    assert.deepEqual(order, ['desktop.cards.remove', 'stHome.deleteCharacter'], 'the desktop card goes first, then the character');
    assert.deepEqual(f.calls.find(call => call.contract === 'stHome.deleteCharacter').params, { avatar: 'c0.png', deleteChats: true });
    assert.equal(instance.rows()[0].id, 'c1.png', 'the list was reloaded without it');
    instance.stop();
});

test('a failed deletion says so instead of pretending it worked', async () => {
    const f = fakeHost({ deleteResult: false });
    const instance = characters.create(f.host);
    await instance.start();
    await instance.onAction('delete', 'c0.png');
    await instance.onAction('confirm-delete', 'c0.png');
    assert.ok(instance.html().includes('Could not delete that character.'));
    assert.equal(instance.rows()[0].id, 'c0.png', 'the character is still there');
    instance.stop();
});

test('an ST event reloads the list (an import finished, a character was deleted elsewhere)', async () => {
    const f = fakeHost({ list: people.slice(0, 2) });
    const instance = characters.create(f.host);
    await instance.start();
    assert.equal(instance.rows().length, 2);
    f.state.list = people.slice(0, 3);
    f.listeners.get('st.characterPageLoaded')();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(instance.rows().length, 3);
    instance.stop();
});

test('the desktop card contracts add/remove/list, save and announce the change; duplicates and unknown files are refused', () => {
    const registered = new Map();
    const events = [];
    let saved = 0;
    let rendered = 0;
    const state = { cards: ['a.png'], saved: { 'character:a.png': { fx: 0.5, fy: 0.5 } } };
    const api = createCardsApi({
        host: { own: { register: (name, handler) => { registered.set(name, handler); return () => registered.delete(name); } } },
        state, save: () => { saved += 1; }, requestRender: () => { rendered += 1; }, emit: (event, payload) => events.push([event, payload]),
    });
    assert.deepEqual([...registered.keys()].sort(), ['desktop.cards.add', 'desktop.cards.list', 'desktop.cards.remove']);
    assert.equal(registered.get('desktop.cards.add')({ avatar: 'b.png' }), true);
    assert.equal(registered.get('desktop.cards.add')({ avatar: 'b.png' }), false, 'a card that already exists is not doubled');
    assert.equal(registered.get('desktop.cards.add')({}), false);
    assert.deepEqual(registered.get('desktop.cards.list')(), ['a.png', 'b.png']);
    assert.equal(registered.get('desktop.cards.remove')({ avatar: 'a.png' }), true);
    assert.equal('character:a.png' in state.saved, false, 'its saved position goes with it');
    assert.equal(registered.get('desktop.cards.remove')({ avatar: 'zzz.png' }), false);
    assert.deepEqual([saved, rendered, events.length], [2, 2, 2]);
    assert.deepEqual(events.at(-1), ['ui.home.cardsChanged', { cards: ['b.png'] }]);
    api.dispose();
    assert.equal(registered.size, 0);
});

test('clicking the character row opens its last chat through ST (the row declares click:"open"); the row also carries a fallback image', async () => {
    const f = fakeHost();
    const instance = characters.create(f.host);
    await instance.start();
    const [row] = instance.rows();
    assert.equal(row.click, 'open');
    assert.equal(row.imageFallback, '/characters/c0.png', 'a fresh import whose thumbnail fails still shows the original file');
    await instance.onAction(row.click, row.id);
    assert.deepEqual(f.calls.at(-1), { contract: 'stHome.openCharacter', params: { avatar: 'c0.png' }, via: 'services' });
    instance.stop();
});

test('the search line filters by name (any case), resets to the first page, counts matches, and shows a message when nobody matches', async () => {
    const f = fakeHost();
    const instance = characters.create(f.host);
    await instance.start();
    assert.deepEqual(instance.search, { placeholder: 'Search characters…', value: '' });
    await instance.onAction('next');
    assert.equal(instance.rows()[0].id, 'c5.png');
    instance.onSearch('CHAR 1');
    assert.deepEqual(instance.rows().map(row => row.id), ['c1.png', 'c10.png', 'c11.png'], 'page reset, only the matches');
    assert.ok(instance.html().includes('3 of 12'));
    assert.equal(instance.search.value, 'CHAR 1');
    assert.deepEqual(instance.actions.map(action => action.id), ['import'], 'no arrows when the matches fit one page');
    instance.onSearch('zzz');
    assert.equal(instance.rows().length, 0);
    assert.ok(instance.html().includes('Nobody matches the search.'));
    instance.onSearch('');
    assert.equal(instance.rows().length, 5);
    instance.stop();
});

test('text rows sit below the search line: their tops follow rowsTop + searchH', async () => {
    const f = fakeHost();
    const instance = characters.create(f.host);
    await instance.start();
    const html = instance.html();
    assert.ok(html.includes(`top:${WIDGET_LAYOUT.rowsTop + WIDGET_LAYOUT.searchH + 5}px`));
    instance.stop();
});
