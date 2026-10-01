/**
 * Действия гида над карточками персонажей: создать, изменить, вернуть прежнюю версию. Приходят блоком ```proposal```; человек видит на карточке то, что
 * реально запишется (libraries/core/guide-character.js), и записывается это нажатием «Apply». Вся проверка и запись — в Ядре `characterCard`; здесь только
 * перевод предложения в вызов его контрактов.
 */
export function createCharacterActions({ call }) {
    const buildFailure = message => ({ ok: false, message });
    const splitTarget = ({ avatar, label, ...fields }) => ({ avatar, label, fields });

    return {
        'character.create': {
            description: 'Create a new character card. Params are the card fields, all optional except name: {"name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "alternate_greetings": [..], "tags": [..], "creator", "character_version", "talkativeness": 0-1, "fav", "world", "depth_prompt": {"prompt", "depth", "role"}, "character_book": {"name", "entries": [{"name", "keys": [..], "content", "constant"}]}, "extensions": {}}. Follow "Writing character cards". A name that is already taken is refused. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const created = await call('characterCard.create', { fields: params });
                return created.ok ? { ok: true, message: `Character “${created.value.name}” is created (${created.value.avatar}).` } : buildFailure(created.error.message);
            },
        },
        'character.update': {
            description: 'Change an existing character card. Params: {"avatar": "<file from the state>", "label": "optional note for the version list", plus ONLY the fields that change, same names as in character.create}. A list field (tags, alternate_greetings) is replaced as a whole; for character_book use {"entries": [{"id": 3, ...changes}, {"name", "keys", "content"} (no id = new)], "removeEntries": [ids]} — entries you do not mention stay. The previous version is saved automatically and can be restored. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const { avatar, label, fields } = splitTarget(params);
                if (!avatar) return buildFailure('Which character? Its avatar file is needed.');
                const updated = await call('characterCard.update', { avatar, label, fields });
                return updated.ok ? { ok: true, message: `Character “${updated.value.name}” is updated (${updated.value.changed.join(', ')}). The previous version is saved.` } : buildFailure(updated.error.message);
            },
        },
        'character.restore': {
            description: 'Put a character card back to an earlier saved version. Params: {"avatar": "<file>", "key": "<version key from the state>"}. The current state is saved first, so a restore can be undone too. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const restored = await call('characterCard.restore', { avatar: params.avatar, key: params.key });
                return restored.ok ? { ok: true, message: `Character ${restored.value.avatar} is back to the chosen version (${restored.value.changed.join(', ') || 'no field differed'}).` } : buildFailure(restored.error.message);
            },
        },
        'character.test': {
            // Каждая проба — полная генерация на модели человека, то есть его токены: только по кнопке, не сама; после ответа гид сама разбирает результат.
            thenContinue: true,
            followUp: 'The test has finished; its transcript is in the last result. Compare each reply with the card’s named rules, say briefly what held and what slipped, and, if something slipped, propose the smallest fix as a proposal.',
            description: 'Test a character card: a short series of turns in an isolated chat (the preset, this card, the card’s first message, then your probes as {{user}}) on the model the user plays on. Params: {"avatar": "<file>", "probes": [{"say": "what {{user}} writes", "rule": "the named rule it checks"}, …up to 8], "workerId": "optional model connection id"}. Write probes that provoke each named rule (a counted feature, a speech rule, a knowledge limit). It costs the user tokens, so offer it as an ```action``` button (no auto) and say how many probes. Afterwards read the replies against the rules.',
            async run(params = {}) {
                if (!params.avatar) return buildFailure('Which character? Its avatar file is needed.');
                const tested = await call('characterCard.test', { avatar: params.avatar, probes: params.probes, workerId: params.workerId });
                return tested.ok ? { ok: true, message: tested.value.text } : buildFailure(tested.error.message);
            },
        },
        'character.review': {
            safe: true,
            description: 'Read the last messages of the OPEN chat with a character, to find where the model forgot or broke the card’s rules (when the user says "she keeps forgetting X"). Params: {"avatar": "<file>", "last": 12 (optional, up to 12)}. The chat must be open in SillyTavern.',
            async run(params = {}) {
                if (!params.avatar) return buildFailure('Which character? Its avatar file is needed.');
                const excerpt = await call('characterCard.chatExcerpt', { avatar: params.avatar, last: params.last });
                return excerpt.ok ? { ok: true, message: excerpt.value.text } : buildFailure(excerpt.error.message);
            },
        },
    };
}
