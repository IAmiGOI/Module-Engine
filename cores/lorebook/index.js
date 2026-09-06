import { request } from '../../libraries/shared/request.js';
import { resolveBookNames, matchesFilter, mergeBooks, nextUid, blankEntry } from '../../libraries/core/lorebook-sources.js';

const PERSISTENCE_NAMESPACE = 'core.lorebook';
const PUBLISHED_KEY = 'published';

/** Тот же коллизиеустойчивый вид слага, что уже есть у Ядра macros/Модуля «Трекер» — свой префикс, чтобы не столкнуться с чужим макросом по совпадению. */
export function macroSlug(...parts) {
    return ['lorebook', ...parts].join('_')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 60);
}

function requireEntryLocation(params) {
    const uid = params?.uid;
    if (uid === undefined || uid === null) throw new Error('lorebook: "uid" is required.');
    return { uid: Number(uid), book: params?.book };
}

/**
 * Ядро работы с WI (CORES.md) — сканирует реальный World Info ST (все
 * четыре источника, которые сама ST объединяет перед генерацией: глобально
 * выбранные книги, книги персонажа/группы, книга чата, книга персоны — см.
 * doc-comment `resolveBookNames()` в
 * [libraries/core/lorebook-sources.js](../../libraries/core/lorebook-sources.js)),
 * даёт read+write API по записям и публикует любую запись как настоящий
 * `{{macro}}` через Ядро macros. Портировано с Alpha's
 * `core/lorebook-service.js`, разъехавшееся на слои по правилам этого
 * движка: сырой ST — только в [services/st-lorebook.js](../../services/st-lorebook.js),
 * чистое разрешение источников/слияние — в Библиотеке, здесь — только
 * оркестрация и настоящие контракты.
 *
 * **Держит себя в курсе САМО, не только по ручному Rescan.** Alpha
 * пересканировала только по `CHAT_CHANGED` — правка записи прямо в родном
 * редакторе ST оставалась незамеченной до смены чата. Здесь подписки на
 * РЕАЛЬНЫЕ события ST (уже смощённые Ядром событий без единой строчки с
 * нашей стороны — `eventsCore.bridge()` мостит вообще всё, что заявляет о
 * себе эта сборка ST): `st.worldinfoUpdated` (любое сохранение книги —
 * нашей записью ИЛИ родным редактором) и `st.worldinfoSettingsUpdated`
 * (сменился глобальный выбор книг/настройки WI) — оба перезапускают
 * `scan()`, `st.chatChanged` — тоже (другой чат/персонаж — другой набор
 * активных книг). `st.worldInfoActivated` (что реально попало в ЭТУ
 * генерацию) не пересканирует — это отдельный, генерационный факт, держится
 * своим полем `lastActivated()`, не смешивается со статическим индексом
 * записей.
 *
 * **Гонка скана.** Несколько событий (например `st.worldinfoUpdated` от
 * своей же записи И следом `st.chatChanged`) могут запустить `scan()`
 * почти одновременно; без защиты более РАННИЙ вызов, отработавший ПОЗЖЕ
 * (сеть/диск не гарантируют порядок), тихо перезаписал бы более свежий
 * результат устаревшим. `scanGeneration` — простой счётчик: результат
 * применяется, только если он всё ещё от ПОСЛЕДНЕГО запущенного скана.
 *
 * **Гонка записи.** `create/update/deleteEntry` — read-modify-write через
 * `stLorebook.load`/`save`: `loadWorldInfo()` у настоящей ST кэширует по
 * имени книги и не гарантирует свежести между двумя параллельными вызовами
 * (тот же класс гонки, что уже был найден и закрыт у `storage.chatMemory`
 * в этом же движке) — два одновременных `createEntry()` в одну книгу могли
 * бы получить один и тот же `nextUid()` и один затёр бы другого. Все три
 * операции идут через одну общую очередь (`enqueue()`), а не параллельно.
 */
