import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { normalizeProbes, buildTestChat, describeTestResult, describeChatExcerpt, MAX_PROBES } from '../libraries/core/character-test.js';
import { createCharacterCardsCore } from '../cores/character-cards/index.js';
import { createGuideCore } from '../cores/guide/index.js';

test('probes need something to say, are limited to eight because each is a full generation, and keep the rule they check', () => {
    assert.equal(normalizeProbes([]).ok, false);
    assert.equal(normalizeProbes(Array.from({ length: MAX_PROBES + 1 }, () => 'hi')).ok, false);
    assert.equal(normalizeProbes([{ say: '  ' }]).ok, false);
    assert.deepEqual(normalizeProbes(['Who are you?', { say: 'Count your tails.', rule: 'Five Tails' }]).value, [{ rule: '', say: 'Who are you?' }, { rule: 'Five Tails', say: 'Count your tails.' }]);
});

test('the test chat starts with the card\'s first message, like a real chat, and carries every earlier probe with the reply it got', () => {
    const card = { name: 'Aria', first_mes: 'Who goes there?' };
    assert.deepEqual(buildTestChat(card, 'Sasha', [{ say: 'Me.', reply: 'Hm.' }, { say: 'Again.' }]), [
        { name: 'Aria', is_user: false, mes: 'Who goes there?' }, { name: 'Sasha', is_user: true, mes: 'Me.' }, { name: 'Aria', is_user: false, mes: 'Hm.' }, { name: 'Sasha', is_user: true, mes: 'Again.' },
    ]);
    assert.equal(buildTestChat({ name: 'Aria', first_mes: '' }, 'Sasha', [{ say: 'Hi' }]).length, 1, 'a card without a first message starts with the user\'s turn');
});

test('the transcript for the guide names the model, the preset and each probe with the rule it checks, and marks a cut reply', () => {
    const text = describeTestResult({ name: 'Aria', modelLabel: 'the main SillyTavern connection', presetName: 'AmiGO', results: [{ rule: 'Five Tails', say: 'Count.', reply: 'x'.repeat(4000) }, { rule: '', say: 'Hi', reply: '' }] });
    assert.match(text, /^Test of “Aria” on the main SillyTavern connection, preset “AmiGO”, isolated chat/);
    assert.match(text, /Probe 1 — checks: Five Tails\n\{\{user\}\}: Count\.\nAria: x+\n\[cut: 4000 characters in all\]/);
    assert.match(text, /Probe 2\n\{\{user\}\}: Hi\nAria: \(empty reply\)/);
});

test('the chat excerpt keeps the last messages oldest first, skips system lines, and cuts a very long message with a note', () => {
    const messages = [{ isUser: false, isSystem: true, name: 'sys', text: 'hidden' }, { isUser: true, name: 'Sasha', text: 'hello' }, { isUser: false, name: 'Aria', text: 'y'.repeat(2500) }];
    const text = describeChatExcerpt({ name: 'Aria', messages });
    assert.match(text, /^The last 2 messages of the open chat with “Aria” \(oldest first\):\n\n\{\{user\}\}: hello\n\nAria: y+\n\[cut: 2500 characters in all\]$/);
});

