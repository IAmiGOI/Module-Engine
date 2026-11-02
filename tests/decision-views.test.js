import test from 'node:test';
import assert from 'node:assert/strict';
import { logView, planView, libraryView, bankView, researchView } from '../cores/ui/panel-cards/decision-views.js';

function strings(node, out = []) {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const child of node) strings(child, out);
    else if (node && typeof node === 'object' && Array.isArray(node.children)) strings(node.children, out);
    return out;
}

test('the director log view shows cycles, tool calls with their comments, thinking and warnings — not bare JSON', () => {
    const tree = logView([{
        event: 'turn', at: 1, tokens: 42,
        toolCalls: [{ name: 'assess', comment: 'I need the chance before the form.', result: { ok: true }, error: null }],
        thinking: 'the guard is tired', warnings: ['close to the step limit'],
    }]);
    const text = strings(tree).join(' | ');
    assert.match(text, /turn/);
    assert.match(text, /assess/);
    assert.match(text, /I need the chance before the form/);
    assert.match(text, /the guard is tired/);
    assert.match(text, /close to the step limit/);
});

test('state views say honestly when there is nothing yet', () => {
    assert.match(strings(planView(null)).join(' '), /No director plan/);
    assert.match(strings(libraryView({}, [], { minutes: 0 })).join(' '), /library is empty/);
    assert.match(strings(bankView({})).join(' '), /bank is empty/);
    assert.match(strings(researchView([])).join(' '), /No research tasks/);
});

test('the library view shows level, plan and due time', () => {
    const text = strings(libraryView({ lena: { name: 'Lena', level: 1 } }, [{ character: 'Lena', summary: 'Find the key.', dueAt: 180 }], { minutes: 0 })).join(' | ');
    assert.match(text, /Lena — level 1/);
    assert.match(text, /Find the key/);
    assert.match(text, /due in 3 h/);
});
