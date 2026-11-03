import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionQueue } from '../cores/decision/questions.js';

function build() {
    const locks = [];
    const events = [];
    const queue = createQuestionQueue({
        callService: async (contract, params) => { if (contract === 'stInput.setLocked') locks.push(params.locked); return { ok: true }; },
        publishEvent: (event, payload) => events.push([event, payload]),
        now: () => 100,
    });
    return { queue, locks, events };
}

const question = 'Where does the story start?';
const options = ['Before the war', 'During the war', 'After the war'];

test('an option answer resolves the tool with the section 16 text and unlocks the input', async () => {
    const { queue, locks, events } = build();
    const pending = queue.ask({ question, options, why: 'This changes the world.', allowed: true, asked: 0, limit: 5 });
    assert.deepEqual(locks, [true]);
    const view = queue.pending();
    assert.equal(view.question, question);
    assert.equal(view.total, 1);
    queue.answer({ id: view.id, answer: 'During the war' });
    const result = await pending;
    assert.equal(result.text, 'The user answered: During the war');
    assert.equal(result.asked, true);
    assert.deepEqual(locks, [true, false]);
    assert.ok(events.some(([event]) => event === 'decision.question.asked'));
    assert.ok(events.some(([event]) => event === 'decision.question.answered'));
});

test('an own answer and a skip are different answers', async () => {
    const { queue } = build();
    const first = queue.ask({ question, options, allowed: true, asked: 0, limit: 5 });
    queue.answer({ id: queue.pending().id, answer: 'Somewhere else entirely' });
    assert.equal((await first).text, 'The user answered: Somewhere else entirely');
    const second = queue.ask({ question, options, allowed: true, asked: 1, limit: 5 });
    queue.answer({ id: queue.pending().id, skipped: true });
    assert.equal((await second).text, 'The user skipped the question. Decide it yourself and note your decision as an assumption.');
});

test('not allowed and the limit return the section 16 texts without asking', async () => {
    const { queue, locks } = build();
    const denied = await queue.ask({ question, options, allowed: false, asked: 0, limit: 5 });
    assert.match(denied.text, /available only in the chat bootstrap/);
    assert.equal(denied.asked, false);
    const limited = await queue.ask({ question, options, allowed: true, asked: 5, limit: 5 });
    assert.match(limited.text, /You have asked 5 questions already/);
    assert.equal(limited.asked, false);
    assert.deepEqual(locks, []);
});

test('questions are a queue: the input stays locked until the last answer', async () => {
    const { queue, locks } = build();
    const first = queue.ask({ question, options, allowed: true, asked: 0, limit: 5 });
    const second = queue.ask({ question: 'Second?', options, allowed: true, asked: 1, limit: 5 });
    assert.equal(queue.count(), 2);
    queue.answer({ id: queue.pending().id, answer: 'One' });
    await first;
    assert.deepEqual(locks, [true], 'the second question keeps the input locked');
    queue.answer({ id: queue.pending().id, answer: 'Two' });
    await second;
    assert.deepEqual(locks, [true, false]);
});

test('an empty question or one option is refused without locking the input', async () => {
    const { queue, locks } = build();
    const result = await queue.ask({ question: '', options: ['only'], allowed: true, asked: 0, limit: 5 });
    assert.match(result.text, /two to four concrete options/);
    assert.deepEqual(locks, []);
});

test('a chat switch closes the open questions as skipped and unlocks the input', async () => {
    const { createQuestionQueue } = await import('../cores/decision/questions.js');
    const locks = [];
    const queue = createQuestionQueue({ callService: async (contract, params) => { locks.push(params.locked); }, publishEvent: () => {} });
    const answer = queue.ask({ question: 'When?', options: ['A', 'B'], allowed: true });
    assert.equal(queue.locked(), true);
    queue.cancelAll();
    const result = await answer;
    assert.equal(result.skipped, true);
    assert.equal(queue.locked(), false);
    assert.equal(queue.count(), 0);
});
