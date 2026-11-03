import test from 'node:test';
import assert from 'node:assert/strict';

test('in a browser the embedding is computed in a worker, off the page\'s main thread', async () => {
    const posted = [];
    class FakeWorker {
        constructor(url, options) { this.url = String(url); this.options = options; }
        postMessage(data) {
            posted.push({ url: this.url, type: this.options?.type, data });
            setTimeout(() => this.onmessage({ data: { id: data.id, vector: [0.6, 0.8] } }), 0);
        }
    }
    globalThis.window = globalThis.window ?? {};
    globalThis.Worker = FakeWorker;
    try {
        const { embed } = await import(`../libraries/core/embedding.js?worker=${Date.now()}`);
        const vector = await embed('Emilia has silver hair.', { kind: 'query' });
        assert.deepEqual(vector, [0.6, 0.8]);
        assert.equal(posted.length, 1);
        assert.match(posted[0].url, /embedding-worker\.js$/);
        assert.equal(posted[0].type, 'module');
        assert.equal(posted[0].data.kind, 'query');
        assert.equal(posted[0].data.model, 'Xenova/e5-small-v2');
    } finally {
        delete globalThis.Worker;
        delete globalThis.window;
    }
});
