import test from 'node:test';
import assert from 'node:assert/strict';
import { providerInfo, cacheVerdict, extractCachedTokens } from '../libraries/core/pm-cache-hints.js';

const comparison = (sharedTokens, totalTokens, block = 'graph') => ({ sharedTokens, totalTokens, ratio: sharedTokens / totalTokens, culprit: { block, reason: 'content changed' } });

test('provider sources of ST are recognised under their usual names', () => {
    assert.equal(providerInfo('openrouter').name, 'OpenRouter');
    assert.equal(providerInfo('makersuite').name, 'Gemini');
    assert.equal(providerInfo('claude').explicit, true);
    assert.equal(providerInfo('something-else'), null);
});

test('a long shared start is good and a short one is reported with the block that broke it', () => {
    assert.equal(cacheVerdict('openai', comparison(3000, 3300)).verdict, 'good');
    const broken = cacheVerdict('openai', comparison(300, 3300));
    assert.equal(broken.verdict, 'broken');
    assert.ok(broken.text.includes('"graph"'));
    assert.equal(cacheVerdict('deepseek', comparison(100, 3300)).verdict, 'short', 'DeepSeek needs only 64 tokens, but the share is low');
});

test('Claude needs explicit markers so an automatic share does not count', () => {
    assert.match(cacheVerdict('claude', comparison(3000, 3300)).text, /marked parts/);
});

test('without two requests the verdict is unknown', () => {
    assert.equal(cacheVerdict('openai', null).verdict, 'unknown');
});

test('cached tokens are read from the usage shapes of the different APIs', () => {
    assert.equal(extractCachedTokens({ prompt_tokens_details: { cached_tokens: 1500 } }), 1500);
    assert.equal(extractCachedTokens({ prompt_cache_hit_tokens: 640 }), 640);
    assert.equal(extractCachedTokens({ cache_read_input_tokens: 2048 }), 2048);
    assert.equal(extractCachedTokens({}), null);
});
