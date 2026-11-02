import test from 'node:test';
import assert from 'node:assert/strict';
import { createContractBus } from '../libraries/shared/contract-bus.js';
import { request } from '../libraries/shared/request.js';
import { registerStCharacterService } from '../services/st-character.js';

const avatarsOf = async context => {
    const bus = createContractBus();
    registerStCharacterService(bus, { getContext: () => context });
    return (await request(bus, 'stCharacter.avatars')).value;
};

const CHARACTERS = [{ name: 'Aria', avatar: 'Aria.png' }, { name: 'Bram', avatar: 'Bram Stone.png' }, { name: 'Cleo', avatar: 'cleo.png' }];

test('in a one-on-one chat the avatar is the current character\'s original file', async () => {
    const avatars = await avatarsOf({ characters: CHARACTERS, characterId: 1, chat: [] });

    assert.deepEqual(avatars.characters, [{ name: 'Bram', url: '/characters/Bram%20Stone.png' }]);
    assert.equal(avatars.persona, null);
});

test('in a group chat every member of the group is listed', async () => {
    const avatars = await avatarsOf({ characters: CHARACTERS, groupId: 'g1', groups: [{ id: 'g1', members: ['Aria.png', 'cleo.png'] }], chat: [] });

    assert.deepEqual(avatars.characters.map(item => item.name), ['Aria', 'Cleo']);
});

test('the persona avatar comes from the last user message, as ST stamps it there', async () => {
    const chat = [{ is_user: true, force_avatar: 'User Avatars/old.png' }, { is_user: false }, { is_user: true, force_avatar: 'User Avatars/me.png', name: 'Me' }];

    const avatars = await avatarsOf({ characters: CHARACTERS, characterId: 0, name1: 'Me', chat });

    assert.deepEqual(avatars.persona, { name: 'Me', url: '/User Avatars/me.png' });
});

test('the chat character carries the card fields the banks need, and the persona comes from power_user', async () => {
    const bus = createContractBus();
    const context = {
        characters: [{ name: 'Aria', avatar: 'Aria.png', description: 'A courier.', personality: 'Quiet.', scenario: 'Port.', mes_example: '<START>', data: { post_history_instructions: 'Named rule.' } }],
        characterId: 0, user_avatar: 'me.png',
        power_user: { personas: { 'me.png': 'Me' }, persona_descriptions: { 'me.png': { description: 'A traveller.' } } },
    };
    registerStCharacterService(bus, { getContext: () => context });
    const cards = (await request(bus, 'stCharacter.chatCharacters')).value;
    assert.equal(cards[0].avatar, 'Aria.png');
    assert.equal(cards[0].description, 'A courier.');
    assert.equal(cards[0].post_history_instructions, 'Named rule.');
    const persona = (await request(bus, 'stCharacter.persona')).value;
    assert.deepEqual(persona, { avatar: 'me.png', name: 'Me', description: 'A traveller.' });
});
