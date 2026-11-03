import test from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '../cores/ui/reactive.js';
import { createDecisionCard } from '../cores/ui/panel-cards/decision-card.js';

function strings(node, out = []) {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const child of node) strings(child, out);
    else if (node && typeof node === 'object' && Array.isArray(node.children)) strings(node.children, out);
    return out;
}

test('the decision card reads its state through the decision contracts and renders the always-on/prompt/worker controls', async () => {
    const calls = [];
    const call = async (contract, params) => {
        calls.push({ contract, params });
        if (contract === 'decision.settings') return { ok: true, value: { rules: 'Never kill a named character.', regen: 'writer', decider: { workerId: 'director' }, writer: { applySampler: true } } };
        if (contract === 'decision.lastRun') return { ok: true, value: { decision: 'She leaves.' } };
        if (contract === 'model.presets.get') return { ok: true, value: [{ id: 'custom:mine', name: 'Mine' }] };
        return { ok: true, value: null };
    };
    const card = createDecisionCard({ call, collapse: { bind: () => ({}) }, notify: async () => ({ ok: true }), workers: signal([{ id: 'director', name: 'Director' }]) });

    await card.loadDecision();
    const node = card.decisionCard();
    assert.equal(node.tag, 'details');
    assert.match(node.props.class, /stme-card/);
    const text = strings(node).join(' | ');
    for (const expected of ['Director / Writer', 'Always on', 'Open prompts', 'Director model connection', 'Writer model connection', 'Limits and background workers', 'Writer check (classifier)', 'Director state', 'Memory bank', 'Arcs and character notes', 'Forced summaries', 'Last decision', 'Open director', 'The writer request goes to this connection: its endpoint, key and model.']) {
        assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.deepEqual(calls.map(entry => entry.contract).sort(), [
        'classifier.connections.get',
        'decision.arcs', 'decision.bank', 'decision.clock', 'decision.lastRun', 'decision.library',
        'decision.notes', 'decision.plan', 'decision.plans', 'decision.roster',
        'decision.settings', 'model.presets.get', 'summary.forced',
    ]);
});

function optionEntries(node, out = []) {
    if (typeof node === 'function') return optionEntries(node(), out);
    if (Array.isArray(node)) { for (const child of node) optionEntries(child, out); return out; }
    if (node && typeof node === 'object') {
        if (node.tag === 'option') out.push({ value: node.props?.value, label: (node.children ?? []).join('') });
        optionEntries(node.children, out);
    }
    return out;
}

function optionValues(node, out = []) {
    if (typeof node === 'function') return optionValues(node(), out);
    if (Array.isArray(node)) { for (const child of node) optionValues(child, out); return out; }
    if (node && typeof node === 'object') {
        if (node.tag === 'option') out.push(node.props?.value);
        optionValues(node.children, out);
    }
    return out;
}

test('every model connection is a separate pick in the director card when connection fields are signals', async () => {
    const call = async contract => (contract === 'decision.settings' ? { ok: true, value: {} } : { ok: true, value: null });
    const record = (id, model) => ({ id: signal(id), model: signal(model), format: signal('openai') });
    const workers = signal([record('connection_1', 'flash'), record('connection_2', 'writer-30b'), record('connection_3', 'big')]);
    const card = createDecisionCard({ call, collapse: { bind: () => ({}) }, notify: async () => ({ ok: true }), workers });

    await card.loadDecision();
    const values = optionValues(card.decisionCard());
    for (const id of ['connection_1', 'connection_2', 'connection_3']) assert.ok(values.includes(id), `no option for ${id}`);
    assert.ok(values.every(value => typeof value === 'string'), 'option values must be plain strings');
});


test('the writer pick says SillyTavern explicitly, while the director pick stays load-balanced', async () => {
    const call = async contract => (contract === 'decision.settings' ? { ok: true, value: {} } : { ok: true, value: null });
    const card = createDecisionCard({ call, collapse: { bind: () => ({}) }, notify: async () => ({ ok: true }), workers: signal([{ id: 'writer', name: 'Writer' }]) });
    await card.loadDecision();
    const entries = optionEntries(card.decisionCard());
    assert.ok(entries.some(entry => entry.value === '' && entry.label === 'SillyTavern connection (no override)'));
    assert.ok(entries.some(entry => entry.label === 'Any connection (load-balanced)'));
});
