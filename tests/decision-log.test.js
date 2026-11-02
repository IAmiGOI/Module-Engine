import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycleRecord, cycleTokens, totalLogTokens, trimThinking, compactLog, thinkingSection } from '../libraries/core/decision-log.js';

const cycle = (index, thinking = '') => createCycleRecord({
    id: `c${index}`, at: index, event: 'turn', thinking,
    messages: [{ role: 'assistant', content: `message ${index} ${'word '.repeat(20)}` }],
    toolCalls: [{ name: 'assess', args: { comment: 'why' }, result: { ok: true } }],
});

test('a cycle record counts its messages, tool calls and thinking', () => {
    const record = cycle(1, 'some thinking');
    assert.ok(record.tokens > 0);
    assert.equal(cycleTokens(record), record.tokens);
});

test('thinking is kept for the current cycle and the two previous ones, and only their text is dropped', () => {
    const cycles = [0, 1, 2, 3, 4, 5].map(index => cycle(index, `thought ${index}`));
    const trimmed = trimThinking(cycles, 2);
    assert.deepEqual(trimmed.map(record => record.thinking), ['', '', '', 'thought 3', 'thought 4', 'thought 5']);
    assert.equal(trimmed.length, 6, 'the records themselves stay');
    assert.match(thinkingSection(trimmed), /thought 5/);
    assert.doesNotMatch(thinkingSection(trimmed), /thought 2/);
});

test('the log compaction archives the oldest cycles first, keeps the current one, and never exceeds the archive limit', () => {
    const cycles = [0, 1, 2, 3].map(index => cycle(index, ''));
    const total = totalLogTokens(cycles);
    const result = compactLog(cycles, { limitTokens: totalLogTokens([cycles.at(-1)]), keepCurrent: true });
    assert.equal(result.cycles.length, 1, 'only the current cycle survives in the log');
    assert.equal(result.archived.length, 3);
    assert.ok(result.tokens < total);

    const tight = compactLog(cycles, { limitTokens: 1, archiveLimitTokens: 1, keepCurrent: true });
    assert.equal(tight.cycles.length, 1);
    assert.ok(tighterArchive(tight));
});

function tighterArchive(result) {
    return totalLogTokens(result.archived) <= 1;
}
