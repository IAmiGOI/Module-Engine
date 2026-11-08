import test from 'node:test';
import assert from 'node:assert/strict';
import { createCounsellor } from '../cores/decision/counsellor.js';
import { openGodQuestions, renderGodQuestions, normalizeGodQuestions } from '../libraries/core/decision-god-queue.js';
import { GOD_ASKS_HEADER, COUNSELLOR_SYSTEM } from '../libraries/core/decision-prompts.js';

const comment = 'This is a full sentence of reason.';
const tc = (name, args) => ({ id: `${name}_${Math.random().toString(36).slice(2, 6)}`, name, arguments: { ...args } });

test('only the open questions are shown, with their id and what depends on the answer', () => {
    const questions = normalizeGodQuestions([
        { id: 'q1', question: 'Is there iron?', why: 'the mines', answer: '' },
        { id: 'q2', question: 'Who rules?', answer: 'The council.' },
    ]);
    assert.deepEqual(openGodQuestions(questions).map(item => item.id), ['q1']);
    const text = renderGodQuestions(questions);
    assert.match(text, /\[q1\] Is there iron\? — the mines/);
    assert.doesNotMatch(text, /Who rules/);
});

function counsellorWithGodQuestions(answers) {
    const requests = [];
    const queue = [...answers];
    const state = { questions: [{ id: 'q1', question: 'Is there iron?', why: 'the mines', answer: '' }], answers: [] };
    const store = {
        clock: () => ({ minutes: 0, updatedAt: 0 }),
        window: () => ({ entries: [] }),
        cycles: () => [],
        library: () => ({}),
        ledger: () => [],
        unreviewedLedger: () => [],
        petitions: () => [],
        prayers: () => [],
        conversation: () => [],
        god: () => ({ questions: state.questions.map(item => ({ ...item })), declaration: null }),
        answerGod: async ({ id, answer }) => {
            state.answers.push({ id, answer });
            state.questions = state.questions.map(item => (item.id === id ? { ...item, answer } : item));
            return { closed: true, declaration: { answers: [{ question: item.question, answer }] } };
        },
        appendCycle: async () => ({}),
        saveCounsellor: async () => ({}),
        markLedgerReviewed: async () => ({}),
    };
    const settings = {
        decider: { workerId: 'resolver', maxTokens: 8000, temperature: 0.7, topP: 1, topK: 0, reasoningMode: 'inherit', reasoningEffort: 'medium', reasoningBudget: 0 },
        counsellor: { workerId: '', everyTurns: 3, maxSteps: 12 },
        retry: { maxAttempts: 1, turnBudgetMs: 5000, backgroundBudgetMs: 5000, backups: {} },
    };
    const counsellor = createCounsellor({
        call: async (contract, params) => {
            if (contract === 'model.generate') {
                requests.push(params);
                const next = queue.shift();
                if (!next) throw new Error('the fake model ran out of answers');
                return next.toolCalls ? next : { text: '', toolCalls: next };
            }
            return null;
        },
        callTool: async () => ({ ok: true }), store,
        getSettings: () => settings, getWorkers: () => [{ id: 'resolver', format: 'openai' }],
        publishEvent: () => {}, enqueue: job => job(), now: () => 1000,
    });
    return { counsellor, requests, state };
}

test('the Counsellor reads God\'s questions and records the answer as a Declaration', async () => {
    const { counsellor, requests, state } = counsellorWithGodQuestions([
        [tc('god_answer', { id: 'q1', answer: 'Yes, under the reef.', comment })],
        [tc('await', { reason: 'Answered.', comment })],
    ]);
    const result = await counsellor.run({ runId: 'c1', mode: 'review' });
    assert.equal(result.ok, true);
    assert.deepEqual(state.answers, [{ id: 'q1', answer: 'Yes, under the reef.' }]);
    const context = requests[0].messages.map(message => message.content).join('\n\n');
    assert.ok(context.includes(GOD_ASKS_HEADER), 'the question block is in the context');
    assert.match(context, /\[q1\] Is there iron\?/);
    assert.ok(context.includes(COUNSELLOR_SYSTEM));
});
