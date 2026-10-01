import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stToPreset } from '../libraries/core/pm-st-import.js';
import { assemblePrompt, applyCardOverride } from '../libraries/core/pm-assemble.js';
import { buildRequest } from '../libraries/core/pm-run.js';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStPromptDataService } from '../services/st-prompt-data.js';

const amigo = () => stToPreset(JSON.parse(readFileSync(new URL('./fixtures/pm-amigo-polished.st.json', import.meta.url), 'utf8')));

const presetWith = mainBlock => stToPreset({
    prompts: [
        { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: '', ...mainBlock },
        { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: '' },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'jailbreak', enabled: true }] }],
});

const history = [{ role: 'user', content: 'hi' }];
const contents = messages => messages.map(message => message.content);

test('a card\'s system prompt and post-history instructions fill the empty main and jailbreak blocks in place, like SillyTavern\'s own manager does', () => {
    const { messages } = assemblePrompt(presetWith({}), { markers: {}, history, cardOverrides: { main: 'CARD SYSTEM', jailbreak: 'CARD PHI' } });
    assert.deepEqual(contents(messages), ['CARD SYSTEM', 'hi', 'CARD PHI']);
});

test('without card text an empty main or jailbreak block still sends nothing', () => {
    const { messages } = assemblePrompt(presetWith({}), { markers: {}, history, cardOverrides: { main: '', jailbreak: undefined } });
    assert.deepEqual(contents(messages), ['hi']);
});

test('a block that forbids overrides keeps its own text, and {{original}} in the card text brings the block\'s own text back in', () => {
    assert.equal(applyCardOverride({ id: 'main', content: 'PRESET', forbidOverrides: true }, { main: 'CARD' }), 'PRESET');
    assert.equal(applyCardOverride({ id: 'main', content: 'PRESET' }, { main: 'CARD then {{original}} and {{ORIGINAL}}' }), 'CARD then PRESET and PRESET');
    assert.equal(applyCardOverride({ id: 'nsfw', content: 'OTHER' }, { main: 'CARD' }), 'OTHER', 'only main and jailbreak are taken over by the card');
});

test('with the owner\'s preset the post-history text of a card lands inside <char instructions> at depth 8, and the group still sends nothing for a card without one', () => {
    const base = { markers: {}, history: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `m${index}` })) };
    const withCard = assemblePrompt(amigo(), { ...base, cardOverrides: { jailbreak: 'FAPUTA BEHAVIOUR' } }).messages;
    const grouped = withCard.find(message => message.content?.startsWith('<char instructions>'));
    assert.equal(grouped.content, '<char instructions>\nFAPUTA BEHAVIOUR\n</char instructions>');
    assert.equal(withCard.indexOf(grouped) + 1, withCard.findIndex(message => message.content === 'm2'), 'it stands right before the last eight history messages');
    const without = assemblePrompt(amigo(), base).messages;
    assert.equal(without.some(message => message.content?.includes('<char instructions>')), false);
});

test('the whole request carries the card\'s prompts with their macros resolved, and its depth prompt as an injection at the depth and role the card names', () => {
    const materials = {
        user: 'Sanya', char: 'Faputa', description: 'DESC', personality: '', scenario: '', persona: '', mesExamples: '',
        systemPrompt: 'Stay as {{char}}.', postHistoryInstructions: '{{char}} says Sosu.', depthPrompt: { prompt: 'Remember the goggles.', depth: 1, role: 'user' },
        chat: [{ is_user: true, mes: 'one' }, { is_user: false, mes: 'two' }, { is_user: true, mes: 'three' }],
    };
    const { messages } = buildRequest(presetWith({}), materials, {});
    assert.deepEqual(contents(messages), ['Stay as Faputa.', 'one', 'two', 'Remember the goggles.', 'three', 'Faputa says Sosu.']);
    assert.equal(messages[3].role, 'user');
    const plain = buildRequest(presetWith({}), { ...materials, systemPrompt: '', postHistoryInstructions: '', depthPrompt: { prompt: '', depth: 4, role: 'system' } }, {});
    assert.deepEqual(contents(plain.messages), ['one', 'two', 'three']);
});

test('the prompt data service reports the card\'s prompts, and honours the two "Prefer Char." settings and a chat\'s own system prompt like SillyTavern does', async () => {
    const readWith = async context => {
        const bus = createContractBus();
        registerStPromptDataService(bus, { getContext: () => context });
        return (await request(bus, 'stPromptData.read')).value;
    };
    const character = { name: 'Faputa', data: { system_prompt: 'CARD SYS', post_history_instructions: 'CARD PHI', extensions: { depth_prompt: { prompt: 'DP', depth: 2, role: 'user' } } } };
    const base = { characterId: 0, characters: [character], powerUserSettings: {}, chatMetadata: {} };
    const normal = await readWith(base);
    assert.deepEqual([normal.systemPrompt, normal.postHistoryInstructions, normal.depthPrompt], ['CARD SYS', 'CARD PHI', { prompt: 'DP', depth: 2, role: 'user' }]);
    const off = await readWith({ ...base, powerUserSettings: { prefer_character_prompt: false, prefer_character_jailbreak: false } });
    assert.deepEqual([off.systemPrompt, off.postHistoryInstructions], ['', '']);
    assert.equal((await readWith({ ...base, chatMetadata: { system_prompt: 'CHAT SYS' } })).systemPrompt, 'CHAT SYS');
});
