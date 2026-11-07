import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecisionCycle, REMINDER_NO_TOOL } from '../libraries/core/decision-agent.js';

/** Скриптованная модель: каждый вызов берёт следующий ответ из массива. */
function scripted(answers) {
    const calls = [];
    return {
        calls,
        generate: async params => {
            calls.push(params);
            const next = answers.shift();
            if (!next) throw new Error('the script ran out of answers');
            return next;
        },
    };
}

const submit = (args = {}) => ({ text: '', toolCalls: [{ id: 'c', name: 'inscribe', arguments: { comment: 'The turn is ready to be written.', resolution: 'She leaves.', characters: [], ...args } }] });
const awaitCall = () => ({ text: '', toolCalls: [{ id: 'a', name: 'await', arguments: { comment: 'Nothing else happens between turns.', reason: 'next turn' } }] });

test('a tool call without a comment is rejected with a clear error, and the director can fix it and submit', async () => {
    const script = scripted([
        { text: '', toolCalls: [{ id: 'b', name: 'inscribe', arguments: { resolution: 'She leaves.' } }] },
        submit(),
    ]);
    const result = await runDecisionCycle({ messages: [{ role: 'user', content: 'go' }], generate: script.generate, handlers: { inscribe: args => ({ ok: true, form: args }) } });
    assert.equal(result.type, 'submit');
    assert.equal(result.trace[0].name, 'inscribe');
    assert.match(result.trace[0].error, /comment/);
    assert.equal(result.steps, 2);
});

test('a comment needs at least one full sentence, not just a word', async () => {
    const script = scripted([
        { text: '', toolCalls: [{ id: 'b', name: 'inscribe', arguments: { comment: 'because', resolution: 'x' } }] },
        submit(),
    ]);
    const result = await runDecisionCycle({ messages: [], generate: script.generate, handlers: { inscribe: args => ({ ok: true, form: args }) } });
    assert.match(result.trace[0].error, /comment/);
    assert.equal(result.type, 'submit');
});

test('assess then submit runs in order and the trace keeps both calls with their comments', async () => {
    const script = scripted([
        { text: '', toolCalls: [{ id: 'a1', name: 'assess', arguments: { character: 'Lena', action: 'opens the door', kind: 'body', difficulty: 'easy', experience: 'skilled', comment: 'I need the chance before writing the outcome.' } }] },
        submit({ characters: [{ name: 'Lena', assessId: 'a1' }] }),
    ]);
    const result = await runDecisionCycle({
        messages: [],
        generate: script.generate,
        handlers: {
            assess: () => ({ ok: true, id: 'a1', probability: 0.8, degree: 'flawless', words: 'flawlessly' }),
            inscribe: args => ({ ok: true, form: args }),
        },
    });
    assert.equal(result.type, 'submit');
    assert.deepEqual(result.trace.map(entry => entry.name), ['assess', 'inscribe']);
    assert.equal(result.trace[0].result.id, 'a1');
    assert.match(result.trace[0].comment, /chance/);
});

test('await ends the cycle immediately', async () => {
    const result = await runDecisionCycle({ messages: [], generate: scripted([awaitCall()]).generate, handlers: { await: () => ({ ok: true }) } });
    assert.equal(result.type, 'await');
    assert.equal(result.reason, 'next turn');
});

test('an answer without a tool call gets a reminder first, not a silent end', async () => {
    const script = scripted([{ text: 'I think she leaves.', toolCalls: [] }, submit()]);
    const result = await runDecisionCycle({ messages: [], generate: script.generate, handlers: { inscribe: args => ({ ok: true, form: args }) } });
    assert.equal(result.type, 'submit');
    assert.equal(result.trace[0].name, '__reminder');
    assert.equal(script.calls.length, 2);
    assert.ok(script.calls[1].messages.some(message => message.content === REMINDER_NO_TOOL));
});

test('the step guard stops a director that never submits or awaits', async () => {
    const script = scripted(Array.from({ length: 5 }, () => ({ text: '', toolCalls: [{ id: 'x', name: 'assess', arguments: { comment: 'Another look at the same action.' } }] })));
    const result = await runDecisionCycle({ messages: [], generate: script.generate, handlers: { assess: () => ({ ok: true }) }, maxSteps: 3 });
    assert.equal(result.type, 'guard');
    assert.match(result.reason, /step limit of 3/);
    assert.equal(script.calls.length, 3);
});

test('implicitAwait turns an answer without a tool into await when the setting asks for it', async () => {
    const result = await runDecisionCycle({ messages: [], generate: scripted([{ text: 'Nothing to do.', toolCalls: [] }]).generate, implicitAwait: true });
    assert.equal(result.type, 'await');
    assert.equal(result.implicit, true);
});

test('an external tool is called without the comment argument, but the comment stays in the trace', async () => {
    const seen = [];
    const script = scripted([
        { text: '', toolCalls: [{ id: 'n', name: 'Notebook', arguments: { action: 'write', title: 'Door', content: 'Open', comment: 'I must remember the door is open.' } }] },
        submit(),
    ]);
    const result = await runDecisionCycle({
        messages: [], generate: script.generate,
        handlers: { inscribe: args => ({ ok: true, form: args }) },
        callTool: async (name, args) => { seen.push({ name, args }); return 'note saved'; },
    });
    assert.equal(result.type, 'submit');
    assert.deepEqual(seen, [{ name: 'Notebook', args: { action: 'write', title: 'Door', content: 'Open' } }]);
    assert.match(result.trace[0].comment, /remember/);
});
