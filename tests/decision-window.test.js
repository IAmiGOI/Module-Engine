import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { createDecisionWindowCore } from '../cores/ui/decision-window.js';
import { createCycleRecord } from '../libraries/core/decision-log.js';

const resolve = value => (typeof value === 'function' ? resolve(value()) : value);
function walk(node, match, out = []) {
    const value = resolve(node);
    if (Array.isArray(value)) { value.forEach(item => walk(item, match, out)); return out; }
    if (!value || typeof value !== 'object' || !value.tag) return out;
    if (match(value)) out.push(value);
    (value.children ?? []).forEach(child => walk(child, match, out));
    return out;
}
const textOf = node => {
    const value = resolve(node);
    if (Array.isArray(value)) return value.map(textOf).join('');
    if (value == null || value === false) return '';
    if (typeof value !== 'object') return String(value);
    return (value.children ?? []).map(textOf).join(' ');
};
const hasClass = (node, name) => String(resolve(node.props?.class) ?? '').split(/\s+/).includes(name);

function cycle(overrides = {}) {
    return createCycleRecord({
        id: 'cyc_1', runId: 'run_1', event: 'turn', at: 1000, endedAt: 1600, durationMs: 600,
        wake: { type: 'turn', label: 'A new turn has started' }, turn: 2, clockMinutes: 125,
        thinking: 'the guard is tired', warnings: ['close to the step limit'],
        toolCalls: [
            { name: 'assess', comment: 'I need the chance first.', args: { character: 'Lena', action: 'opens the door', kind: 'body', difficulty: 'easy', experience: 'skilled' }, result: { ok: true, character: 'Lena', action: 'opens the door', probability: 0.8, roll: 0.3, degree: 'flawless', words: 'flawlessly' } },
            { name: 'character_note', comment: 'The writer must know this.', args: { character: 'Lena' }, result: { ok: true } },
        ],
        form: { resolution: 'She leaves.', userResult: 'The user waits.', scene: { minutes: 2 }, characters: [{ name: 'Lena', decision: 'Leave', action: 'opens the door', outcome: 'It opens' }], meta: { place: 'Hall', timeBefore: 'noon', timeAfter: 'noon' } },
        push: 'PUSH TEXT', usage: { prompt: 100, completion: 20, cached: 40, total: 120 }, ...overrides,
    });
}

function build() {
    const engine = createEngine();
    const host = engine.registerCaller('core.ui.decisionWindow', 'cores', { tier: 'official' });
    let sent = [];
    const bankWrites = [];
    const bankList = [{ sourceKey: 'card:A', sourceKind: 'card', name: 'Aria', sizeBand: 'key', status: 'ready', text: '***Aria***\nA courier.', examples: '' }];
    host.own.register('decision.banks', () => bankList);
    host.own.register('decision.bankProgress', () => ({ status: 'ready', total: 1, done: 1, errors: 0, timedOut: false }));
    host.own.register('decision.bankWrite', params => { bankWrites.push(params); return { ok: true, bank: { ...bankList[0], text: params.text } }; });
    host.own.register('decision.bankRebuild', params => ({ ok: true, queued: true, name: params.name }));
    host.own.register('storage.settings.get', ({ fallback }) => fallback);
    host.own.register('storage.settings.set', () => true);
    host.own.register('decision.log', () => [cycle()]);
    host.own.register('decision.archive', () => [createCycleRecord({ id: 'old', event: 'time', wake: { label: 'The clock moved' } })]);
    host.own.register('decision.settings', () => ({ costCounter: true }));
    host.own.register('decision.message', params => {
        sent.push(params);
        return { ok: true, record: createCycleRecord({ event: 'message', message: { text: params.text, at: 5 } }) };
    });
    const panel = createDecisionWindowCore(host, { mount: node => ({ settled: async () => {}, getRoot: () => node, unmount() {} }) });
    return { engine, host, panel, sent: () => sent, bankWrites };
}

const flush = () => new Promise(done => setTimeout(done, 10));

test('the window starts closed, opens from the director event, and shows the whole feed', async () => {
    const { engine, panel } = build();
    await panel.open();
    assert.equal(panel.isVisible(), false);
    engine.events.emit('decisionWindow.openRequested', {});
    assert.equal(panel.isVisible(), true);
    await flush();
    const text = textOf(panel.tree());
    assert.match(text, /Director/);
    for (const expected of ['A new turn has started', 'I need the chance first', 'flawlessly', 'The form', 'Lena', 'PUSH TEXT', 'close to the step limit', '120 tokens', 'Archived arcs']) {
        assert.match(text, new RegExp(expected));
    }
    assert.match(text, /thinking…|the guard is tired/);
});

