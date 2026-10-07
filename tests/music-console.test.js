import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';

const html = await fs.readFile(new URL('../tools/music-server/console.html', import.meta.url), 'utf8');
const script = /<script[^>]*>([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';

test('the owner console script is valid JavaScript', () => {
    assert.ok(script.length > 1000);
    assert.doesNotThrow(() => new vm.Script(script, { filename: 'console.html' }));
});

test('every element the console script looks up by id exists in its markup — a missing one throws at load and kills the whole console', () => {
    const used = new Set([...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(match => match[1]));
    assert.ok(used.size > 20);
    const missing = [...used].filter(id => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, []);
});

test('ids in the console markup are unique', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(repeated, []);
});
