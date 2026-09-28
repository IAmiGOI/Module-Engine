/**
 * Часы графа памяти — MEMORY_GRAPH_FIX_PLAN.md, Этап 2 (ROADMAP 5.107б). Раньше «ход» был счётчиком `turnCounter` в
 * памяти страницы (`let turnCounter = 0`) — обнулялся на КАЖДОЙ перезагрузке, ломая всё, что меряется временем: decay
 * уже существующих нод, сроки накопителя и очередей слияния/реконсолидации. Новые часы — не счётчик, а НОМЕР
 * СООБЩЕНИЯ в чате: длина истории хранится вместе с самим чатом (ST), переживает перезагрузку страницы сама по себе,
 * не двигается от реролла/свайпа (тот же ответ перегенерирован — время не прошло).
 */

/** Следующее значение часов — не меньше прежнего и не меньше текущей длины чата (удаление сообщений может УМЕНЬШИТЬ длину — часы назад не идут). */
export function advanceClock(previous, chatLength) {
    return Math.max(previous ?? 0, chatLength ?? 0);
}

/**
 * Миграция данных, записанных при старом счётчике-в-памяти: КАЖДУЮ отметку времени переводим на `now` — иначе она
 * осталась бы «из будущего» (крошечный старый счётчик выглядел бы моложе только что созданных нод, и старые ноды
 * вытеснялись бы вместо новых) или «уже давно просроченной» (накопитель/очереди сработали бы все разом в первый же
 * ход после обновления). Зовётся РОВНО ОДИН РАЗ, при первом `check()` после появления часов (см. `CLOCK_KEY` в
 * `index.js`) — все входные отметки к этому моменту гарантированно из старого режима, поэтому переписываются
 * безусловно. Возвращает НОВЫЕ объекты, входные не мутирует.
 */
export function migrateTimestamps({ nodes = {}, staging = {}, mergeQueue = {}, reconsolidationQueue = {} } = {}, now) {
    const stampNode = node => ({ ...node, createdTurn: now, lastTouchedTurn: now });
    // `lastAttemptTurn` есть только у нод, уже переживших ретрай (`attemptCount >= 2`, см. sweepStaging() в
    // index.js) — трогаем поле, только если оно вообще было, не заводим его там, где раньше не было.
    const stampStagingEntry = entry => ({ ...entry, firstAttemptTurn: now, ...(entry.lastAttemptTurn != null ? { lastAttemptTurn: now } : {}) });
    const stampQueued = entry => ({ ...entry, queuedTurn: now });
    return {
        nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, stampNode(node)])),
        staging: Object.fromEntries(Object.entries(staging).map(([id, entry]) => [id, stampStagingEntry(entry)])),
        mergeQueue: Object.fromEntries(Object.entries(mergeQueue).map(([key, entry]) => [key, stampQueued(entry)])),
        reconsolidationQueue: Object.fromEntries(Object.entries(reconsolidationQueue).map(([key, entry]) => [key, stampQueued(entry)])),
    };
}
