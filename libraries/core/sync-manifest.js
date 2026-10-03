/**
 * Сборка локального манифеста («путь → хеш, размер, время») из листингов источников ST. Читать и хешировать каждый файл при каждом
 * проходе нельзя (50 ГБ), поэтому у каждого файла есть дешёвый «штамп» (размер + время изменения / ETag — то, что источник отдаёт
 * без чтения тела). Пока штамп совпал с записанным в кэше, хеш (и, если есть, семантический ключ) берётся из кэша; изменился —
 * файл читается и хешируется заново.
 *
 * `key` — семантический отпечаток содержимого (например, `computeCardFingerprint` для персонажей — см. `card-fingerprint.js`):
 * необязательный, включается только для тех путей, для которых вызывающий передал `fingerprint`. Кэш хранит его РЯДОМ с байтовым
 * `hash`, не вместо него — обычный хеш всё ещё нужен как публикуемое значение для сторон, которые `key` не понимают (GitHub/облако,
 * см. doc-comment `sync-plan.js`). Запись без `key` в кэше (снятая до появления этой функции) остаётся без него, пока файл не
 * перечитается заново — миграция сама по себе, без отдельного прохода.
 *
 * Чистая логика: чтение файла и хеш приходят инъекцией.
 */

/**
 * @param {object} input
 * @param {Array<{path:string,size?:number,stamp:string,modified?:number}>} input.listing — что сейчас есть (от источников)
 * @param {Record<string,{stamp:string,hash:string,key?:string}>} input.cache — прошлые хеши по штампам
 * @param {(path:string)=>Promise<Blob>} input.read
 * @param {(blob:Blob)=>Promise<string>} input.hash
 * @param {(path:string, blob:Blob)=>Promise<string|null>} [input.fingerprint] — семантический ключ для путей, где это применимо;
 *   `null`/не задан → у записи манифеста просто не будет `key`, сравнение в `sync-plan.js` идёт по обычному `hash`.
 * @param {(state:{done:number,total:number,path:string})=>void} [input.onProgress]
 * @returns {Promise<{manifest:Record<string,object>, cache:Record<string,object>, hashed:number, failed:Array<{path:string,message:string}>}>}
 */
export async function buildManifest({ listing = [], cache = {}, read, hash, fingerprint, onProgress = () => {}, concurrency = 1 } = {}) {
    const manifest = {};
    const nextCache = {};
    const failed = [];
    const isFresh = item => item.stamp != null && cache[item.path] && cache[item.path].stamp === item.stamp;   // штамп null — «перечитывать всегда»
    const stale = listing.filter(item => !isFresh(item));
    let done = 0;

    for (const item of listing) {
        if (!isFresh(item)) continue;
        const cached = cache[item.path];
        manifest[item.path] = { hash: cached.hash, size: item.size ?? 0, modified: item.modified ?? 0, ...(cached.key ? { key: cached.key } : {}) };
        nextCache[item.path] = cached;
    }
    // Устаревшие читаются и хешируются по несколько штук одновременно (на первом проходе это ВСЕ файлы); порядок ключей манифеста
    // восстанавливается по порядку листинга ниже, чтобы результат не зависел от того, какое чтение закончилось раньше.
    const results = new Map();
    let next = 0;
    const worker = async () => {
        while (next < stale.length) {
            const item = stale[next]; next += 1;
            onProgress({ done, total: stale.length, path: item.path });
            try {
                const blob = await read(item.path);
                const value = await hash(blob);
                const key = (await fingerprint?.(item.path, blob)) ?? null;
                results.set(item.path, { entry: { hash: value, size: blob.size ?? item.size ?? 0, modified: item.modified ?? 0, ...(key ? { key } : {}) }, cache: item.stamp != null ? { stamp: item.stamp, hash: value, ...(key ? { key } : {}) } : null });
            } catch (error) {
                results.set(item.path, { error: error?.message ?? String(error) });
            }
            done += 1;
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, stale.length)) }, worker));
    for (const item of stale) {
        const result = results.get(item.path);
        if (result.error !== undefined) { failed.push({ path: item.path, message: result.error }); continue; }
        manifest[item.path] = result.entry;
        if (result.cache) nextCache[item.path] = result.cache;
    }
    return { manifest: Object.fromEntries(listing.filter(item => manifest[item.path]).map(item => [item.path, manifest[item.path]])), cache: nextCache, hashed: stale.length - failed.length, failed };
}

/** Запомнить хеш только что записанного файла под ЕГО новым штампом, чтобы следующий проход не читал его заново. */
export function rememberWrite(cache, path, stamp, hash) {
    return { ...cache, [path]: { stamp, hash } };
}