export function createLorebookCore(host, { publish } = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));

    let books = [];
    let byUid = new Map(); // `${book}:${uid}` -> full entry
    let summaries = [];
    let lastActivated = null;
    let scanGeneration = 0;

    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    async function callService(contract, params) {
        return request(host.services, contract, { params });
    }

    // Очередь на ЗАПИСЬ — createEntry/updateEntry/deleteEntry идут строго
    // по очереди (см. doc-comment выше про гонку read-modify-write).
    let writeTail = Promise.resolve();
    function enqueueWrite(task) {
        const run = writeTail.then(task, task);
        writeTail = run.then(() => {}, () => {});
        return run;
    }

    async function scan() {
        const generation = ++scanGeneration;
        const rawResult = await callService('stLorebook.rawState');
        const snapshot = rawResult.ok ? rawResult.value : {};
        const names = resolveBookNames(snapshot);

        if (!names.length) {
            if (generation !== scanGeneration) return { books: [], entries: [] };
            books = [];
            byUid = new Map();
            summaries = [];
            await republishAll();
            publishEvent('lorebook.scanned', { books: [], entries: [] });
            return { books: [], entries: [] };
        }

        const loaded = {};
        for (const name of names) {
            const result = await callService('stLorebook.load', { name });
            if (result.ok && result.value) loaded[name] = result.value;
        }
        // Стало неактуальным, пока грузили — более новый scan() уже
        // применил (или вот-вот применит) свой результат; этот тихо
        // отбрасывается, не перезаписывая его устаревшим.
        if (generation !== scanGeneration) return { books: names, entries: summaries };

        const merged = mergeBooks(loaded);
        books = names;
        byUid = merged.byUid;
        summaries = merged.summaries;
        await republishAll();
        publishEvent('lorebook.scanned', { books: names, entries: summaries });
        return { books: names, entries: summaries };
    }

    function find(filter) {
        return summaries.filter(summary => matchesFilter(summary, filter));
    }

    /** Полная запись по uid — при неоднозначности (два активных источника поделили один и тот же числовой uid) без `book` вернёт первое совпадение; внутренние вызывающие, уже знающие книгу, всегда передают её. */
    function getEntry(uid, book) {
        if (book !== undefined && book !== null) return byUid.get(`${book}:${uid}`);
        for (const entry of byUid.values()) if (entry.uid === uid) return entry;
        return undefined;
    }

    // --- Публикация: запись → настоящий {{macro}} ------------------------

    async function readPublished() {
        const result = await call('storage.settings.get', { namespace: PERSISTENCE_NAMESPACE, key: PUBLISHED_KEY, fallback: {} });
        return result.ok ? result.value ?? {} : {};
    }

    async function writePublished(map) {
        await call('storage.settings.set', { namespace: PERSISTENCE_NAMESPACE, key: PUBLISHED_KEY, value: map });
    }

    function isPublished(published, book, uid) {
        return Boolean(published[book]?.[uid]);
    }

    async function applyPublished(published, book, uid) {
        const entry = getEntry(uid, book);
        const name = macroSlug(book, String(entry?.comment ?? '').trim() || String(uid));
        if (!entry) { await call('macros.clearValue', { name }); return; }
        await call('macros.setValue', { name, value: entry.content ?? '' });
    }

    /** Заново применяет (или, если записи больше нет, снимает) каждую отмеченную "published" запись — зовётся в конце КАЖДОГО scan(), чтобы смена книги/удаление записи не оставляли макрос указывающим в никуда. */
    async function republishAll() {
        const published = await readPublished();
        for (const [book, uids] of Object.entries(published)) {
            for (const uidKey of Object.keys(uids)) await applyPublished(published, book, Number(uidKey));
        }
    }

    async function publishedEntries() {
        const published = await readPublished();
        const index = [];
        for (const [book, uids] of Object.entries(published)) {
            for (const uidKey of Object.keys(uids)) {
                const uid = Number(uidKey);
                const entry = getEntry(uid, book);
                if (!entry) continue;
                const displayName = String(entry.comment ?? '').trim() || `${book} #${uid}`;
                index.push({ book, uid, name: displayName, macro: macroSlug(book, String(entry.comment ?? '').trim() || String(uid)) });
            }
        }
        return index;
    }

    async function publishEntry(book, uid) {
        const published = await readPublished();
        (published[book] ??= {})[uid] = true;
        await writePublished(published);
        await applyPublished(published, book, uid);
    }

    async function unpublishEntry(book, uid) {
        const published = await readPublished();
        if (published[book]) {
            delete published[book][uid];
            if (!Object.keys(published[book]).length) delete published[book];
        }
        await writePublished(published);
        const name = macroSlug(book, String(getEntry(uid, book)?.comment ?? '').trim() || String(uid));
        await call('macros.clearValue', { name });
    }

    // --- Запись -------------------------------------------------------------

    /** Создаёт запись. `book` по умолчанию — первая активная книга; без неё и без явного `book` бросает — писать некуда. Read-modify-write: грузит книгу целиком, добавляет запись в `.entries`, сохраняет НЕМЕДЛЕННО (`immediately: true` — не рискуем потерять правку в окне дебаунса ST), пересканирует. */
    async function createEntry(patch, targetBook) {
        const book = targetBook || books[0];
        if (!book) throw new Error('lorebook.createEntry: no lorebook active for this chat/character, and none was given explicitly.');
        return enqueueWrite(async () => {
            const loadResult = await callService('stLorebook.load', { name: book });
            const data = (loadResult.ok && loadResult.value) ? loadResult.value : { entries: {} };
            data.entries ??= {};
            const uid = nextUid(data.entries);
            const entry = { ...blankEntry(uid), ...patch, uid };
            data.entries[uid] = entry;
            await callService('stLorebook.save', { name: book, data, immediately: true });
            await scan();
            const full = { ...entry, book };
            publishEvent('lorebook.entryCreated', full);
            return full;
        });
    }

    /** Сливает `patch` в существующую запись (найденную по текущему индексу — `scan()` должен был её уже увидеть) и сохраняет. */
    async function updateEntry(uid, book, patch) {
        const owner = getEntry(uid, book);
        if (!owner) throw new Error(`lorebook.updateEntry: no known entry with uid ${uid}${book ? ` in "${book}"` : ''} (scan() first, or it may not exist).`);
        const targetBook = owner.book;
        return enqueueWrite(async () => {
            const loadResult = await callService('stLorebook.load', { name: targetBook });
            const data = (loadResult.ok && loadResult.value) ? loadResult.value : { entries: {} };
            data.entries ??= {};
            const existing = data.entries[uid] ?? { ...owner };
            const previous = { ...existing, book: targetBook };
            const updated = { ...existing, ...patch, uid };
            data.entries[uid] = updated;
            await callService('stLorebook.save', { name: targetBook, data, immediately: true });
            await scan();
            const full = { ...updated, book: targetBook };
            publishEvent('lorebook.entryUpdated', { entry: full, previous });
            return full;
        });
    }

    /** Удаляет запись по uid (найденную по текущему индексу). */
    async function deleteEntry(uid, book) {
        const owner = getEntry(uid, book);
        if (!owner) throw new Error(`lorebook.deleteEntry: no known entry with uid ${uid}${book ? ` in "${book}"` : ''} (scan() first, or it may not exist).`);
        const targetBook = owner.book;
        return enqueueWrite(async () => {
            const loadResult = await callService('stLorebook.load', { name: targetBook });
            const data = (loadResult.ok && loadResult.value) ? loadResult.value : { entries: {} };
            delete data.entries?.[uid];
            await callService('stLorebook.save', { name: targetBook, data, immediately: true });
            await scan();
            publishEvent('lorebook.entryDeleted', { uid, book: targetBook });
        });
    }

    // --- Жизнь ---------------------------------------------------------------

    const subscriptions = [
        host.events.subscribe('st.worldinfoUpdated', () => { scan().catch(() => {}); }),
        host.events.subscribe('st.worldinfoSettingsUpdated', () => { scan().catch(() => {}); }),
        host.events.subscribe('st.chatChanged', () => { scan().catch(() => {}); }),
        // Что реально попало в промпт этой генерацией — факт генерации, не
        // повод пересканировать статический индекс записей. Настоящий
        // аргумент ST — МАССИВ активированных записей
        // (`Array.from(allActivatedEntries.values())`, см. её же
        // `getWorldInfoPrompt()`), не объект — оборачиваем в `entries`, а не
        // расползаем спредом (тот дал бы `{0:…,1:…}`).
        host.events.subscribe('st.worldInfoActivated', payload => { lastActivated = { at: Date.now(), entries: payload?.args?.[0] ?? [] }; }),
    ];

    const unregisters = [
        host.own.register('lorebook.scan', () => scan()),
        host.own.register('lorebook.find', params => find(params)),
        host.own.register('lorebook.get', params => { const { uid, book } = requireEntryLocation(params); return getEntry(uid, book); }),
        host.own.register('lorebook.books', () => books),
        host.own.register('lorebook.lastActivated', () => lastActivated),
        host.own.register('lorebook.createEntry', params => createEntry(params?.patch ?? {}, params?.book)),
        host.own.register('lorebook.updateEntry', params => { const { uid, book } = requireEntryLocation(params); return updateEntry(uid, book, params?.patch ?? {}); }),
        host.own.register('lorebook.deleteEntry', params => { const { uid, book } = requireEntryLocation(params); return deleteEntry(uid, book); }),
        host.own.register('lorebook.isPublished', async params => {
            const { uid, book } = requireEntryLocation(params);
            return isPublished(await readPublished(), book, uid);
        }),
        host.own.register('lorebook.publish', params => { const { uid, book } = requireEntryLocation(params); return publishEntry(book, uid).then(() => true); }),
        host.own.register('lorebook.unpublish', params => { const { uid, book } = requireEntryLocation(params); return unpublishEntry(book, uid).then(() => true); }),
        host.own.register('lorebook.publishedEntries', () => publishedEntries()),
    ];

    return {
        scan,
        unregister: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            for (const unregister of unregisters) unregister();
        },
    };
}
