/**
 * Резолвинг «какие книги мира вообще сейчас активны» — чистая функция над
 * ПЛОСКИМ снимком сырых полей ST (не над живым `context`), портированная из
 * Alpha's `resolveBookNames()` (core/lorebook-service.js). Alpha держала её
 * над самим `context` — здесь снимок собирает Сервис
 * ([services/st-lorebook.js](../../services/st-lorebook.js), единственное
 * место, которому вообще можно трогать сырую ST), а сюда, в Библиотеку,
 * попадают уже голые данные — ту же дисциплину уже прошли Ядро трекинга
 * (`buildTrackerContext`) и другие.
 *
 * Реальные 4 источника, которые ST сама объединяет перед генерацией
 * (`getSortedEntries()` в её же `world-info.js`):
 *  1. **Глобально выбранные** — `selectedWorldInfo` (внутреннее состояние
 *     `world-info.js`, не отдаётся через публичный `getContext()` вообще —
 *     Сервис достаёт его отдельным динамическим импортом).
 *  2. **Персонажа** — основная книга (`character.data.extensions.world`) +
 *     доп. книги из `charLore` (тоже внутреннее состояние). В групповом
 *     чате — у КАЖДОГО включённого участника, не только у того, кто
 *     говорил последним: иначе активный набор скакал бы туда-сюда по ходу
 *     чата в зависимости от очерёдности реплик.
 *  3. **Чата** — `chatMetadata.world_info`.
 *  4. **Персоны** — `powerUserSettings.persona_description_lorebook`.
 *
 * `snapshot` — форма, которую строит Сервис:
 * `{ selectedWorldInfo, chatBook, personaBook, characterId, characters,
 *   groupId, groups, charLore }`. Отсутствующее поле — пустой
 * массив/`null`, чтобы вызывающий с неполным снимком (напр. только то, что
 * реально доступно без группового чата) всё равно получал разумный ответ,
 * а не падение.
 */
export function resolveBookNames(snapshot = {}) {
    const names = new Set();

    for (const name of snapshot.selectedWorldInfo ?? []) if (name) names.add(name);
    if (snapshot.chatBook) names.add(snapshot.chatBook);
    if (snapshot.personaBook) names.add(snapshot.personaBook);

    const characters = snapshot.characters ?? [];
    const charLore = snapshot.charLore ?? [];

    const addCharacterBooks = index => {
        const character = characters[index];
        if (!character) return;
        const primary = character?.data?.extensions?.world;
        if (primary) names.add(primary);
        const fileName = String(character.avatar ?? '').replace(/\.[^/.]+$/, '');
        const extraBooks = charLore.find(entry => entry.name === fileName)?.extraBooks ?? [];
        for (const name of extraBooks) if (name) names.add(name);
    };

    if (snapshot.groupId) {
        const group = (snapshot.groups ?? []).find(item => item.id === snapshot.groupId);
        const disabledMembers = new Set(group?.disabled_members ?? []);
        for (const avatar of group?.members ?? []) {
            if (disabledMembers.has(avatar)) continue;
            const index = characters.findIndex(item => item.avatar === avatar);
            if (index >= 0) addCharacterBooks(index);
        }
    } else if (snapshot.characterId !== undefined && snapshot.characterId !== null) {
        addCharacterBooks(snapshot.characterId);
    }

    return [...names];
}

/** Одна запись WI, сведённая к метаданным для листинга/фильтра — НЕ включает `content` целиком (то же решение, что у Alpha: тяжёлый текст незачем гонять по индексу, только по запросу конкретной записи). */
export function summarizeEntry(entry, book) {
    return {
        uid: entry.uid,
        book,
        name: String(entry.comment ?? '').trim(),
        keys: Array.isArray(entry.key) ? entry.key : [],
        length: String(entry.content ?? '').length,
        disabled: Boolean(entry.disable),
        constant: Boolean(entry.constant),
    };
}

/** `true`, если `summary` проходит ВСЕ заданные поля фильтра; незаданное поле — всегда проходит. */
export function matchesFilter(summary, filter = {}) {
    const { name, minLength, maxLength, key, disabled, constant } = filter;
    if (name !== undefined && !summary.name.toLowerCase().includes(String(name).toLowerCase())) return false;
    if (minLength !== undefined && summary.length < minLength) return false;
    if (maxLength !== undefined && summary.length > maxLength) return false;
    if (key !== undefined && !summary.keys.some(item => String(item).toLowerCase().includes(String(key).toLowerCase()))) return false;
    if (disabled !== undefined && summary.disabled !== Boolean(disabled)) return false;
    if (constant !== undefined && summary.constant !== Boolean(constant)) return false;
    return true;
}

/**
 * Сводит `{ bookName: worldInfoData }` (`worldInfoData` — форма
 * `loadWorldInfo()`: `{ entries }`, или `null`/`undefined` для книги,
 * которая не загрузилась) в плоский список сводок + карту
 * `${book}:${uid}` → полная запись. Ключ — книга И uid, не голый uid: ST
 * назначает uid'ы отдельно на каждый файл начиная с 0, и ДВЕ разные
 * активные книги (глобальная + своя книга чата, например — любая пара,
 * которую `resolveBookNames()` может вернуть) легко делят один и тот же
 * номер для совершенно разных записей. Голый uid как ключ тихо затирал бы
 * запись первой книги записью второй.
 */
export function mergeBooks(booksByName) {
    const summaries = [];
    const byUid = new Map();
    for (const [book, data] of Object.entries(booksByName ?? {})) {
        const entries = data?.entries;
        if (!entries) continue;
        for (const entry of Object.values(entries)) {
            summaries.push(summarizeEntry(entry, book));
            byUid.set(`${book}:${entry.uid}`, { ...entry, book });
        }
    }
    return { summaries, byUid };
}

/** Следующий свободный uid внутри ОДНОЙ книги — на единицу больше самого большого существующего числового uid, или 0 для пустой/новой книги. Не связан со схемой самого редактора ST — важно только не столкнуться внутри ЭТОЙ книги. */
export function nextUid(entries) {
    const used = Object.keys(entries ?? {}).map(Number).filter(Number.isFinite);
    return used.length ? Math.max(...used) + 1 : 0;
}

/**
 * Дефолты новой записи — зеркалит настоящий `newWorldInfoEntryDefinition`
 * из ST (`public/scripts/world-info.js`, проверено по актуальному
 * исходнику; сам объект не экспортирован через `getContext()`, поэтому
 * зеркалится руками, а не импортируется). Alpha хардкодила только 11 из
 * 35+ полей — здесь полный набор, чтобы созданная нами запись не выглядела
 * «урезанной» рядом с записью, заведённой через родной редактор ST.
 */
export function blankEntry(uid) {
    return {
        uid,
        key: [], keysecondary: [], comment: '', content: '',
        constant: false, vectorized: false, selective: true, selectiveLogic: 0,
        addMemo: false, order: 100, position: 0, disable: false,
        ignoreBudget: false, excludeRecursion: false, preventRecursion: false,
        matchPersonaDescription: false, matchCharacterDescription: false,
        matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
        matchScenario: false, matchCreatorNotes: false,
        delayUntilRecursion: 0, probability: 100, useProbability: true,
        depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        automationId: '', role: 0, sticky: null, cooldown: null, delay: null,
    };
}
