import test from 'node:test';
import assert from 'node:assert/strict';
import { isHttpUrl, classifyDrop } from '../libraries/shared/drop-classify.js';

test('isHttpUrl() accepts http/https and rejects anything the HTTP service could not fetch', () => {
    assert.equal(isHttpUrl('https://example.com/pic.webp'), true);
    assert.equal(isHttpUrl('http://example.com/pic.png'), true);
    assert.equal(isHttpUrl('file:///C:/pic.png'), false, 'local file paths must never reach the HTTP service');
    assert.equal(isHttpUrl('data:image/png;base64,xxx'), false, 'data: URLs are not network resources');
    assert.equal(isHttpUrl('not a url'), false);
    assert.equal(isHttpUrl(''), false);
});

test('classifyDrop() prefers a FILE over text (a mixed drop carries both — the file is primary)', () => {
    const file = { name: 'cat.webp', type: 'image/webp' };
    const result = classifyDrop({ files: [file], text: 'https://example.com/other.png' });
    assert.equal(result.kind, 'file');
    assert.equal(result.file, file);
});

test('classifyDrop() reads a dragged LINK from text, taking the first token only', () => {
    const result = classifyDrop({ files: [], text: 'https://example.com/pic.webp\r\nhttps://extra.com' });
    assert.equal(result.kind, 'url');
    assert.equal(result.url, 'https://example.com/pic.webp', 'uri-list lines/trailing junk must not leak into the URL');
});

test('classifyDrop() honestly reports "none" for plain text that is not a URL — nothing shown, nothing guessed', () => {
    assert.deepEqual(classifyDrop({ files: [], text: 'just some words' }), { kind: 'none' });
    assert.deepEqual(classifyDrop({}), { kind: 'none' });
});
