import test from 'node:test';
import assert from 'node:assert/strict';
import { planView, libraryView, bankView, researchView } from '../cores/ui/panel-cards/decision-views.js';

function strings(node, out = []) {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const child of node) strings(child, out);
    else if (node && typeof node === 'object' && Array.isArray(node.children)) strings(node.children, out);
    return out;
}

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
