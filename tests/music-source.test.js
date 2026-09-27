import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_KINDS, parseMusicLink, sanitizeSource, isRemoteSource } from '../libraries/shared/music-source.js';

test('a direct audio link is recognised by its extension; pages, other schemes and non-links are refused', () => {
    assert.deepEqual(parseMusicLink('https://example.com/radio/stream.mp3?x=1'), { kind: 'url', url: 'https://example.com/radio/stream.mp3?x=1' });
    assert.deepEqual(parseMusicLink('example.com/a/b.flac'), { kind: 'url', url: 'https://example.com/a/b.flac' }, 'the scheme may be left out');
    for (const bad of ['', '   ', 'hello world', 'https://example.com/page.html', 'ftp://example.com/a.mp3', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', null, undefined]) {
        assert.equal(parseMusicLink(bad), null, String(bad));
    }
});

test('the saved source field is repaired: garbage, old tracks (no field) and services that are no longer supported play from the local file', () => {
    assert.deepEqual(sanitizeSource(undefined), { kind: 'local', ref: null });
    assert.deepEqual(sanitizeSource({ kind: 'url', ref: 'https://a.b/c.mp3' }), { kind: 'url', ref: 'https://a.b/c.mp3' });
    assert.deepEqual(sanitizeSource({ kind: 'url', ref: 'javascript:alert(1)' }), { kind: 'local', ref: null }, 'only http(s) streams');
    assert.deepEqual(sanitizeSource({ kind: 'youtube', ref: 'dQw4w9WgXcQ' }), { kind: 'local', ref: null });
    assert.equal(isRemoteSource({ kind: 'url', ref: 'https://a.b/c.mp3' }), true);
    assert.equal(isRemoteSource(null), false);
    assert.equal(SOURCE_KINDS.URL, 'url');
});