test('a live cycle appears immediately, its waiting indicator and calls update, and the stored cycle replaces it', async () => {
    const { engine, panel } = build();
    await panel.open();
    panel.show();
    await flush();
    engine.events.emit('decision.cycle.started', { runId: 'run_2', event: 'turn', wake: { label: 'A new turn has started' }, at: Date.now() });
    assert.ok(panel.feed.peek().live.run_2, 'the cycle is in the window before it ends');
    engine.events.emit('decision.cycle.step', { runId: 'run_2', phase: 'waiting', at: Date.now() });
    assert.equal(panel.feed.peek().live.run_2.waiting, true);
    assert.match(textOf(panel.tree()), /thinking…/);
    engine.events.emit('decision.tool.called', { runId: 'run_2', id: 'a1', name: 'assess', comment: 'Need the odds.', args: { character: 'Lena' } });
    assert.equal(panel.feed.peek().live.run_2.rows[0].comment, 'Need the odds.');
    engine.events.emit('decision.tool.result', { runId: 'run_2', name: 'assess', result: { ok: true, probability: 0.4, degree: 'clumsy', words: 'clumsily' } });
    assert.equal(panel.feed.peek().live.run_2.rows[0].kind, 'assess');
    engine.events.emit('decision.cycle.finished', { runId: 'run_2', cycle: cycle({ id: 'cyc_2', runId: 'run_2', at: 2000 }) });
    assert.equal(Object.keys(panel.feed.peek().live).length, 0);
    assert.equal(panel.feed.peek().cycles.length, 2);
});

test('filters hide thinking and select turns or passive cycles, and search narrows the feed', async () => {
    const { panel } = build();
    await panel.open();
    panel.showThinking.set(false);
    assert.equal(panel.filtered().cycles[0].rows.some(row => row.kind === 'thinking'), false);
    panel.showThinking.set(true);
    panel.onlyTurns.set(true);
    assert.deepEqual(panel.filtered().cycles.map(entry => entry.id), ['cyc_1']);
    panel.onlyTurns.set(false);
    panel.search.set('PUSH TEXT');
    assert.deepEqual(panel.filtered().cycles.map(entry => entry.id), ['cyc_1']);
    panel.search.set('not in the feed');
    assert.equal(panel.filtered().cycles.length, 0);
});

test('the message field sends to decision.message and never to the chat', async () => {
    const { panel, sent } = build();
    await panel.open();
    panel.draft.set('Make the night colder.');
    await panel.send();
    assert.deepEqual(sent()[0], { text: 'Make the night colder.' });
    assert.equal(panel.draft.peek(), '');
});

test('a rejected cycle is marked and dimmed, not removed', async () => {
    const { panel } = build();
    await panel.open();
    panel.show();
    await flush();
    panel.feed.set({ cycles: [{ ...panel.filtered().cycles[0], rejected: true }], archive: [], live: {} });
    // The Court: ход лежит в дорожке Resolver, а его Inscription — в дорожке Writer; отмечены обе.
    const node = walk(panel.tree(), item => hasClass(item, 'stme-dw-rejected'));
    assert.ok(node.length >= 1);
    const resolverLane = walk(panel.tree(), item => item.props?.['data-lane'] === 'resolver')[0];
    assert.equal(walk(resolverLane, item => hasClass(item, 'stme-dw-rejected')).length, 1);
});


test('the banks section shows cold-start progress and saves a hand-edited bank', async () => {
    const { panel, bankWrites } = build();
    await panel.open();
    panel.show();
    await flush();
    const text = textOf(panel.tree());
    assert.match(text, /Character banks: 1 of 1 ready/);
    assert.match(text, /Cold start: ready/);
    const area = walk(panel.tree(), node => node.tag === 'textarea' && hasClass(node, 'stme-dw-bank-text'))[0];
    assert.ok(area, 'the bank has an editable textarea');
    area.props['on:input']({ target: { value: '***Aria***\nEdited by hand.' } });
    const save = walk(panel.tree(), node => node.tag === 'button' && textOf(node) === 'Save bank')[0];
    save.props['on:click']();
    await flush();
    assert.deepEqual(bankWrites[0], { name: 'Aria', text: '***Aria***\nEdited by hand.' });
});
