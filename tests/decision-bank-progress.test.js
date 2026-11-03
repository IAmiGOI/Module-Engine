import test from 'node:test';
import assert from 'node:assert/strict';
import { createBankProgressView } from '../cores/ui/decision-bank-progress.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('the bank panel slides in while banks build and slides out a few seconds after the last one is ready', async () => {
    const handlers = {};
    const host = { events: { subscribe: (name, handler) => { handlers[name] = handler; return () => {}; } } };
    let list = [
        { sourceKey: 'a', name: 'Emilia', status: 'pending' },
        { sourceKey: 'b', name: 'Elsa', status: 'pending' },
        { sourceKey: 'c', name: 'Puck', status: 'ready' },
    ];
    const timers = [];
    const view = createBankProgressView({
        host, call: async () => ({ ok: true, value: list }),
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    });
    view.subscribe();
    await tick();
    assert.equal(view.state().shown, true, 'queued banks open the panel');
    handlers['decision.bank.started']({ sourceKey: 'a', name: 'Emilia' });
    await tick();
    assert.equal(view.state().counts.active.length, 1);
    assert.equal(view.state().counts.queued, 1);
    list = list.map(record => ({ ...record, status: 'ready' }));
    handlers['decision.bank.ready']({ sourceKey: 'a' });
    await tick();
    assert.equal(view.state().counts.ready, 3);
    assert.equal(view.state().shown, true, 'it stays for a moment to show the result');
    assert.equal(timers.length, 1);
    timers[0].fn();
    assert.equal(view.state().shown, false, 'then it slides out');
});
