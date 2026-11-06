import test from 'node:test';
import assert from 'node:assert/strict';
import { dropAnnouncedLines } from '../libraries/core/writer-cleanup.js';

test('a narration sentence that retells the next line is dropped; the line and other narration stay', () => {
    const text = [
        'He flicks an ear toward the stairs. He tells you to sit down and have the page ready before she comes back into view, because she will want to see it while it is still wet.',
        '"...So. Sit down. And be ready with the ink — because she is coming back up those stairs with paper and she will want to see the page while it is still wet."',
    ].join('\n\n');
    const cleaned = dropAnnouncedLines(text);
    assert.doesNotMatch(cleaned, /He tells you to sit down/);
    assert.match(cleaned, /He flicks an ear toward the stairs\./);
    assert.match(cleaned, /"\.\.\.So\. Sit down\./);
});

test('lines inside quotes are never touched, and unrelated narration with a speech verb stays', () => {
    const text = '"...Mm. That is a straighter answer than I expected, and I will take it."\n\nShe asks about the weather, and he does not answer.\n\n"Rain later, maybe."';
    assert.equal(dropAnnouncedLines(text), text);
});
