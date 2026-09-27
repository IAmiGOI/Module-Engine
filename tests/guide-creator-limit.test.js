import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { parseGuideReply, plainText } from '../libraries/core/guide-markup.js';
import { parseArticle, selectArticles, trimHistory, estimateTokens } from '../libraries/core/guide-knowledge.js';
import { CREATOR } from '../libraries/core/guide-creator.js';
import { createGuideCore, HISTORY_TOKEN_LIMIT } from '../cores/guide/index.js';

const dir = new URL('../guide/', import.meta.url);
const read = path => fs.readFileSync(new URL(path, dir), 'utf8');

test('the history is cut from the TOP to fit the token limit; the newest turn always stays and the cut history starts with the user', () => {
    const turns = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index} ${'x'.repeat(396)}` }));
    assert.equal(estimateTokens('x'.repeat(396)), 103);
    const kept = trimHistory(turns, 450);
    assert.deepEqual(kept.map(turn => turn.content[0]), ['6', '7', '8', '9'], 'the newest four fit into 450 tokens');
    assert.equal(kept.at(-1), turns.at(-1));
    assert.equal(kept[0].role, 'user', 'never starts with an assistant reply');
    assert.equal(trimHistory(turns, 1).length, 1, 'even a tiny limit keeps the last turn');
    assert.equal(trimHistory(turns, 100000).length, 10, 'everything fits — nothing is cut');
    assert.equal(HISTORY_TOKEN_LIMIT, 10000);
});

test('a long chat goes to the model within the limit: the top of the history is dropped, the stored chat is untouched', async () => {
    const engine = createEngine();
    const bus = engine.buses.cores;
    const sent = [];
    bus.register('storage.settings.get', ({ fallback }) => fallback);
    bus.register('storage.settings.set', () => true);
    bus.register('model.workers.get', () => [{ id: 'w' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('ui.anchors.list', () => []);
    bus.register('model.generate', params => { sent.push(params); return 'ok'; });
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official' }), { publish: () => {}, mount: () => ({}), modules: { list: () => [], enabled: () => [] }, loadText: async path => read(path) });
    await guide.load();
    for (let index = 0; index < 30; index += 1) await guide.ask(`question ${index} ${'y'.repeat(1900)}`);
    const turns = sent.at(-1).messages.slice(1);
    const tokens = turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0);
    assert.ok(tokens <= HISTORY_TOKEN_LIMIT, `sent ${tokens} tokens of history`);
    assert.ok(turns.length < 60, 'the top was cut');
    assert.match(turns.at(-1).content, /question 29/);
    assert.equal(guide.messages.peek().length, 60, 'the chat itself keeps everything (up to its own cap)');
});

test('the creator card is a fixed block from code; asking about the creator brings the article with the facts, other questions do not', () => {
    assert.deepEqual(parseGuideReply('He is AmiGO.\n```creator\n{}\n```').map(segment => segment.block?.kind ?? segment.type), ['text', 'creator']);
    assert.equal(plainText('```creator\n{}\n```'), '[creator card]');
    assert.equal(CREATOR.name, 'AmiGO');
    assert.equal(CREATOR.discord, 'https://discord.com/users/614387880692940803');
    const articles = JSON.parse(read('knowledge/index.json')).articles.map(file => parseArticle(read(`knowledge/${file}`), file));
    for (const question of ['who made you?', 'who is the creator of this engine', 'how do I contact the developer', 'I want to leave feedback for the author']) {
        assert.ok(selectArticles(articles, question).some(article => article.title === 'The creator of Module Engine'), question);
    }
    assert.ok(!selectArticles(articles, 'how do I add a tracker').some(article => article.title === 'The creator of Module Engine'));
    const facts = articles.find(article => article.title === 'The creator of Module Engine').text;
    assert.ok(facts.includes('AmiGO') && facts.includes('614387880692940803'));
    assert.ok(!/\b(say|tell the user|answer with|reply with)\b/i.test(facts), 'facts only, no scripted wording');
});
