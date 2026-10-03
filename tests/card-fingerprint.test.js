import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCardFingerprint, extractPngChunks, CARD_VOLATILE_FIELDS, FINGERPRINT_PREFIX } from '../libraries/core/card-fingerprint.js';
import { computeGitBlobSha } from '../libraries/core/content-hash.js';
import { buildPng, buildCardPng, fakeCard, textChunk, fakeImageChunk } from './helpers/fake-png.js';

const hash = computeGitBlobSha;

test('extractPngChunks(): parses signature + chunks up to IEND, in order', () => {
    const png = buildPng([['IHDR', new Uint8Array([1, 2, 3])], ['IDAT', new Uint8Array([4, 5])]]);
    const chunks = extractPngChunks(png);
    assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual([...chunks[0].data], [1, 2, 3]);
});

test('extractPngChunks(): not a PNG (wrong signature) or truncated mid-chunk both return null', () => {
    assert.equal(extractPngChunks(new Uint8Array([1, 2, 3])), null);
    const png = buildPng([['IHDR', new Uint8Array(20)]]);
    assert.equal(extractPngChunks(png.subarray(0, png.length - 5)), null);
});

test('computeCardFingerprint(): two files with the same image and card but different create_date/chat (what ST rewrites on every import) fingerprint identically', async () => {
    const a = buildCardPng(fakeCard({ chat: 'Alice - 2026-01-01 @00h00m00s', create_date: '2026-01-01T00:00:00.000Z' }));
    const b = buildCardPng(fakeCard({ chat: 'Alice - 2026-03-14 @09h22m10s', create_date: '2026-03-14T09:22:10.000Z' }));
    const fpA = await computeCardFingerprint(a, { hash });
    const fpB = await computeCardFingerprint(b, { hash });
    assert.ok(fpA.startsWith(FINGERPRINT_PREFIX));
    assert.equal(fpA, fpB);
    // Sanity: the raw bytes actually differ (otherwise the test would prove nothing) — this is the whole bug being fixed.
    assert.notEqual(await hash(a), await hash(b));
});

test('computeCardFingerprint(): fav and data.extensions.fav also differ across an ST re-import (unsetPrivateFields always zeroes them) and must not affect the fingerprint', async () => {
    const starred = buildCardPng(fakeCard({ fav: true, data: { name: 'Alice', description: 'A test character.', extensions: { fav: true } } }));
    const reimported = buildCardPng(fakeCard({ fav: false, data: { name: 'Alice', description: 'A test character.', extensions: { fav: false } } }));
    assert.equal(await computeCardFingerprint(starred, { hash }), await computeCardFingerprint(reimported, { hash }));
});

test('computeCardFingerprint(): a real content change (description) changes the fingerprint', async () => {
    const a = buildCardPng(fakeCard({ description: 'Original.' }));
    const b = buildCardPng(fakeCard({ description: 'Rewritten.' }));
    assert.notEqual(await computeCardFingerprint(a, { hash }), await computeCardFingerprint(b, { hash }));
});

test('computeCardFingerprint(): a pixel change (different image chunk bytes) changes the fingerprint even with an identical card', async () => {
    const a = buildCardPng(fakeCard(), { imageLabel: 'IDAT-A' });
    const b = buildCardPng(fakeCard(), { imageLabel: 'IDAT-B' });
    assert.notEqual(await computeCardFingerprint(a, { hash }), await computeCardFingerprint(b, { hash }));
});

test('computeCardFingerprint(): key order inside the card JSON never affects the fingerprint', async () => {
    const a = buildCardPng({ name: 'Alice', spec: 'chara_card_v2', data: { name: 'Alice', description: 'Hi' } });
    const b = buildCardPng({ spec: 'chara_card_v2', name: 'Alice', data: { description: 'Hi', name: 'Alice' } });
    assert.equal(await computeCardFingerprint(a, { hash }), await computeCardFingerprint(b, { hash }));
});

test('computeCardFingerprint(): ccv3 takes priority over chara when both are present, matching ST\'s own reader', async () => {
    const png = buildCardPng(fakeCard({ description: 'From chara' }));
    // Overwrite just the ccv3 chunk with different content, keeping chara as-is — done at the raw-chunk level via buildPng directly.
    const chunks = [
        ['IHDR', new TextEncoder().encode('fake-header')], fakeImageChunk(),
        textChunk('chara', Buffer.from(JSON.stringify(fakeCard({ description: 'From chara' })), 'utf8').toString('base64')),
        textChunk('ccv3', Buffer.from(JSON.stringify(fakeCard({ description: 'From ccv3' })), 'utf8').toString('base64')),
    ];
    const built = buildPng(chunks);
    const viaCcv3Only = buildCardPng(fakeCard({ description: 'From ccv3' }), { includeCcv3: false });
    assert.equal(await computeCardFingerprint(built, { hash }), await computeCardFingerprint(viaCcv3Only, { hash }));
    assert.notEqual(await computeCardFingerprint(png, { hash }), await computeCardFingerprint(built, { hash }));
});

test('computeCardFingerprint(): a non-PNG blob returns null so the caller falls back to a plain byte hash', async () => {
    assert.equal(await computeCardFingerprint(new TextEncoder().encode('not a png at all'), { hash }), null);
});

test('computeCardFingerprint(): a structurally valid PNG with no chara/ccv3 text chunk (not a character card) returns null', async () => {
    const png = buildPng([['IHDR', new Uint8Array([1])], fakeImageChunk()]);
    assert.equal(await computeCardFingerprint(png, { hash }), null);
});

test('computeCardFingerprint(): a chara chunk whose base64 does not decode to JSON returns null instead of throwing', async () => {
    const png = buildPng([fakeImageChunk(), textChunk('chara', Buffer.from('not json', 'utf8').toString('base64'))]);
    assert.equal(await computeCardFingerprint(png, { hash }), null);
});

test('CARD_VOLATILE_FIELDS lists exactly the fields ST rewrites unconditionally on every PNG import (see the file doc-comment for the source citations)', () => {
    assert.deepEqual([...CARD_VOLATILE_FIELDS], ['create_date', 'chat', 'avatar', 'json_data', 'fav', 'data.extensions.fav']);
});

test('computeCardFingerprint(): a card with a huge embedded text chunk (hundreds of KB — lorebook, assets) still gets a fingerprint instead of null, so two copies of it are recognised as the same character', async () => {
    const big = 'lorem ipsum '.repeat(40000);   // ~480 KB of card JSON: far past the spread-arguments limit that used to throw a RangeError
    const a = buildCardPng(fakeCard({ description: big, chat: 'Alice - 1', create_date: '2026-01-01T00:00:00.000Z' }));
    const b = buildCardPng(fakeCard({ description: big, chat: 'Alice - 2', create_date: '2026-03-14T09:22:10.000Z' }));
    const fpA = await computeCardFingerprint(a, { hash });
    assert.ok(fpA?.startsWith(FINGERPRINT_PREFIX));
    assert.equal(fpA, await computeCardFingerprint(b, { hash }));
});
