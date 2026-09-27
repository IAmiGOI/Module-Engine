import { request } from '../../libraries/shared/request.js';
import { SOURCE_KINDS, parseMusicLink } from '../../libraries/shared/music-source.js';

/**
 * Добавление трека по прямой ссылке на аудиофайл или поток (`.mp3`, `.ogg`, радио и т. п.): в библиотеку записывается только адрес и метаданные, вектор подбора — локальным
 * `embedding.compute`, как у файлов. Возвращает `{ tracks, skipped }` либо `{ error }` (текст для пользователя).
 */

const hashText = text => { let hash = 0; for (const char of text) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0; return hash.toString(36); };

export async function importLink({ host, text, knownIds = new Set() }) {
    const parsed = parseMusicLink(text);
    if (!parsed) return { error: 'That is not a direct audio link (.mp3, .ogg, .m4a, .flac …).' };
    const name = decodeURIComponent(new URL(parsed.url).pathname.split('/').pop() ?? '').replace(/\.[^./]+$/, '') || 'Stream';
    const id = `url_${hashText(parsed.url)}`;
    if (knownIds.has(id)) return { tracks: [], skipped: 1 };
    const embedded = await request(host.services, 'embedding.compute', { params: { text: name, kind: 'passage' } });
    return {
        tracks: [{ id, name, description: name, vector: embedded.ok ? embedded.value : null, playCount: 0, artist: '', tagged: 'name', source: { kind: SOURCE_KINDS.URL, ref: parsed.url } }],
        skipped: 0,
    };
}
