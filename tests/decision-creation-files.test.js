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

test('the example system in the God prompt parses into a full rule', async () => {
    const { GOD_SYSTEM } = await import('../libraries/core/decision-prompts-god.js');
    const { parseScaleFile } = await import('../libraries/core/creation-files.js');
    const example = GOD_SYSTEM.split('--- example ---\n')[1].split('--- end of example ---')[0];
    const parsed = parseScaleFile(example);
    assert.equal(parsed.system, 'Ember Craft');
    assert.ok(parsed.principle && parsed.payment);
    assert.equal(parsed.rules.length, 1);
    for (const field of ['needs', 'yields', 'weight', 'scaling', 'limit', 'cost', 'links', 'examples']) assert.ok(parsed.rules[0][field]?.length, field);
    assert.match(parsed.rules[0].weight, /^easy;/);
});

test('a rule field written in bold is read, and rules lost by the old parser come back from God\'s own text in the log', async () => {
    const { parseScaleFile } = await import('../libraries/core/creation-files.js');
    const { repairEmptyRules } = await import('../cores/decision/creation-repair.js');
    const source = '# Spirit Arts\n**Principle:** Spirits answer a contract.\n**Payment:** atmospheric mana.\n\n## Invoke\n- **Needs:** a contract.\n- **Weight:** moderate; rises with a storm\n- **Examples:**\n  - a light in the dark\n';
    const parsed = parseScaleFile(source);
    assert.deepEqual(parsed.rules[0].needs, ['a contract.']);
    assert.deepEqual(parsed.rules[0].examples, ['a light in the dark']);
    const writes = [];
    const creation = { state: () => ({ scales: [{ name: 'Spirit Arts', rules: [{ name: 'Invoke' }] }, { name: 'Full', rules: [{ name: 'X', needs: ['y'] }] }] }), writeScale: async value => { writes.push(value); return { ok: true }; } };
    const cycles = [{ event: 'god_declaration', toolCalls: [{ name: 'create', args: { path: 'Creation/Scales/spirit-arts.md', text: source } }] }];
    assert.deepEqual(await repairEmptyRules({ creation, cycles }), ['Spirit Arts']);
    assert.equal(writes.length, 1, 'a system with filled rules is left alone');
    assert.deepEqual(writes[0].rules[0].needs, ['a contract.']);
});

test('a start hour taken from the empty engine clock is replaced by the opening scene', async () => {
    const { repairStartHour } = await import('../cores/decision/creation-repair.js');
    const writes = [];
    const creation = {
        state: () => ({ sections: [
            { title: 'The User in the World', text: '- Summoned on **Day 1, 00:00** directly in front of Emilia.' },
            { title: 'Politics and Conflicts', text: '- At 00:00 on Day 1, Emilia is in the Capital.' },
            { title: 'Geography', text: '- Three islands.' },
        ] }),
        writeSections: async ({ sections }) => { writes.push(...sections); return { ok: true }; },
    };
    assert.deepEqual(await repairStartHour({ creation }), ['The User in the World', 'Politics and Conflicts']);
    assert.match(writes[0].text, /Summoned in \*\*the story's opening scene\*\*/);
    assert.match(writes[1].text, /At the story's opening scene, Emilia/);
});
