/** Простой устойчивый хеш строки (djb2): ключ кэша, не защита. */
export function hashText(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    return (hash >>> 0).toString(36);
}
