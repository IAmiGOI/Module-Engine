import test from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGER_MODES, computeTriggers, resolveTriggerMode, REPLY_EVENT, USER_MESSAGE_EVENT, TOOL_CALL_EVENT, BEFORE_SEND_EVENT } from '../libraries/core/trigger-modes.js';

test('every mode listed in TRIGGER_MODES round-trips through computeTriggers -> resolveTriggerMode, except manual (no triggers at all)', () => {
    for (const { value: mode } of TRIGGER_MODES) {
        if (mode === 'manual') continue;
        const triggers = computeTriggers(mode, 7);
        const resolved = resolveTriggerMode(triggers);
        assert.equal(resolved.mode, mode, `mode "${mode}" did not round-trip`);
    }
});

test('manual produces no triggers at all — it never fires on its own', () => {
    assert.deepEqual(computeTriggers('manual', 3), []);
});

test('beforeSend is a plain trigger here — no blocking/pipeline-stage concept at this layer', () => {
    assert.deepEqual(computeTriggers('beforeSend', 3), [{ event: BEFORE_SEND_EVENT }]);
});

test('everyNReplies/everyNMinutes carry the count through', () => {
    assert.deepEqual(computeTriggers('everyNReplies', 5), [{ event: REPLY_EVENT, every: 5 }]);
    assert.deepEqual(computeTriggers('everyNMinutes', 10), [{ every: { ms: 600000 } }]);
});

test('onUserMessage/onToolCall map to the real event names', () => {
    assert.deepEqual(computeTriggers('onUserMessage', 3), [{ event: USER_MESSAGE_EVENT }]);
    assert.deepEqual(computeTriggers('onToolCall', 3), [{ event: TOOL_CALL_EVENT }]);
});

test('resolveTriggerMode falls back to manual when there are no triggers', () => {
    assert.deepEqual(resolveTriggerMode([]), { mode: 'manual', count: 3 });
    assert.deepEqual(resolveTriggerMode(undefined), { mode: 'manual', count: 3 });
});

test('resolveTriggerMode keeps an unrecognized shape as "custom" instead of silently discarding it', () => {
    const weird = { event: 'some.other.event', debounceMs: 500 };
    assert.deepEqual(resolveTriggerMode([weird]), { mode: 'custom', count: 3, custom: weird });
});

test('resolveTriggerMode accepts a bare string trigger (legacy shape) the same as {event: string}', () => {
    assert.deepEqual(resolveTriggerMode([REPLY_EVENT]), { mode: 'everyReply', count: 3 });
});
