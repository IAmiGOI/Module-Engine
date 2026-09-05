/**
 * Собирает/разбирает один версионированный снапшот бэкапа из именованных
 * кусков сырых данных ("источников") — чистая форма, без сети, без Сервиса,
 * без знания о ЧЁМ конкретно хранится в каждом источнике. cores/backup/index.js
 * решает КАКИЕ источники существуют и как их читать/писать; этот файл — только
 * форма самого снапшота.
 */

const SNAPSHOT_VERSION = 1;

/** `sourceEntries` = `[{ id, raw }]`. */
export function buildSnapshot(sourceEntries) {
    return {
        version: SNAPSHOT_VERSION,
        createdAt: Date.now(),
        sources: Object.fromEntries(sourceEntries.map(({ id, raw }) => [id, raw])),
    };
}

/** Defensive predicate — anything that isn't at least shaped like a snapshot (an object with a `sources` object) is not one, regardless of `version`. */
export function isValidSnapshot(snapshot) {
    return Boolean(snapshot) && typeof snapshot === 'object' && Boolean(snapshot.sources) && typeof snapshot.sources === 'object';
}

/** Defensive reader — an invalid snapshot yields no sources rather than throwing; a real "this file is garbage" error is the caller's job (see cores/backup/index.js's own top-level check on import). */
export function resolveSnapshotSources(snapshot) {
    return isValidSnapshot(snapshot) ? snapshot.sources : {};
}
