import { MUSIC_STYLE_LABELS } from './music-catalog.js';
/**
 * Модель окна плеера Music: чистые функции без DOM и шин — что показать по состоянию проигрывателя. Само окно (`music-player-view.js`) только раскладывает результат по
 * разметке; ничего из этого не знает о браузере, поэтому проверяется как данные.
 */

/** «3:07», «1:02:09»; неизвестное (нет длительности, поток, NaN) — «–:––», чтобы ширина цифр не прыгала. */
export function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const two = value => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

/** Доля пройденного, 0…100 (десятые); без длительности — 0. */
export function progressPercent(time, duration) {
    if (!(duration > 0) || !Number.isFinite(time)) return 0;
    return Math.round(Math.min(100, Math.max(0, (time / duration) * 100)) * 10) / 10;
}

/** Положение ползунка (0…100) → секунды трека. */
export function timeFromPercent(percent, duration) {
    if (!(duration > 0) || !Number.isFinite(percent)) return 0;
    return (Math.min(100, Math.max(0, percent)) / 100) * duration;
}

/** Хеш имени (FNV-1a): у одного и того же трека всегда одна и та же обложка. */
function hashName(name) {
    let hash = 0x811c9dc5;
    for (const char of String(name ?? '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** Два оттенка обложки трека, выведенные из его имени. */
export function coverHues(name) {
    const hash = hashName(name);
    const hue = hash % 360;
    return { hue, hue2: (hue + 35 + ((hash >>> 9) % 55)) % 360 };
}

/** CSS-градиент обложки: насыщенный сверху-слева, глубокий снизу-справа. */
export function coverGradient(name) {
    const { hue, hue2 } = coverHues(name);
    return `linear-gradient(135deg, hsl(${hue} 62% 48%), hsl(${hue2} 58% 28%))`;
}

/** Мягкая подсветка окна цветами обложки текущего трека: два пятна света в верхних углах, окно «окрашивается» под трек. */
export function coverGlow(name) {
    const { hue, hue2 } = coverHues(name);
    return `radial-gradient(130% 120% at 0% 0%, hsl(${hue} 62% 46% / .42), transparent 68%), radial-gradient(90% 100% at 100% 0%, hsl(${hue2} 58% 34% / .28), transparent 70%)`;
}

/** Буква на обложке: первый значащий символ имени, иначе «♪». */
export function trackInitial(name) {
    const match = String(name ?? '').match(/[\p{L}\p{N}]/u);
    return match ? match[0].toUpperCase() : '♪';
}

/** Косинус сходства (−1…1) → целые проценты 0…100 для подписи; неизвестное — `null`. */
export function matchPercent(similarity) {
    if (!Number.isFinite(similarity)) return null;
    return Math.round(Math.min(1, Math.max(0, similarity)) * 100);
}

/**
 * Что писать в окне: `status` (`idle`/`playing`/`paused`/`blocked`), заголовок и подзаголовок.
 * `autoSwitch` — подбирает ли плеер трек по сцене сам, `hasTracks` — есть ли что играть (от них зависит подсказка пустого состояния).
 */
export function describeNowPlaying({ trackId = null, name = null, playing = false, blocked = false, similarity = null } = {}, { autoSwitch = true, hasTracks = true } = {}) {
    if (!trackId) {
        const subtitle = !hasTracks ? 'Add tracks in the Music settings'
            : autoSwitch ? 'A track is picked to match the scene' : 'Press play or skip to pick a track';
        return { status: 'idle', title: 'Nothing playing', subtitle };
    }
    const title = name || 'Untitled';
    if (blocked) return { status: 'blocked', title, subtitle: 'The browser blocked autoplay — press play' };
    if (!playing) return { status: 'paused', title, subtitle: 'Paused' };
    const percent = matchPercent(similarity);
    return { status: 'playing', title, subtitle: percent === null ? 'Chosen by hand' : `Matches the scene · ${percent}%` };
}

/** Значок громкости: выключено / тихо / громко. */
export function volumeLevel(volume, muted = false) {
    if (muted || !(volume > 0)) return 'muted';
    return volume < 0.5 ? 'low' : 'high';
}

/**
 * Подпись у кнопок «верно / неверно» для играющего трека сервера. Отметка идёт владельцу в очередь на проверку (эталоном она становится только после его разбора),
 * поэтому обещаем только «отправлено».
 */
export function describeFeedback({ mark = null, status = 'idle', wanted = null } = {}) {
    if (status === 'sending') return 'Sending…';
    if (status === 'failed') return 'Could not send — try again';
    if (status === 'sent') return wanted ? `Sent: this scene needs “${wanted}”` : mark === 'bad' ? 'Sent: wrong music for this scene' : 'Sent: right music for this scene';
    return 'Is this the right music?';
}

/** Подпись у оценки типа музыки: какой тип выбрал сервер и что с оценкой. `correct` — тип, названный владельцем, когда выбор был неверным. */
export function describeStyle({ chosen = null, status = 'idle', right = null, correct = null } = {}) {
    const name = id => MUSIC_STYLE_LABELS[id] ?? id;
    if (status === 'sending') return 'Sending…';
    if (status === 'failed') return 'Could not send — try again';
    if (status === 'sent') return right ? `Sent: ${name(chosen)} is right for this scene` : `Sent: this scene needs ${name(correct)}, not ${name(chosen)}`;
    return `Type: ${name(chosen)} — right?`;
}
