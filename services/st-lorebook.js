const DEFAULT_MODULE_PATH = '../../../../world-info.js';

/**
 * Сервис лорбука (World Info) ST — единственное место, которое трогает
 * сырую ST-специфику: `context.loadWorldInfo`/`saveWorldInfo` (обе реально
 * есть на публичном `getContext()`, проверено по актуальному исходнику
 * `st-context.js`) и — что НЕ есть на нём — `selected_world_info`/
 * `world_info.charLore` из `world-info.js` самой ST.
 *
 * **Динамический импорт, а не статический.** Портировано из Alpha (её
 * `core/lorebook-service.js`), с той же причиной: статический импорт на
 * уровне модуля крашил бы весь граф модулей этого файла при первой же
 * ошибке резолвинга (не та версия ST, другая раскладка каталогов, или, как
 * в тестах этого репозитория, вовсе нет настоящего дерева SillyTavern на
 * диске). Динамическим — ломается только ЭТО ОДНО чтение (снимок просто
 * не получает `selectedWorldInfo`/`charLore`), а не весь Сервис. Путь
 * (`../../../../world-info.js`) предполагает стандартную раскладку
 * стороннего расширения — `public/scripts/extensions/third-party/<это
 * расширение>/services/st-lorebook.js`, четыре уровня под
 * `public/scripts/world-info.js` — ровно та же глубина, что была у
 * Alpha's `core/`.
 *
 * `saveWorldInfo(name, data, immediately)` у настоящей ST по умолчанию
 * ДЕБАУНСИТ запись на сервер (кэш в памяти при этом обновляется сразу).
 * Ядро работы с WI зовёт этот Сервис с `immediately: true` для СВОИХ
 * записей (create/update/delete) — не рискуем потерять правку, если
 * страница перезагрузится до того, как дебаунс долетел.
 */
export function registerStLorebookService(bus, { getContext, loadWorldInfoModule = () => import(DEFAULT_MODULE_PATH) } = {}) {
    /** Сырой снимок ВСЕХ полей, нужных `resolveBookNames()` в Библиотеке — сама функция резолвинга остаётся чистой и не знает, откуда эти поля взялись. */
    async function rawState() {
        const context = getContext() ?? {};
        let selectedWorldInfo = [];
        let charLore = [];
        try {
            const worldInfo = await loadWorldInfoModule();
            selectedWorldInfo = worldInfo?.selected_world_info ?? [];
            charLore = worldInfo?.world_info?.charLore ?? [];
        } catch {
            // Не тот билд ST, другая раскладка, нет настоящего дерева на
            // диске (тесты) — тихо остаёмся с пустыми списками; остальные
            // источники (chatBook/personaBook/characterId) резолвятся всё
            // равно, через `getContext()` напрямую.
        }
        return {
            selectedWorldInfo,
            charLore,
            chatBook: context.chatMetadata?.world_info ?? null,
            personaBook: context.powerUserSettings?.persona_description_lorebook ?? null,
            characterId: context.characterId ?? null,
            characters: context.characters ?? [],
            groupId: context.groupId ?? null,
            groups: context.groups ?? [],
        };
    }

    function load(name) {
        return getContext()?.loadWorldInfo?.(name);
    }

    function save(name, data, immediately) {
        return getContext()?.saveWorldInfo?.(name, data, immediately);
    }

    const unregisters = [
        bus.register('stLorebook.rawState', () => rawState(), { loadMetric: () => 0 }),
        bus.register('stLorebook.load', params => load(params?.name), { loadMetric: () => 0 }),
        bus.register('stLorebook.save', params => save(params?.name, params?.data, params?.immediately), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
