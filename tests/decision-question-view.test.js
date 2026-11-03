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

test('the question toast uses the section 16 texts and offers options, own answer and skip', async () => {
    const subscriptions = {};
    const host = { events: { subscribe: (name, handler) => { subscriptions[name] = handler; return () => {}; } } };
    let current = null;
    const call = async contract => ({ ok: true, value: contract === 'decision.question' ? current : null });
    const view = createQuestionView({ host, call });
    view.subscribe();
    current = { id: 'q1', question: 'Where does it start?', options: ['Before', 'After'], why: 'The world differs.', index: 1, total: 2 };
    subscriptions['decision.question.asked'](current);
    await new Promise(resolve => setTimeout(resolve, 0));
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

test('two questions in one model answer: after the first is answered the toast shows the second, not nothing', async () => {
    const subscriptions = {};
    const host = { events: { subscribe: (name, handler) => { subscriptions[name] = handler; return () => {}; } } };
    const queue = [{ id: 'q1', question: 'When?', options: ['A', 'B'], index: 1, total: 1 }];
    const call = async (contract, params) => {
        if (contract === 'decision.question') return { ok: true, value: queue[0] ?? null };
        if (contract === 'decision.answerQuestion') {
            // Ядро отвечает на первый вопрос, и цикл сразу задаёт второй — раньше, чем вернётся этот вызов.
            queue.shift();
            queue.push({ id: 'q2', question: 'How did they arrive?', options: ['C', 'D'], index: 1, total: 1 });
            subscriptions['decision.question.answered']?.({ id: params.id });
            subscriptions['decision.question.asked']?.(queue[0]);
            return { ok: true, value: { ok: true } };
        }
        return { ok: true, value: null };
    };
    const view = createQuestionView({ host, call });
    view.subscribe();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(strings(view.tree()).join(' | '), /When\?/);
    const option = JSON.stringify(view.tree()).includes('A');
    assert.ok(option);
    // Нажатие варианта «A» = ответ на первый вопрос.
    const find = (node, label) => {
        if (!node || typeof node !== 'object') return null;
        if (node.props?.['on:click'] && strings(node.children ?? []).join('').includes(label)) return node;
        for (const child of node.children ?? []) { const hit = find(child, label); if (hit) return hit; }
        return null;
    };
    await find(view.tree(), 'A').props['on:click']();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(strings(view.tree()).join(' | '), /How did they arrive\?/, 'the second question is on screen');
});
