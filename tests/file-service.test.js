import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFileService } from '../services/file.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { makeFakeDocument } from './helpers/fake-document.js';

function fakeBrowserFileApi() {
    const blobs = [];
    const revokedUrls = [];
    let nextUrl = 0;
    return {
        blobs, revokedUrls,
        createBlob: (parts, options) => { const blob = { parts, options }; blobs.push(blob); return blob; },
        createObjectURL: blob => `blob:fake-${blobs.indexOf(blob)}-${nextUrl++}`,
        revokeObjectURL: url => revokedUrls.push(url),
    };
}

test('file.download builds a Blob with the given content/mimeType, clicks a real anchor with the right href/download attrs, then cleans up', async () => {
    const document = makeFakeDocument();
    const { createBlob, createObjectURL, revokeObjectURL, blobs, revokedUrls } = fakeBrowserFileApi();
    const bus = createContractBus();
    registerFileService(bus, { document, createBlob, createObjectURL, revokeObjectURL });

    const result = await new Promise(resolve =>
        bus.subscribe('file.download', { params: { filename: 'backup.json', content: '{"a":1}', mimeType: 'application/json' } }, resolve));

    assert.deepEqual(result, { ok: true, value: true });
    assert.deepEqual(blobs[0], { parts: ['{"a":1}'], options: { type: 'application/json' } });
    assert.equal(document.body.children.length, 0, 'the temporary anchor must be removed again after the click, not left in the tree');
    assert.equal(revokedUrls.length, 1, 'the object URL must be revoked after use, not leaked');
});

test('file.download\'s anchor is actually clicked, with the real filename/URL set as attributes before the click', async () => {
    const document = makeFakeDocument();
    const { createBlob, createObjectURL, revokeObjectURL } = fakeBrowserFileApi();
    const bus = createContractBus();
    let clickedAnchor = null;
    const originalCreateElement = document.createElement;
    document.createElement = tag => { const el = originalCreateElement(tag); if (tag === 'a') clickedAnchor = el; return el; };
    registerFileService(bus, { document, createBlob, createObjectURL, revokeObjectURL });

    await new Promise(resolve => bus.subscribe('file.download', { params: { filename: 'backup.json', content: 'x' } }, resolve));

    assert.equal(clickedAnchor.attributes.download, 'backup.json');
    assert.ok(clickedAnchor.attributes.href.startsWith('blob:'));
    assert.equal(clickedAnchor._clicked, 1);
});

test('file.download defaults mimeType to application/json when not given', async () => {
    const document = makeFakeDocument();
    const { createBlob, createObjectURL, revokeObjectURL, blobs } = fakeBrowserFileApi();
    const bus = createContractBus();
    registerFileService(bus, { document, createBlob, createObjectURL, revokeObjectURL });

    await new Promise(resolve => bus.subscribe('file.download', { params: { filename: 'x.json', content: '{}' } }, resolve));

    assert.equal(blobs[0].options.type, 'application/json');
});

test('file.readText reads a given File/Blob-like object\'s text via its own .text() method', async () => {
    const bus = createContractBus();
    registerFileService(bus, { document: makeFakeDocument() });
    const fakeFile = { text: async () => '{"restored":true}' };

    const result = await new Promise(resolve => bus.subscribe('file.readText', { params: { file: fakeFile } }, resolve));

    assert.deepEqual(result, { ok: true, value: '{"restored":true}' });
});

test('registerFileService()\'s returned unregister function retires both contracts', async () => {
    const bus = createContractBus();
    const unregister = registerFileService(bus, { document: makeFakeDocument() });

    unregister();
    const result = await new Promise(resolve => bus.subscribe('file.download', { params: { filename: 'x', content: 'x' } }, resolve));

    assert.equal(result.ok, false);
});