function buildRunner({ skipped = null, directFails = false, openAvatar = 'Aria.png' } = {}) {
    const engine = createEngine();
    const cards = { 'Aria.png': { name: 'Aria', description: 'Aria is a scout.', data: { name: 'Aria', first_mes: 'Who goes there?', extensions: {} }, first_mes: 'Who goes there?' } };
    const log = { assembled: [], direct: [], worker: [] };
    const services = engine.buses.services;
    services.register('stCharacterCard.list', () => Object.keys(cards).map(avatar => ({ avatar, name: cards[avatar].name, tags: [] })));
    services.register('stCharacterCard.load', ({ avatar }) => structuredClone(cards[avatar]));
    services.register('stPromptData.read', () => ({ user: 'Sasha' }));
    services.register('stCharacter.current', () => ({ avatar: openAvatar, name: 'Aria' }));
    services.register('stGeneration.direct', ({ messages, maxTokens }) => { log.direct.push({ messages, maxTokens }); return directFails ? { ok: false, error: 'HTTP 401' } : { ok: true, text: `reply ${log.direct.length}` }; });
    const cores = engine.registerCaller('core.test-bus', 'cores', { tier: 'official' });
    cores.own.register('promptManager.assembleForCard', ({ card, chat }) => { log.assembled.push({ card, chat: structuredClone(chat) }); return skipped ? { skipped } : { messages: [{ role: 'system', content: `card ${card.name}` }, ...chat.map(entry => ({ role: entry.is_user ? 'user' : 'assistant', content: entry.mes }))], tokens: 10, presetName: 'AmiGO' }; });
    cores.own.register('model.generate', ({ workerId, messages }) => { log.worker.push({ workerId, messages }); return `worker ${log.worker.length}`; });
    cores.own.register('chatHistory.messages', ({ limit }) => [{ isUser: true, isSystem: false, name: 'Sasha', text: `last ${limit}` }]);
    createCharacterCardsCore(engine.registerCaller('core.characterCard', 'cores', { tier: 'official' }));
    return { call: (contract, params) => request(engine.buses.cores, contract, { params }), log };
}

test('a test runs the probes one after another in one growing chat: each request carries the first message, every earlier probe and its reply, on the main connection by default', async () => {
    const { call, log } = buildRunner();
    const tested = await call('characterCard.test', { avatar: 'Aria.png', probes: [{ say: 'Who are you?', rule: 'Identity' }, { say: 'Count your tails.', rule: 'Five Tails' }] });
    assert.equal(tested.ok, true);
    assert.deepEqual(log.assembled[0].chat.map(entry => entry.mes), ['Who goes there?', 'Who are you?']);
    assert.deepEqual(log.assembled[1].chat.map(entry => entry.mes), ['Who goes there?', 'Who are you?', 'reply 1', 'Count your tails.']);
    assert.equal(log.assembled[0].card.description, 'Aria is a scout.', 'the request is built from the card\'s own text');
    assert.equal(log.direct.length, 2);
    assert.equal(log.direct[0].maxTokens, 1200);
    assert.deepEqual(tested.value.results.map(item => [item.say, item.reply]), [['Who are you?', 'reply 1'], ['Count your tails.', 'reply 2']]);
    assert.match(tested.value.text, /on the main SillyTavern connection \(the model you play on\), preset “AmiGO”/);
});

test('a test may run on a chosen model connection instead, and its reply length is kept within sane bounds', async () => {
    const { call, log } = buildRunner();
    const tested = await call('characterCard.test', { avatar: 'Aria.png', probes: ['hi'], workerId: 'cheap', maxTokens: 99999 });
    assert.equal(tested.ok, true);
    assert.equal(log.worker[0].workerId, 'cheap');
    assert.equal(log.direct.length, 0);
    assert.match(tested.value.text, /the model connection “cheap”/);
});

test('a test that cannot be built or sent says why and stops: no active preset, a refusing connection, a character that does not exist', async () => {
    assert.match((await buildRunner({ skipped: 'no active preset' }).call('characterCard.test', { avatar: 'Aria.png', probes: ['hi'] })).error.message, /Prompt Manager cannot build the request \(no active preset\)/);
    assert.match((await buildRunner({ directFails: true }).call('characterCard.test', { avatar: 'Aria.png', probes: ['hi'] })).error.message, /the main connection did not answer: HTTP 401/);
    assert.equal((await buildRunner().call('characterCard.test', { avatar: 'Nobody.png', probes: ['hi'] })).ok, false);
    assert.equal((await buildRunner().call('characterCard.test', { avatar: 'Aria.png', probes: [] })).ok, false);
});

