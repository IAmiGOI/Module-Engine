import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionView } from '../cores/ui/decision-questions.js';
import { registerStInputService } from '../services/st-input.js';

function strings(node, out = []) {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) for (const child of node) strings(child, out);
    else if (node && typeof node === 'object' && Array.isArray(node.children)) strings(node.children, out);
    return out;
}

test('the question toast uses the section 16 texts and offers options, own answer and skip', () => {
    const subscriptions = {};
    const host = { events: { subscribe: (name, handler) => { subscriptions[name] = handler; return () => {}; } } };
    const call = async () => ({ ok: true, value: null });
    const view = createQuestionView({ host, call });
    view.subscribe();
    subscriptions['decision.question.asked']({ id: 'q1', question: 'Where does it start?', options: ['Before', 'After'], why: 'The world differs.', index: 1, total: 2 });
    const text = strings(view.tree()).join(' | ');
    assert.match(text, /The Director asks/);
    assert.match(text, /Question 1 of 2/);
    assert.match(text, /Where does it start\?/);
    assert.match(text, /The world differs\./);
    assert.match(text, /Before/);
    assert.match(text, /After/);
    assert.match(JSON.stringify(view.tree()), /Your own answer/);
    assert.match(text, /Skip — decide yourself/);
});

test('the ST input service disables and restores the textarea and send button', () => {
    const elements = { send_textarea: { disabled: false, style: {} }, send_but: { disabled: false, style: { pointerEvents: '', opacity: '' } } };
    const registered = {};
    const bus = { register: (name, handler) => { registered[name] = handler; return () => {}; } };
    registerStInputService(bus, { document: { getElementById: id => elements[id] ?? null } });
    registered['stInput.setLocked']({ locked: true });
    assert.equal(elements.send_textarea.disabled, true);
    assert.equal(elements.send_but.disabled, true);
    assert.equal(elements.send_but.style.pointerEvents, 'none', 'send_but is a div in ST: only pointer-events stops its clicks');
    registered['stInput.setLocked']({ locked: false });
    assert.equal(elements.send_textarea.disabled, false);
    assert.equal(elements.send_but.disabled, false);
    assert.equal(elements.send_but.style.pointerEvents, '');
});
