/**
 * Сервис воспроизведения аудио — единственное место во всём движке, которое
 * создаёт `HTMLAudioElement` и держит `URL.createObjectURL`. Тот же разрез,
 * что у [audio-store.js](audio-store.js) (байты) и [dom.js](dom.js)
 * (DOM): Модулю (`module.music`) нельзя трогать ни DOM, ни веб-API самому —
 * но и «отдать ему audio-элемент» тоже нельзя, у Гейта модулей нет такого
 * канала. Вместо этого Модуль просит Сервис контрактом:
 *
 *  - `audio.playback.play`   `{ id, blob, volume, onEnded }` — играть трек (Blob; объектный URL живёт здесь);
 *  - `audio.playback.pause`  `{}` — пауза;
 *  - `audio.playback.volume` `{ value }` — громкость 0…1 (применяется и к ещё не созданному элементу — запомнится до первого play);
 *  - `audio.playback.seek`   `{ time }` — перемотка на `time` секунд (в пределах длительности, если она известна);
 *  - `audio.playback.state`  `{}` — снимок `{ id, playing, currentTime, duration }` (секунды; `duration` — 0, пока неизвестна или у потока).
 *
 * Байты трека Модуль достаёт сам через `audio.get` (audio-store.js) и
 * передаёт Blob сюда — объектный URL создаётся и отзывается ЗДЕСЬ, потому
 * что отзыв должен случаться в том же слое, что и создание.
 */

const clamp01 = value => Math.min(1, Math.max(0, value));

export function registerAudioPlaybackService(bus, { createAudio = () => new Audio() } = {}) {
    let element = null;      // ленивый <audio>; до первого play DOM не трогаем
    let currentUrl = null;
    let currentId = null;
    let endedListener = null;
    let volume = 1;          // громкость, заданная до появления элемента

    function ensureElement() {
        if (element) return element;
        element = createAudio();
        element.volume = volume;
        // Один постоянный слушатель, который зовёт актуальный колбэк: раньше
        // колбэк вешался только при создании элемента, и `onEnded` следующих
        // `play()` в живой элемент уже не попадал.
        element.addEventListener('ended', () => { endedListener?.(); });
        return element;
    }

    function releaseUrl() {
        if (currentUrl) {
            URL.revokeObjectURL(currentUrl);
            currentUrl = null;
        }
    }

    const finiteDuration = el => (el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0);

    const unregisters = [
        bus.register('audio.playback.play', async ({ id, blob, onEnded, volume: requested } = {}) => {
            if (!blob) return { ok: false };
            const el = ensureElement();
            if (!id || id !== currentId) {
                releaseUrl();
                currentUrl = URL.createObjectURL(blob);
                currentId = id ?? null;
                el.src = currentUrl;
            }
            endedListener = typeof onEnded === 'function' ? onEnded : null;
            if (Number.isFinite(requested)) { volume = clamp01(requested); el.volume = volume; }
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
        // уже играющем элементе, а не только при следующем play(). Элемента
        // может ещё не быть (ползунок двигают до первого трека) — значение
        // запоминается и применяется при его создании.
        bus.register('audio.playback.volume', ({ value } = {}) => {
            if (Number.isFinite(value)) {
                volume = clamp01(value);
                if (element) element.volume = volume;
            }
            return { ok: true };
        }, { loadMetric: () => 0 }),
        bus.register('audio.playback.seek', ({ time } = {}) => {
            if (!element || !Number.isFinite(time)) return { ok: false };
            const duration = finiteDuration(element);
            element.currentTime = Math.max(0, duration ? Math.min(time, duration) : time);
            return { ok: true };
        }, { loadMetric: () => 0 }),
        // ВАЖНО: шина сама оборачивает ответ в {ok, value} — возвращать голый
        // снимок, НЕ свой envelope. Двойная упаковка приводила к тому, что
        // Модуль читал .value.value и видел id/playing = undefined: после
        // каждого старта state-опрос «решал», что трек не играет (поймано вживую).
        bus.register('audio.playback.state', () => ({
            id: currentId,
            playing: Boolean(element && !element.paused && !element.ended),
            currentTime: element && Number.isFinite(element.currentTime) ? element.currentTime : 0,
            duration: finiteDuration(element),
        }), { loadMetric: () => 0 }),
    ];

    return () => {
        releaseUrl();
        element?.pause();
        element = null;
        for (const unregister of unregisters) unregister();
    };
}
