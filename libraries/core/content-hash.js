/**
 * Хеш содержимого файла для синхронизации — формат «git blob SHA-1»: `sha1("blob <длина>\0" + байты)`. Выбран потому, что ровно
 * такой же хеш GitHub присваивает каждому файлу в репозитории: сравнение «что изменилось» с репозиторием не требует скачивать
 * файлы, а между устройствами хеши считаются одним и тем же способом. Безопасность здесь не нужна (это отпечаток изменений, а не
 * подпись), поэтому SHA-1 годится; защита канала — в шифровании транспорта.
 */

const encoder = new TextEncoder();

export function toHex(bytes) {
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Принимает Blob/File, ArrayBuffer или Uint8Array; возвращает 40-символьную hex-строку. */
export async function computeGitBlobSha(content, { subtle = globalThis.crypto?.subtle } = {}) {
    if (!subtle) throw new Error('computeGitBlobSha: WebCrypto is not available.');
    const bytes = content instanceof Uint8Array ? content
        : content instanceof ArrayBuffer ? new Uint8Array(content)
            : new Uint8Array(await content.arrayBuffer());
    const header = encoder.encode(`blob ${bytes.byteLength}\0`);
    const joined = new Uint8Array(header.byteLength + bytes.byteLength);
    joined.set(header, 0);
    joined.set(bytes, header.byteLength);
    return toHex(await subtle.digest('SHA-1', joined));
}