test('reviewing a chat works only for the chat that is open with that very character', async () => {
    const { call } = buildRunner();
    const excerpt = await call('characterCard.chatExcerpt', { avatar: 'Aria.png', last: 50 });
    assert.match(excerpt.value.text, /^The last 1 messages of the open chat with “Aria”[\s\S]*\{\{user\}\}: last 12/, 'the amount is capped at twelve');
    const other = await buildRunner({ openAvatar: 'Bram.png' }).call('characterCard.chatExcerpt', { avatar: 'Aria.png' });
    assert.equal(other.ok, false);
    assert.match(other.error.message, /the open chat is not with Aria/);
});

const readArticle = path => fs.readFileSync(new URL(`../guide/${path}`, import.meta.url), 'utf8');

function buildGuideWithTest({ generate }) {
    const engine = createEngine();
    const settings = new Map();
    const bus = engine.buses.cores;
    const tests = [];
    bus.register('storage.settings.get', ({ namespace, key, fallback }) => settings.get(`${namespace}/${key}`) ?? fallback);
    bus.register('storage.settings.set', ({ namespace, key, value }) => { settings.set(`${namespace}/${key}`, value); return true; });
    bus.register('model.workers.get', () => [{ id: 'w', state: 'up' }]);
    bus.register('model.workers.status', () => [{ workerId: 'w', state: 'up' }]);
    bus.register('model.generate', generate);
    bus.register('ui.anchors.list', () => []);
    bus.register('tracking.trackers', () => []);
    bus.register('macros.programs', () => []);
    bus.register('lorebook.find', () => []);
    bus.register('characterCard.list', () => []);
    bus.register('characterCard.test', params => { tests.push(params); return { name: 'Aria', results: [{}, {}], text: 'TRANSCRIPT of the test' }; });
    bus.register('characterCard.chatExcerpt', () => ({ name: 'Aria', count: 3, text: 'EXCERPT of the chat' }));
    engine.buses.services.register('stWebSearch.search', ({ query }) => ({ source: 'web', results: [{ title: `About ${query}`, url: 'https://x.org/page', snippet: 'Five tails.' }] }));
    const modules = { list: () => [], enabled: () => [], enable: async () => {}, disable: async () => {} };
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), { publish: () => {}, mount: () => ({}), modules, loadText: async path => readArticle(path) });
    return { guide, tests };
}

test('after a card test the guide gets one more turn by herself to read the transcript; a review is safe and runs without a button, a test is not safe and does not', async () => {
    const systems = [];
    const { guide, tests } = buildGuideWithTest({ generate: params => { systems.push(params.messages.at(-1).content); return 'The five tails held.'; } });
    await guide.load();
    const result = await guide.runAction('character.test', { avatar: 'Aria.png', probes: ['hi'] });
    assert.equal(result.ok, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(tests, [{ avatar: 'Aria.png', probes: ['hi'], workerId: undefined }]);
    const note = guide.messages.peek().find(message => message.role === 'note');
    assert.equal(note.text, 'Tested “Aria”: 2 probes answered.', 'the chat gets one short line');
    assert.match(note.detail, /TRANSCRIPT of the test/, 'the long text is kept for the model');
    assert.equal(systems.length, 1);
    assert.match(systems[0], /^\(automatic — the user did not type this\) The test has finished; its transcript is in the last result/);
    assert.equal(guide.messages.peek().at(-1).text, 'The five tails held.');
    const { splitAutoActions } = await import('../libraries/core/guide-markup.js');
    const reply = '```action\n{"label":"Review","action":"character.review","params":{"avatar":"Aria.png"},"auto":true}\n```\n```action\n{"label":"Test","action":"character.test","params":{"avatar":"Aria.png","probes":["hi"]},"auto":true}\n```';
    const split = splitAutoActions(reply, id => ({ 'character.review': true, 'character.test': false })[id] === true);
    assert.deepEqual(split.actions.map(item => item.action), ['character.review']);
    assert.ok(split.text.includes('character.test'), 'the costly test keeps its button even when the model marks it auto');
});
