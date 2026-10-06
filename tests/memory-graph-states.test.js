import test from 'node:test';
import assert from 'node:assert/strict';
import { gameTimeKey, gameTimeLabel } from '../cores/memory-graph/game-time.js';
import { planSupersession, areStateVariants, normalizeAttribute, isCurrentState } from '../cores/memory-graph/states.js';
import { parseStructuredFields, buildStructuredExtractionPrompt } from '../cores/memory-graph/extraction-prompt.js';
import { timelineOf } from '../cores/memory-graph/edges.js';
import { renderMemoryPrompt } from '../cores/memory-graph/math.js';

// --- Игровое время RP Time ---------------------------------------------------------

test('gameTimeKey() orders RP Time snapshots of every preset: later is larger', () => {
    assert.ok(gameTimeKey({ year: '1', month: '1', day: '2', time: '08:00' }) > gameTimeKey({ year: '1', month: '1', day: '1', time: '23:00' }), 'full-date: the next day beats a late evening');
    assert.ok(gameTimeKey({ day: '3', time: '12:21' }) > gameTimeKey({ day: '3', time: '09:05' }), 'day-counter');
    assert.ok(gameTimeKey({ time: '10:30 PM' }) > gameTimeKey({ time: '09:20 AM' }), 'clock-only, 12-hour');
    assert.ok(gameTimeKey({ year: '2026', month: 'April', day: '1', time: '01:00 AM' }) > gameTimeKey({ year: '2026', month: 'March', day: '31', time: '11:59 PM' }), 'month names');
    assert.equal(gameTimeKey({ time: '12:05 AM' }), 5, '12 AM is just after midnight');
});

test('gameTimeKey() passes numbers through and gives null when nothing can be read', () => {
    assert.equal(gameTimeKey(42), 42);
    assert.equal(gameTimeKey(null), null);
    assert.equal(gameTimeKey({ period: 'Morning' }), null);
    assert.equal(gameTimeKey({ year: '—', time: '—' }), null);
});

test('gameTimeLabel() turns a snapshot into one short line', () => {
    assert.equal(gameTimeLabel({ year: '2026', month: 'March', day: '5', time: '09:20 AM', period: 'Morning' }), '2026 March 5 09:20 AM (Morning)');
    assert.equal(gameTimeLabel({ day: '3', time: '12:21', period: 'Afternoon' }), '3 12:21 (Afternoon)');
    assert.equal(gameTimeLabel(null), null);
});

test('timelineOf() now puts events in RP Time order, even when they were created in a different order', () => {
    const event = (id, createdTurn, time) => ({ id, kind: 'event', createdTurn, gameTime: time, edges: [{ to: 'anchor', type: 'participates', dir: 'in' }] });
    const nodes = { anchor: { id: 'anchor', kind: 'entity', edges: ['late', 'early'].map(to => ({ to, type: 'participates', dir: 'out' })) }, late: event('late', 1, { day: '9', time: '10:00' }), early: event('early', 2, { day: '2', time: '10:00' }) };
    assert.deepEqual(timelineOf(nodes, 'anchor').map(item => item.id), ['early', 'late']);
});

// --- Состояния -----------------------------------------------------------------------

const state = (id, attribute, subject, extra = {}) => ({ id, kind: 'fact', attribute, subjectIds: [subject], ...extra });

test('planSupersession() makes a new value of the same attribute replace the current one for the same subject', () => {
    const nodes = { old: state('old', 'outfit', 'nyx'), made: state('made', 'outfit', 'nyx') };
    assert.deepEqual(planSupersession(nodes.made, nodes), { supersede: ['old'], supersededBy: null });
});

