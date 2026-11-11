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

test('the report to the Counsellor holds deeds only: no form, no refused call, and the role\'s own account of what it could not do', () => {
    const report = statusReport({
        role: 'The Director', handled: ['Petition about Yuto: no bank'], account: 'Yuto has no card.md, so nothing could be written.',
        toolCalls: [
            { name: 'check_reports', args: { comment: 'Write banks for Yuto.' }, result: { ok: true } },
            { name: 'create', args: { path: 'Characters/Yuto/material.md', comment: 'Writing Yuto.' }, result: { ok: false, error: 'outside the form' } },
        ],
    });
    assert.match(report, /The Director changed nothing\./);
    assert.doesNotMatch(report, /check_reports|Writing Yuto/);
    assert.match(report, /The Director's own account: Yuto has no card\.md/);
});
