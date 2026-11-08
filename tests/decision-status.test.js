import test from 'node:test';
import assert from 'node:assert/strict';
import { statusReport, actionLines } from '../libraries/core/decision-status.js';

test('the Counsellor gets what God did with a Prayer from the record, not by waking God again', () => {
    const report = statusReport({
        role: 'God',
        handled: ['The world must start before Arc 1.'],
        toolCalls: [
            { name: 'view', args: { path: 'Creation/history.md' } },
            { name: 'edit', args: { edits: [{ path: 'Creation/history.md', old: 'a', new: 'b' }], comment: 'The story now starts before Arc 1.' } },
            { name: 'await', args: {} },
        ],
    });
    assert.match(report, /God has answered what you sent:\n- The world must start before Arc 1\./);
    assert.match(report, /- edit Creation\/history\.md — The story now starts before Arc 1\./);
    assert.doesNotMatch(report, /view|await/);
    assert.equal(statusReport({ role: 'God', handled: [] }), '', 'nothing sent — nothing to report');
    assert.deepEqual(actionLines([{ name: 'edit', error: 'refused', args: {} }]), []);
});
