/**
 * Сборка локального манифеста («путь → хеш, размер, время») из листингов источников ST. Читать и хешировать каждый файл при каждом
 * проходе нельзя (50 ГБ), поэтому у каждого файла есть дешёвый «штамп» (размер + время изменения / ETag — то, что источник отдаёт
 * без чтения тела). Пока штамп совпал с записанным в кэше, хеш берётся из кэша; изменился — файл читается и хешируется заново.
 *
 * Чистая логика: чтение файла и хеш приходят инъекцией.
 */

/**
 * @param {object} input
 * @param {Array<{path:string,size?:number,stamp:string,modified?:number}>} input.listing — что сейчас есть (от источников)
 * @param {Record<string,{stamp:string,hash:string}>} input.cache — прошлые хеши по штампам
 * @param {(path:string)=>Promise<Blob>} input.read
 * @param {(blob:Blob)=>Promise<string>} input.hash
 * @param {(state:{done:number,total:number,path:string})=>void} [input.onProgress]
 * @returns {Promise<{manifest:Record<string,object>, cache:Record<string,object>, hashed:number, failed:Array<{path:string,message:string}>}>}
 */
export async function buildManifest({ listing = [], cache = {}, read, hash, onProgress = () => {} } = {}) {
    const manifest = {};
    const nextCache = {};
    const failed = [];
    const isFresh = item => item.stamp != null && cache[item.path] && cache[item.path].stamp === item.stamp;   // штамп null — «перечитывать всегда»
    const stale = listing.filter(item => !isFresh(item));
    let done = 0;

    for (const item of listing) {
        const cached = cache[item.path];
        if (isFresh(item)) {
            manifest[item.path] = { hash: cached.hash, size: item.size ?? 0, modified: item.modified ?? 0 };
            nextCache[item.path] = cached;
            continue;
        }
        onProgress({ done, total: stale.length, path: item.path });
        try {
            const blob = await read(item.path);
            const value = await hash(blob);
            manifest[item.path] = { hash: value, size: blob.size ?? item.size ?? 0, modified: item.modified ?? 0 };
            if (item.stamp != null) nextCache[item.path] = { stamp: item.stamp, hash: value };
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
