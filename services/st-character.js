/**
 * Сервис карточки активного персонажа ST — только чтение. Единственное
 * место, трогающее эту сырую ST-специфику (тот же принцип, что у
 * `services/st-lorebook.js`: `getContext()`'s `characterId`/`characters`
 * подтверждены по реальному исходнику ST, `public/script.js` — не по
 * памяти).
 *
 * V1/V2 карточек: V2-спека хранит поля ВЛОЖЕННЫМИ в `character.data.*`
 * (`data.creator_notes`/`data.extensions` — подтверждено по реальному
 * исходнику), легаси V1 — плоско на самом объекте. ST хранит оба вида карт
 * в одном массиве `characters`, точный внутренний формат конкретной карты
 * заранее неизвестен — читаем ОБА варианта defensively, плоское поле в
 * приоритете (если есть — оно уже нормализовано самой ST).
 */
export function registerStCharacterService(bus, { getContext } = {}) {
    function current() {
        const context = getContext() ?? {};
        const id = context.characterId;
        const character = id != null ? context.characters?.[id] : null;
        if (!character) return null;
        const data = character.data ?? {};
        return {
            avatar: character.avatar ?? null,
            name: character.name ?? data.name ?? null,
            description: character.description ?? data.description ?? '',
            personality: character.personality ?? data.personality ?? '',
            scenario: character.scenario ?? data.scenario ?? '',
        };
    }

    /**
     * Аватары тех, кто в текущем чате — референсы для генерации картинок. Персонажи: в групповом чате — участники группы
     * (`groups[].members` — имена файлов аватаров), иначе текущий персонаж. Персона: `user_avatar` через `getContext()` не отдаётся,
     * поэтому берётся `force_avatar` последней реплики пользователя (ST ставит его каждой). Адреса — оригиналы `/characters/…` и
     * `/User Avatars/…` без серверного пережатия (см. services/st-chat.js).
     */
    function avatars() {
        const context = getContext() ?? {};
        const characters = context.characters ?? [];
        const group = context.groupId != null ? (context.groups ?? []).find(item => String(item.id) === String(context.groupId)) : null;
        const files = group ? (group.members ?? []) : [characters[context.characterId]?.avatar].filter(Boolean);
        const list = files
            .filter(file => file && file !== 'none')
            .map(file => ({ name: characters.find(character => character.avatar === file)?.name ?? String(file).replace(/\.[a-z]+$/i, ''), url: `/characters/${encodeURIComponent(file)}` }));
        const lastUser = [...(context.chat ?? [])].reverse().find(message => message?.is_user && message.force_avatar);
        const personaUrl = lastUser ? String(lastUser.force_avatar).replace(/^\/?thumbnail\?type=persona&file=/, '/User Avatars/') : null;
        return {
            characters: list,
            persona: personaUrl ? { name: String(context.name1 ?? lastUser.name ?? 'User'), url: personaUrl.startsWith('/') ? personaUrl : `/${personaUrl}` } : null,
        };
    }

    const unregisters = [
        bus.register('stCharacter.current', () => current(), { loadMetric: () => 0 }),
        bus.register('stCharacter.avatars', () => avatars(), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
