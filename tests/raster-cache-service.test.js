import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseChatsToKeep } from '../services/raster-cache.js';

test('chooseChatsToKeep() keeps the 5 most recent chats plus the 2 largest of the rest', () => {
    const stats = [
        { chatKey: 'a', rows: 10, lastUsed: 100 }, { chatKey: 'b', rows: 10, lastUsed: 90 }, { chatKey: 'c', rows: 10, lastUsed: 80 },
        { chatKey: 'd', rows: 10, lastUsed: 70 }, { chatKey: 'e', rows: 10, lastUsed: 60 },
        { chatKey: 'big1', rows: 2800, lastUsed: 10 }, { chatKey: 'big2', rows: 2000, lastUsed: 5 }, { chatKey: 'small', rows: 3, lastUsed: 50 },
    ];
    const keep = chooseChatsToKeep(stats);
    assert.deepEqual([...keep].sort(), ['a', 'b', 'big1', 'big2', 'c', 'd', 'e']);
    assert.ok(!keep.has('small'), 'an old small chat is dropped');
});
