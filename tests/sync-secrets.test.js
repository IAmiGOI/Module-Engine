import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createBox, createPayloadJoiner, deriveFromPairingCode, deriveFromSecret, formatPairingCode, fromBase64Url,
    generateDeviceId, generatePairingCode, generateSecret, normalizePairingCode, splitPayload, toBase64Url,
} from '../libraries/core/sync-secrets.js';

test('a generated pairing code is ten unambiguous characters in two groups and round-trips through normalization', () => {
    for (let index = 0; index < 50; index += 1) {
        const code = generatePairingCode();
        assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
        assert.equal(formatPairingCode(normalizePairingCode(code)), code);
    }
});

test('typed codes are read leniently: case, spaces, dashes and look-alike letters', () => {
    assert.equal(normalizePairingCode('k7qm4 x2p9d'), 'K7QM4X2P9D');
    assert.equal(normalizePairingCode('K7QM4-X2P9D'), 'K7QM4X2P9D');
    assert.equal(normalizePairingCode('OIL00-11111'), '0110011111');
    assert.equal(normalizePairingCode('short'), null);
    assert.equal(normalizePairingCode('K7QM4-X2P9U'), null, 'U is not in the alphabet');
    assert.equal(normalizePairingCode(undefined), null);
});

test('the same code always derives the same room and key, a different code never does', async () => {
    const first = await deriveFromPairingCode('K7QM4-X2P9D');
    const again = await deriveFromPairingCode('k7qm4x2p9d');
    const other = await deriveFromPairingCode('K7QM4-X2P9E');
    assert.equal(first.topic, again.topic);
    assert.deepEqual(first.key, again.key);
    assert.notEqual(first.topic, other.topic);
    assert.match(first.topic, /^stme[0-9a-f]{32}$/);
    assert.equal(first.key.length, 32);
    await assert.rejects(deriveFromPairingCode('nope'), /not a valid pairing code/);
});

test('the long-lived secret derives a stable room that differs from any code-derived one', async () => {
    const secret = generateSecret();
    const a = await deriveFromSecret(secret);
    const b = await deriveFromSecret(secret);
    const c = await deriveFromSecret(generateSecret());
    assert.equal(a.topic, b.topic);
    assert.deepEqual(a.key, b.key);
    assert.notEqual(a.topic, c.topic);
    assert.equal(fromBase64Url(secret).length, 32);
});

test('a sealed envelope opens with the same key and reveals nothing to another key or to tampering', async () => {
    const { key } = await deriveFromSecret(generateSecret());
    const box = await createBox(key);
    const sealed = await box.seal({ kind: 'offer', sdp: 'v=0 ... ü' });
    assert.doesNotMatch(sealed, /offer|sdp/);
    assert.deepEqual(await box.open(sealed), { kind: 'offer', sdp: 'v=0 ... ü' });

    const stranger = await createBox((await deriveFromSecret(generateSecret())).key);
    assert.equal(await stranger.open(sealed), null);
    assert.equal(await box.open(sealed.slice(0, -4) + 'AAAA'), null);
    assert.equal(await box.open('not base64 at all !!'), null);
    assert.notEqual(await box.seal({ a: 1 }), await box.seal({ a: 1 }), 'a fresh IV every time');
});

test('a long envelope is split into parts and joined back in any order, duplicates ignored', () => {
    const text = 'x'.repeat(7000) + 'end';
    const lines = splitPayload(text, 'msg1', 3000);
    assert.equal(lines.length, 3);
    const joiner = createPayloadJoiner();
    assert.equal(joiner.push(lines[2]), null);
    assert.equal(joiner.push(lines[0]), null);
    assert.equal(joiner.push(lines[0]), null);
    assert.equal(joiner.push(lines[1]), text);
    assert.equal(joiner.push(lines[1]), null, 'a finished message is not delivered twice');
    assert.equal(createPayloadJoiner().push('garbage'), null);
    assert.equal(createPayloadJoiner().push(JSON.stringify({ id: 'a', i: 5, n: 2, d: '' })), null);
    assert.equal(createPayloadJoiner().push(splitPayload('short', 'm')[0]), 'short');
});

test('base64url round-trips arbitrary bytes and ids are short hex', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
    assert.doesNotMatch(toBase64Url(bytes), /[+/=]/);
    assert.match(generateDeviceId(), /^[0-9a-f]{16}$/);
});
