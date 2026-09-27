/**
 * Источник трека Music: откуда играть — свой файл (`local`, байты в Сервисе аудио) или прямая ссылка на аудиофайл/поток (`url`). Чистые функции без DOM и сети:
 * разбор ссылки и нормализация поля.
 *
 * Внешних сервисов (YouTube и т. п.) здесь нет намеренно — решение владельца, см. ROADMAP 5.103а.
 */

export const SOURCE_KINDS = Object.freeze({ LOCAL: 'local', URL: 'url' });

const AUDIO_EXTENSION = /\.(mp3|ogg|oga|opus|m4a|aac|wav|flac|weba)$/i;

/** Ссылка → `{ kind: 'url', url }` для прямого аудиофайла/потока (по расширению), иначе `null`. Схема без `http(s)` и не-ссылки отвергаются. */
export function parseMusicLink(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return AUDIO_EXTENSION.test(url.pathname) ? { kind: SOURCE_KINDS.URL, url: url.toString() } : null;
}

/** Поле `source` трека из хранилища → `{ kind, ref }`; мусор и старые треки (поля не было) — `local`. */
export function sanitizeSource(value) {
    if (value && typeof value === 'object' && value.kind === SOURCE_KINDS.URL && /^https?:\/\//i.test(String(value.ref ?? ''))) {
        return { kind: SOURCE_KINDS.URL, ref: String(value.ref) };
    }
    return { kind: SOURCE_KINDS.LOCAL, ref: null };
}

export const isRemoteSource = source => sanitizeSource(source).kind !== SOURCE_KINDS.LOCAL;
