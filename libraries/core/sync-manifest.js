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
export async function buildManifest({ listing = [], cache = {}, read, hash, fingerprint, onProgress = () => {} } = {}) {
    const manifest = {};
    const nextCache = {};
    const failed = [];
    const isFresh = item => item.stamp != null && cache[item.path] && cache[item.path].stamp === item.stamp;   // штамп null — «перечитывать всегда»
    const stale = listing.filter(item => !isFresh(item));
    let done = 0;

    for (const item of listing) {
        const cached = cache[item.path];
        if (isFresh(item)) {
            manifest[item.path] = { hash: cached.hash, size: item.size ?? 0, modified: item.modified ?? 0, ...(cached.key ? { key: cached.key } : {}) };
            nextCache[item.path] = cached;
            continue;
        }
        onProgress({ done, total: stale.length, path: item.path });
        try {
            const blob = await read(item.path);
            const value = await hash(blob);
            const key = (await fingerprint?.(item.path, blob)) ?? null;
            manifest[item.path] = { hash: value, size: blob.size ?? item.size ?? 0, modified: item.modified ?? 0, ...(key ? { key } : {}) };
            if (item.stamp != null) nextCache[item.path] = { stamp: item.stamp, hash: value, ...(key ? { key } : {}) };
        } catch (error) {
            failed.push({ path: item.path, message: error?.message ?? String(error) });
        }
        done += 1;
    }
    return { manifest, cache: nextCache, hashed: stale.length - failed.length, failed };
}

/** Запомнить хеш только что записанного файла под ЕГО новым штампом, чтобы следующий проход не читал его заново. */
export function rememberWrite(cache, path, stamp, hash) {
    return { ...cache, [path]: { stamp, hash } };
}
