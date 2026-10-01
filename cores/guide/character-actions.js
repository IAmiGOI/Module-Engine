/**
 * Действия гида над карточками персонажей: создать, изменить, вернуть прежнюю версию. Приходят блоком ```proposal```; человек видит на карточке то, что
 * реально запишется (libraries/core/guide-character.js), и записывается это нажатием «Apply». Вся проверка и запись — в Ядре `characterCard`; здесь только
 * перевод предложения в вызов его контрактов.
 */
/** После применённой правки карточки она сама идёт дальше: следующий шаг плана или короткий отчёт — без того, чтобы человек писал «продолжай». */
const CHANGE_FOLLOW_UP = 'The card change was applied (see the last result). Continue the task: if your plan has a next step, do it now; if the card is finished, tell the user in one or two lines what is written and what is still open. Do not repeat the text you just wrote, and do not ask whether to apply — it is already applied.';

export function createCharacterActions({ call }) {
    const buildFailure = message => ({ ok: false, message });
    const splitTarget = ({ avatar, label, negations_ok: negationsOk, ...fields }) => ({ avatar, label, negationsOk, fields });

    return {
        'character.create': {
            autoApply: true, // без кнопки «Apply»: человек просил карточку, а каждая правка сохраняет прежнюю версию
            thenContinue: true,
            followUp: CHANGE_FOLLOW_UP,
            description: 'Send as a ```proposal``` block {"action": "character.create", "params": {…}}; it is applied at once. Create a new character card. Params are the card fields, all optional except name: {"name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "alternate_greetings": [..], "tags": [..], "creator", "character_version", "talkativeness": 0-1, "fav", "world", "depth_prompt": {"prompt", "depth", "role"}, "character_book": {"name", "entries": [{"name", "keys": [..], "content", "constant"}]}, "extensions": {}}. Follow "Writing character cards". A name that is already taken is refused. Send it in a ```proposal``` block.',
            async run(params = {}) {
                // `label` и `avatar` — параметры правки (character.update): модель переносит их и сюда, а карточка при создании их не знает. Они не поля — отбрасываются, не ошибка.
                const { label: _label, avatar: _avatar, negations_ok: negationsOk, ...fields } = params;
                const created = await call('characterCard.create', { fields, ...(negationsOk === true ? { negationsOk } : {}) });
                return created.ok ? { ok: true, message: `Character “${created.value.name}” is created (${created.value.avatar}).` } : buildFailure(created.error.message);
            },
        },
        'character.update': {
            autoApply: true,
            thenContinue: true,
            followUp: CHANGE_FOLLOW_UP,
            description: 'Send as a ```proposal``` block {"action": "character.update", "params": {…}}; it is applied at once. Change an existing character card. Params: {"avatar": "<file from the state>", "label": "optional note for the version list", plus ONLY the fields that change, same names as in character.create}. A list field (tags, alternate_greetings) is replaced as a whole; for character_book use {"entries": [{"id": 3, ...changes}, {"name", "keys", "content"} (no id = new)], "removeEntries": [ids]} — entries you do not mention stay. The previous version is saved automatically and can be restored. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const { avatar, label, negationsOk, fields } = splitTarget(params);
                if (!avatar) return buildFailure('Which character? Its avatar file is needed.');
                const updated = await call('characterCard.update', { avatar, label, fields, ...(negationsOk === true ? { negationsOk } : {}) });
                return updated.ok ? { ok: true, message: `Character “${updated.value.name}” is updated (${updated.value.changed.join(', ')}). The previous version is saved.` } : buildFailure(updated.error.message);
            },
        },
        'character.avatar': {
            autoApply: true,
            thenContinue: true,
            followUp: 'The picture was set (see the last result). You cannot see it: tell the user in one line which image you used and from where, and that they can ask for another one or for a different part of the frame. Then continue.',
            description: 'Send as a ```proposal``` block {"action": "character.avatar", "params": {"avatar": "Nanahoshi Shizuka.png", "url": "https://…", "focus": "center"}}; it is applied at once. Set the picture (avatar) of an existing character card. You do NOT need to see images: pick the address by its source and label. Params: {"avatar": "<file from the state or the create result>", "url": "<image address>", "focus": "center" (default) | "left" | "right" | "top" | "bottom" — which part of a wide or tall picture to keep for the 2:3 portrait}. Image addresses are listed in opened pages: a character found with web.character has a portrait under Images (AniList is best: a ready portrait); a wiki page has its Infobox images with labels (Anime, Manga, Light Novel…). Prefer a portrait-shaped one. Only hosts that allow download work (AniList, Wikipedia, Fandom). {"avatar": "…", "undo": true} puts the previous picture back (the last replacement of this session).',
            async run({ avatar, url, focus, undo } = {}) {
                if (!avatar) return buildFailure('Which character? Its avatar file is needed.');
                if (undo !== true && !url) return buildFailure('Which picture? An image address is needed (see the Images of an opened page).');
                const done = await call('characterCard.avatar', { avatar, url, focus, ...(undo === true ? { undo: true } : {}) });
                if (!done.ok) return buildFailure(done.error.message);
                return { ok: true, message: done.value.undone ? `The previous picture of “${done.value.name}” is back.` : `The picture of “${done.value.name}” is set (${done.value.source[0]}×${done.value.source[1]} cropped to a 2:3 portrait).` };
            },
        },
        'character.restore': {
            autoApply: true,
            thenContinue: true,
            followUp: CHANGE_FOLLOW_UP,
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
                // В чат — одна строка; сами ответы модели на пробы (много текста) видит только гид: `detail`.
                return tested.ok ? { ok: true, message: `Tested “${tested.value.name}”: ${tested.value.results.length} probe${tested.value.results.length === 1 ? '' : 's'} answered.`, detail: tested.value.text } : buildFailure(tested.error.message);
            },
        },
        'character.review': {
            safe: true,
            thenContinue: true,
            followUp: 'The chat excerpt is in the last result. Find where the character broke or forgot a rule of the card, quote the lines briefly, name the rule, and propose the smallest fix as a proposal. If nothing broke, say so.',
            description: 'Read the last messages of the OPEN chat with a character, to find where the model forgot or broke the card’s rules (when the user says "she keeps forgetting X"). Params: {"avatar": "<file>", "last": 12 (optional, up to 12)}. The chat must be open in SillyTavern.',
            async run(params = {}) {
                if (!params.avatar) return buildFailure('Which character? Its avatar file is needed.');
                const excerpt = await call('characterCard.chatExcerpt', { avatar: params.avatar, last: params.last });
                return excerpt.ok ? { ok: true, message: `Read the last ${excerpt.value.count} message${excerpt.value.count === 1 ? '' : 's'} of the open chat with “${excerpt.value.name}”.`, detail: excerpt.value.text } : buildFailure(excerpt.error.message);
            },
        },
    };
}
