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
            name: character.name ?? data.name ?? null,
            description: character.description ?? data.description ?? '',
            personality: character.personality ?? data.personality ?? '',
            scenario: character.scenario ?? data.scenario ?? '',
        };
    }

    const unregisters = [
        bus.register('stCharacter.current', () => current(), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
