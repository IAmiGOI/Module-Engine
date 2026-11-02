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

test('the decision card reads its state through the decision contracts and renders the always-on/rules/worker controls', async () => {
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
    for (const expected of ['Director / Writer', 'Always on', 'Director rules', 'Director model connection', 'Writer model connection', 'Limits and background workers', 'Director state', 'Memory bank', 'Arcs and character notes', 'Researcher reports', 'Forced summaries', 'Last decision', 'Director log (never shown in chat)']) {
        assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.deepEqual(calls.map(entry => entry.contract).sort(), [
        'decision.arcs', 'decision.bank', 'decision.clock', 'decision.lastRun', 'decision.library',
        'decision.log', 'decision.notes', 'decision.plan', 'decision.plans', 'decision.research', 'decision.roster',
        'decision.settings', 'model.presets.get', 'summary.forced',
    ]);
});
