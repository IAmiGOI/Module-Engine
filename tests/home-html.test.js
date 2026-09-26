import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, recentBlockHtml, characterBlockHtml, checklistBlockHtml, actionsBlockHtml, blockHtml, homeCss, visibleRecent } from '../libraries/shared/home-html.js';
import { FIRST_START_ITEMS, RECENT_MAX_ROWS } from '../libraries/shared/home-model.js';

test('outside text is escaped: it goes into an SVG that the browser parses as XML', () => {
    assert.equal(escapeHtml(`<b>"Tom" & 'Jerry'</b>`), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
    const html = recentBlockHtml([{ character: '<img onerror=x>', chatName: 'a&b', date: '1.1.2026' }]);
    assert.ok(!html.includes('<img') && !html.includes('<script'));
    assert.ok(html.includes('&lt;img onerror=x&gt;') && html.includes('a&amp;b'));
    assert.ok(characterBlockHtml('<i>x</i>').includes('&lt;i&gt;x&lt;/i&gt;'));
});

test('the recent-chats block has one row per chat (capped), a friendly empty text, and never prints "undefined"', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ character: `C${i}`, chatName: `f${i}`, date: 'd' }));
    assert.equal(visibleRecent(many).length, RECENT_MAX_ROWS);
    assert.equal((recentBlockHtml(many).match(/hb-row-name/g) ?? []).length, RECENT_MAX_ROWS);
    assert.ok(recentBlockHtml([]).includes('No recent chats yet'));
    const partial = recentBlockHtml([{}]);
    assert.ok(!partial.includes('undefined') && partial.includes('Unknown'));
});

test('the checklist shows every item, the progress line and marks done items', () => {
    const html = checklistBlockHtml(new Set(['model']));
    for (const item of FIRST_START_ITEMS) assert.ok(html.includes(escapeHtml(item.title)), item.id);
    assert.ok(html.includes(`1 of ${FIRST_START_ITEMS.length} done`));
    assert.equal((html.match(/hb-done/g) ?? []).length, 1);
});

test('blockHtml picks the body by kind; the css is inlined with the resolved tokens', () => {
    assert.ok(blockHtml({ kind: 'actions' }).includes('Quick actions'));
    assert.ok(blockHtml({ kind: 'checklist' }, { done: new Set() }).includes('First steps'));
    assert.ok(blockHtml({ kind: 'recent' }, { chats: [] }).includes('Recent chats'));
    assert.ok(blockHtml({ kind: 'character' }, { name: 'Alice' }).includes('Alice'));
    assert.ok(actionsBlockHtml().startsWith('<div class="hb">'));
    const css = homeCss({ text: '#111', accent: '#f00', font: 'Fira' });
    assert.ok(css.includes('#111') && css.includes('#f00') && css.includes('Fira'));
    assert.ok(!/\.hb \{[^}]*overflow/.test(css), 'the raster root must not clip (zero-height wrapper)');
    assert.ok(!/bottom:/.test(css), 'raster positions use top only');
});