test('planSupersession() leaves other subjects, other attributes, events and already superseded states alone', () => {
    const nodes = {
        otherSubject: state('otherSubject', 'outfit', 'echidna'), otherAttribute: state('otherAttribute', 'mood', 'nyx'),
        event: { id: 'event', kind: 'event', attribute: 'outfit', subjectIds: ['nyx'] }, gone: state('gone', 'outfit', 'nyx', { supersededBy: 'x' }),
        made: state('made', 'outfit', 'nyx'),
    };
    assert.deepEqual(planSupersession(nodes.made, nodes).supersede, []);
});

test('planSupersession() uses RP Time: a memory of an EARLIER outfit does not replace the current one — it is the stale one', () => {
    const nodes = { now: state('now', 'outfit', 'nyx', { gameTime: { day: '5', time: '10:00' } }), flashback: state('flashback', 'outfit', 'nyx', { gameTime: { day: '1', time: '10:00' } }) };
    assert.deepEqual(planSupersession(nodes.flashback, nodes), { supersede: [], supersededBy: 'now' });
    const later = state('later', 'outfit', 'nyx', { gameTime: { day: '6', time: '08:00' } });
    assert.deepEqual(planSupersession(later, { ...nodes, flashback: { ...nodes.flashback, supersededBy: 'now' }, later }).supersede, ['now']);
});

test('a node without an attribute or without a subject never supersedes anything', () => {
    const plain = { id: 'p', kind: 'fact', subjectIds: ['nyx'] };
    assert.deepEqual(planSupersession(plain, { plain, other: state('other', 'outfit', 'nyx') }).supersede, []);
    const lonely = state('lonely', 'outfit', undefined, { subjectIds: [] });
    assert.deepEqual(planSupersession(lonely, { lonely, other: state('other', 'outfit', 'nyx') }).supersede, []);
});

test('areStateVariants() flags two values of one state of one subject — they must never be merged as duplicates', () => {
    assert.equal(areStateVariants(state('a', 'outfit', 'nyx'), state('b', 'outfit', 'nyx')), true);
    assert.equal(areStateVariants(state('a', 'outfit', 'nyx'), state('b', 'mood', 'nyx')), false);
    assert.equal(areStateVariants(state('a', 'outfit', 'nyx'), state('b', 'outfit', 'echidna')), false);
    assert.equal(isCurrentState({ supersededBy: 'x' }), false);
    assert.equal(normalizeAttribute('  Outfit  '), 'outfit');
});

// --- Промпт и разбор ответа ---------------------------------------------------------------

test('the extraction answer carries "attribute" (normalized), but events never do', () => {
    assert.equal(parseStructuredFields({ kind: 'fact', attribute: ' Outfit ' }).attribute, 'outfit');
    assert.equal(parseStructuredFields({ kind: 'event', attribute: 'outfit' }).attribute, '');
    assert.equal(parseStructuredFields({ kind: 'fact' }).attribute, '');
});

test('the extraction prompt explains attributes, forbids "update" for a changed state, and shows the RP Time clock when there is one', () => {
    const prompt = buildStructuredExtractionPrompt({ contextText: 'x', currentTime: '3 12:21 (Afternoon)' });
    assert.match(prompt, /"attribute"/);
    assert.match(prompt, /never an "update"/);
    assert.match(prompt, /Current in-world time: 3 12:21 \(Afternoon\)/);
    assert.doesNotMatch(buildStructuredExtractionPrompt({ contextText: 'x' }), /Current in-world time/);
});

test('renderMemoryPrompt() says since when a current state holds', () => {
    const nodes = { n: { id: 'n', label: 'Nyx outfit', content: 'Nyx wears a black coat.', attribute: 'outfit', timeLabel: '3 12:21 (Afternoon)' }, m: { id: 'm', label: 'Plain', content: 'A plain fact.' } };
    const text = renderMemoryPrompt({ segments: [], standalone: ['n', 'm'], noise: [] }, nodes);
    assert.match(text, /Nyx wears a black coat\. \[since 3 12:21 \(Afternoon\)\]/);
    assert.match(text, /- Plain \(unconnected\): A plain fact\.$/m);
});
