import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileLayer } from '../cores/decision/files-layer.js';
import { createCreationProvider } from '../cores/decision/files-creation.js';
import { createCreationStore } from '../cores/decision/creation.js';
import { renderScaleFile, parseScaleFile } from '../libraries/core/creation-files.js';

function world() {
    const memory = new Map();
    const call = async (contract, params) => {
        if (contract === 'storage.chatMemory.get') return memory.has(params.key) ? memory.get(params.key) : params.fallback;
        if (contract === 'storage.chatMemory.set') { memory.set(params.key, params.value); return true; }
        return null;
    };
    const creation = createCreationStore({ call });
    const layer = createFileLayer();
    layer.addProvider(createCreationProvider({ creation, state: { rpLabel: '2026-03-07 04:15' } }));
    return { creation, layer };
}

test('God writes a section and a system of weight as files, edits one line, and a new Discoveries line is a Discovery', async () => {
    const { creation, layer } = world();
    const listed = await layer.list();
    assert.ok(listed.includes('Creation/geography.md'));
    await layer.create({ path: 'Creation/geography.md', text: 'The capital stands on three hills.', comment: 'From the lorebook.' });
    assert.equal(creation.section('Geography').text, 'The capital stands on three hills.');
    await layer.edit({ edits: [{ path: 'creation/geography', old: 'three hills', new: 'five hills' }], comment: 'Correction.' });
    assert.equal(creation.section('Geography').text, 'The capital stands on five hills.');
    const scale = '# Mana\n\n**Principle:** Imagination shapes matter.\n**Payment:** Mana and focus.\n\n## Shape matter\n- Needs: a clear image of the result\n- Yields: the imagined object\n- Weight: hard; rises with the size of the object\n- Limit: nothing alive\n\n## Discoveries';
    await layer.create({ path: 'Creation/Scales/mana.md', text: scale, comment: 'The system of magic.' });
    const system = creation.state().scales[0];
    assert.equal(system.name, 'Mana');
    assert.equal(system.rules[0].name, 'Shape matter');
    assert.equal(system.rules[0].weight.level, 'hard');
    const read = await layer.read('Creation/Scales/mana.md');
    await layer.edit({ edits: [{ path: 'Creation/Scales/mana.md', old: '## Discoveries', new: '## Discoveries\n- [Shape matter] Imagining oxygen under an object for a long time makes it hover.' }], comment: 'A Prayer.' });
    const after = creation.state().scales[0];
    assert.equal(after.discoveries.length, 1);
    assert.equal(after.discoveries[0].rule, 'Shape matter');
    assert.match(after.discoveries[0].text, /hover/);
    assert.ok(read.text.includes('**Principle:** Imagination shapes matter.'));
});

test('a system of weight survives render → parse unchanged', () => {
    const system = { name: 'Mana', principle: 'P', payment: 'Q', rules: [{ name: 'R', needs: ['a', 'b'], yields: ['c'], weight: { level: 'hard', text: 'hard', rises: 'size', falls: '' }, scaling: [], limit: ['d'], cost: [], links: [], examples: ['e'] }], discoveries: [] };
    const parsed = parseScaleFile(renderScaleFile(system));
    assert.equal(parsed.system, 'Mana');
    assert.deepEqual(parsed.rules[0].needs, ['a', 'b']);
    assert.equal(parsed.rules[0].weight, 'hard; rises with size');
});
