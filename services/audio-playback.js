/**
 * Сервис воспроизведения аудио — единственное место во всём движке, которое
 * создаёт `HTMLAudioElement` и держит `URL.createObjectURL`. Тот же разрез,
 * что у [audio-store.js](audio-store.js) (байты) и [dom.js](dom.js)
 * (DOM): Модулю (`module.music`) нельзя трогать ни DOM, ни веб-API самому —
 * но и «отдать ему audio-элемент» тоже нельзя, у Гейта модулей нет такого
 * канала. Вместо этого Модуль просит Сервис контрактом:
 *
 *  - `audio.playback.play`  `{ id, url }` — играть URL (blob: от createObjectURL);
 *  - `audio.playback.pause` `{}` — пауза;
 *  - `audio.playback.state` `{}` — снимок `{ id, playing }`.
 *
 * Байты трека Модуль достаёт сам через `audio.get` (audio-store.js) и
 * передаёт Blob сюда — объектный URL создаётся и отзывается ЗДЕСЬ, потому
 * что отзыв должен случаться в том же слое, что и создание.
 */

export function registerAudioPlaybackService(bus) {
    let element = null;      // ленивый <audio>; до первого play DOM не трогаем
    let currentUrl = null;
    let currentId = null;
    let endedListener = null;

    function ensureElement() {
        if (element) return element;
        element = new Audio();
        if (endedListener) element.addEventListener('ended', endedListener);
        return element;
    }

    function releaseUrl() {
        if (currentUrl) {
            URL.revokeObjectURL(currentUrl);
            currentUrl = null;
        }
    }

    const unregisters = [
        bus.register('audio.playback.play', async ({ id, blob, onEnded, volume } = {}) => {
            if (!blob) return { ok: false };
            const el = ensureElement();
            if (!id || id !== currentId) {
                releaseUrl();
                currentUrl = URL.createObjectURL(blob);
                currentId = id ?? null;
                el.src = currentUrl;
            }
            endedListener = typeof onEnded === 'function' ? onEnded : null;
            if (Number.isFinite(volume)) el.volume = Math.min(1, Math.max(0, volume));
            // Промис `play()` ждём ПО-НАСТОЯЩЕМУ: autoplay-политика браузера
            // отклоняет его без жеста пользователя — и этот факт обязан дойти
            // до вызывающего (`started: false`), а не теряться в проглоченном
            // catch: по нему UI честно показывает «blocked», а не мёртвое
            // «играет».
            try {
                await el.play();
                return { ok: true, started: true };
            } catch {
                return { ok: true, started: false };
            }
        }, { loadMetric: () => 1 }),
        bus.register('audio.playback.pause', () => {
            element?.pause();
            return { ok: true };
        }, { loadMetric: () => 0 }),
        // Громкость — отдельным контрактом: она меняется ДОЛЖНА дойти и на
        // уже играющем элементе, а не только при следующем play().
        bus.register('audio.playback.volume', ({ value } = {}) => {
            if (Number.isFinite(value)) element.volume = Math.min(1, Math.max(0, value));
            return { ok: true };
        }, { loadMetric: () => 0 }),
        // ВАЖНО: шина сама оборачивает ответ в {ok, value} — возвращать голый
        // снимок, НЕ свой envelope. Двойная упаковка приводила к тому, что
        // Модуль читал .value.value и видел id/playing = undefined: после
        // каждого старта state-опрос «решал», что трек не играет (поймано вживую).
        bus.register('audio.playback.state', () => ({
            id: currentId, playing: Boolean(element && !element.paused && !element.ended),
        }), { loadMetric: () => 0 }),
    ];

    return () => {
        releaseUrl();
        element?.pause();
        element = null;
        for (const unregister of unregisters) unregister();
    };
}
