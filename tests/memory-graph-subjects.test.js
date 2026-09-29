import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSubject, addAliases } from '../cores/memory-graph/subjects.js';
import { parseExtractionResponse, buildStructuredExtractionPrompt } from '../cores/memory-graph/extraction-prompt.js';

const nodes = {
    a: { id: 'a', label: 'Kira', kind: 'entity', aliases: ['the princess'] },
    b: { id: 'b', label: 'Varekh Throne', kind: 'object' },
    c: { id: 'c', label: 'Kira and her path', kind: 'fact' },
    e: { id: 'e', label: 'Kira arrives', kind: 'event' },
};

test('a subject name resolves by exact label ignoring case', () => {
    assert.equal(resolveSubject('kira', nodes), 'a');
});

test('a subject name resolves by alias', () => {
    assert.equal(resolveSubject('The Princess', nodes), 'a');
});

test('a subject name resolves by whole word and prefers the shortest label, never an event', () => {
    assert.equal(resolveSubject('Kira Varekh', nodes), 'a');
    assert.equal(resolveSubject('Throne', nodes), 'b');
    assert.equal(resolveSubject('Kira arrives', { e: nodes.e }), null);
});

test('an unknown name resolves to nothing, and a partial letter match is not a word match', () => {
    assert.equal(resolveSubject('Marcus', nodes), null);
    assert.equal(resolveSubject('Kir', nodes), null);
});

test('aliases are added without duplicates, without the label itself, and at most eight', () => {
    const node = { label: 'Kira', aliases: ['the princess'] };
    assert.equal(addAliases(node, ['The Princess', 'kira', 'heir']), true);
    assert.deepEqual(node.aliases, ['the princess', 'heir']);
    addAliases(node, Array.from({ length: 20 }, (_, i) => `alias ${i}`));
    assert.equal(node.aliases.length, 8);
});

test('the old response format is still parsed and carries no structured fields', () => {
    const { facts } = parseExtractionResponse({ label: 'A', content: 'B', importance: 4 });
    assert.deepEqual(facts, [{ op: 'create', label: 'A', content: 'B', importance: 4 }]);
});

test('a structured response is normalized: unknown kind becomes fact, broken fields become empty, core is only a proposal', () => {
    const { facts } = parseExtractionResponse({ facts: [
        { op: 'create', label: 'X', content: 'Y', kind: 'weird', subjects: ['Kira', '', 5], related: [{ name: 'Marcus', relation: 'hides her' }, 'junk'], time: '  dawn ', aliases: { Kira: ['the princess'], Bad: 'nope' }, core: true },
    ] }, [], { structured: true });
    assert.equal(facts[0].kind, 'fact');
    assert.deepEqual(facts[0].subjects, ['Kira', '5']);
    assert.deepEqual(facts[0].related, [{ name: 'Marcus', relation: 'hides her' }]);
    assert.equal(facts[0].time, 'dawn');
    assert.deepEqual(facts[0].aliases, { Kira: ['the princess'] });
    assert.equal(facts[0].coreProposed, true);
});

test('the structured prompt lists known names and main characters and explains the kinds', () => {
    const prompt = buildStructuredExtractionPrompt({ contextText: 'text', knownNames: ['Kira', 'Marcus'], mainCharacters: ['Ann'] });
    assert.match(prompt, /Kira; Marcus/);
    assert.match(prompt, /Main characters of this chat: Ann/);
    assert.match(prompt, /"event"/);
});

test('a partial word match never lands on a fact, only on an entity or object', () => {
    assert.equal(resolveSubject('Marcus', { f: { id: 'f', label: 'Marcus is a smith', kind: 'fact' } }), null);
});
