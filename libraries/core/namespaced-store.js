/**
 * Неймспейсинг поверх сырого объекта — "кто что пишет" (ARCHITECTURE.md's
 * "Персистентность"), вынесено в чистую Библиотеку, а не написано инлайном
 * внутри одного Ядра, потому что Ядро сохранения (ещё не построено) назовёт
 * ровно ту же проблему для своих данных позже. Ничего не знает о ЧЕМ
 * (chatMetadata/extensionSettings/...) хранится за пределами — только сам
 * объект, который ему передали.
 *
 * `namespace` — заявленный вызывающим идентификатор (см. cores/memory/index.js
 * за тем, откуда он берётся и почему структурно не проверяется).
 */

/** Defensive reader — a missing namespace/key yields `fallback` rather than throwing on `undefined.key`. */
export function readNamespacedValue(raw, namespace, key, fallback) {
    const bucket = raw?.[namespace];
    return bucket && Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : fallback;
}

/** Mutates `raw` in place (matching Alpha's own store convention) and returns it, so a caller can chain straight into a write-back. */
export function writeNamespacedValue(raw, namespace, key, value) {
    const store = raw ?? {};
    store[namespace] ??= {};
    store[namespace][key] = value;
    return store;
}

/** Returns true if a key actually existed and was removed, false for an already-absent key or namespace — never throws. */
export function removeNamespacedValue(raw, namespace, key) {
    const bucket = raw?.[namespace];
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, key)) return false;
    delete bucket[key];
    return true;
}

/** Keys belonging to ONE namespace only — never leaks another caller's keys. */
export function listNamespacedKeys(raw, namespace) {
    return Object.keys(raw?.[namespace] ?? {});
}
