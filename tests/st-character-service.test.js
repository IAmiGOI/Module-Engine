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
