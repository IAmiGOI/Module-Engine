/**
 * Сервис воспроизведения аудио — единственное место во всём движке, которое
 * создаёт `HTMLAudioElement` и держит `URL.createObjectURL`. Тот же разрез,
 * что у [audio-store.js](audio-store.js) (байты) и [dom.js](dom.js)
 * (DOM): Модулю (`module.music`) нельзя трогать ни DOM, ни веб-API самому —
 * но и «отдать ему audio-элемент» тоже нельзя, у Гейта модулей нет такого
 * канала. Вместо этого Модуль просит Сервис контрактом:
 *
 *  - `audio.playback.play`   `{ id, blob | source, volume, onEnded }` — играть трек. Источник: `blob` (свой файл) либо
 *                            `source: { kind: 'url', ref }` (прямая ссылка на аудиофайл или поток);
 *    `transition` (необязательно) — переход по плану музыкального сервера: `{ kind: 'beat'|'plain', outAt, fadeSec, bassSwapAt, rate }`. Играющий трек уходит в секунду `outAt` (граница такта),
 *                            новый входит так, что его первая доля такта попадает на сильную долю старого; в этот миг «низы» меняются местами (бас-своп), темп нового подгоняется на ±6%. Нужен Web Audio;
 *                            нет его (или нечего перекрывать) — обычный кроссфейд;
 *  - `audio.playback.pause`  `{}` — пауза;
 *  - `audio.playback.volume` `{ value }` — громкость 0…1 (применяется и до первого трека — запомнится);
 *  - `audio.playback.seek`   `{ time }` — перемотка, секунды (в пределах длительности, если она известна);
 *  - `audio.playback.state`  `{}` — снимок `{ id, playing, currentTime, duration }` (секунды; `duration` — 0, пока неизвестна).
 *
 * Байты трека Модуль достаёт сам через `audio.get` (audio-store.js) и
 * передаёт Blob сюда — объектный URL создаётся и отзывается ЗДЕСЬ, потому
 * что отзыв должен случаться в том же слое, что и создание.
 */

const clamp01 = value => Math.min(1, Math.max(0, value));

/**
 * `crossfadeMs` > 0 — смена трека на лету идёт плавно: новый <audio> наращивает громкость, старый затихает (как в кино), потом старый останавливается. 0 — резко, как раньше
 * (по умолчанию: тесты и всё, что не просило плавности). Таймер и часы подменяются для тестов.
 */
export function registerAudioPlaybackService(bus, { createAudio = () => new Audio(), crossfadeMs = 0, createContext = () => (typeof AudioContext === 'function' ? new AudioContext() : null), schedule = (callback, ms) => setTimeout(callback, ms), cancel = id => clearTimeout(id), setTimer = (callback, ms) => setInterval(callback, ms), clearTimer = id => clearInterval(id), now = () => Date.now() } = {}) {
    let element = null;      // ленивый <audio>; до первого play DOM не трогаем
    let currentUrl = null;   // объектный URL своего файла (на прямую ссылку не заводится)
    let currentId = null;
    let endedListener = null;
    let volume = 1;          // громкость, заданная до появления элемента
    let fade = null;         // идущий кроссфейд: { previous, previousUrl, timer }
    let context = null;      // Web Audio — только для переходов по плану; создаётся лениво
    let pending = null;      // ожидание точки выхода плана: { timer, resolve }
    const START_LATENCY = 0.09;   // секунд на старт <audio> (грубая поправка); остаток убирает подстройка после старта
    const BASS_CUT_DB = -26;

    /** Громкость элемента: у «подключённого» к графу элемента её держит узел громкости, иначе — свойство `volume`. */
    function setLevel(el, value) {
        if (el?._chain) { el.volume = 1; el._chain.gain.gain.value = clamp01(value); } else if (el) el.volume = clamp01(value);
    }

    function newElement() {
        const el = createAudio();
        setLevel(el, volume);
        // Один постоянный слушатель, который зовёт актуальный колбэк: раньше
        // колбэк вешался только при создании элемента, и `onEnded` следующих
        // `play()` в живой элемент уже не попадал. Затихающий старый элемент колбэк не зовёт.
        el.addEventListener('ended', () => { if (el === element) endedListener?.(); });
        return el;
    }

    function ensureElement() {
        if (!element) element = newElement();
        return element;
    }

    /** Кроссфейд закончен (или прерван): старый элемент останавливается, его объектный URL отзывается, громкость нового — полная. */
    function finishFade() {
        if (!fade) return;
        if (fade.planned) { cancel(fade.timer); const { previous, previousUrl } = fade; fade = null; try { previous.pause(); } catch { /* уже остановлен */ } if (previousUrl) URL.revokeObjectURL(previousUrl); if (element) setLevel(element, volume); return; }
        clearTimer(fade.timer);
        fade.previous.pause();
        if (fade.previousUrl) URL.revokeObjectURL(fade.previousUrl);
        if (element) setLevel(element, volume);
        fade = null;
    }

    function startFade(previous, previousUrl, next) {
        const startedAt = now();
        fade = { previous, previousUrl, timer: null };
        fade.timer = setTimer(() => {
            const progress = clamp01((now() - startedAt) / crossfadeMs);
            setLevel(previous, volume * (1 - progress));
            setLevel(next, volume * progress);
            if (progress >= 1) finishFade();
        }, 50);
    }

    function releaseUrl() {
        if (currentUrl) {
            URL.revokeObjectURL(currentUrl);
            currentUrl = null;
        }
    }

    const finiteDuration = el => (el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0);


    /** Узлы Web Audio вокруг элемента: <audio> → полка низов → громкость → выход. Создаются один раз на элемент (повторно `createMediaElementSource` нельзя). */
    function chainOf(el) {
        if (el._chain) return el._chain;
        const source = context.createMediaElementSource(el), low = context.createBiquadFilter(), gain = context.createGain();
        low.type = 'lowshelf'; low.frequency.value = 220; low.gain.value = 0;
        gain.gain.value = clamp01(el.volume);
        el.volume = 1;
        source.connect(low); low.connect(gain); gain.connect(context.destination);
        el._chain = { source, low, gain };
        return el._chain;
    }

    function cancelPending() {
        if (!pending) return;
        cancel(pending.timer);
        pending.resolve(false);   // ожидание отменено: playPlanned вернёт «не стартовал»
        pending = null;
    }

    /**
     * Переход по плану. `null` — план не выполнить (нет Web Audio, нечего перекрывать): вызывающий делает обычный кроссфейд.
     * Ждём, пока играющий трек дойдёт до `outAt` (с поправкой на задержку старта), стартуем новый с его темпом, затем ставим кривые громкости и «низов» и один раз подгоняем позицию нового.
     */
    async function playPlanned({ id, blob, source, onEnded, volume: requested, transition }) {
        const stream = source?.kind === 'url';
        const plan = transition;
        const previous = element;
        if (!plan || !previous || previous.paused || previous.ended || !id || id === currentId || !(plan.fadeSec > 0)) return null;
        context ??= createContext();
        if (!context) return null;
        try { await context.resume?.(); } catch { return null; }
        if (context.state && context.state !== 'running') return null;   // без жеста пользователя браузер держит контекст «спящим» — тогда пропустить трек через граф значило бы его заглушить
        if (Number.isFinite(requested)) volume = clamp01(requested);
        let outgoing, incoming;
        try { outgoing = chainOf(previous); } catch { return null; }
        finishFade();
        cancelPending();
        const previousUrl = currentUrl;
        currentUrl = null;
        const next = newElement();
        let nextUrl = null;
        if (stream) next.src = source.ref; else { nextUrl = URL.createObjectURL(blob); next.src = nextUrl; }
        if (Number.isFinite(plan.rate) && plan.rate > 0) next.playbackRate = plan.rate;
        try { incoming = chainOf(next); } catch { if (nextUrl) URL.revokeObjectURL(nextUrl); currentUrl = previousUrl; return null; }
        incoming.gain.gain.value = 0;
        const waitSeconds = Number.isFinite(plan.outAt) ? plan.outAt - previous.currentTime - START_LATENCY : 0;
        const started = await new Promise(resolve => {
            const go = async () => {
                pending = null;
                try { await next.play(); resolve(true); } catch { resolve(false); }
            };
            if (waitSeconds > 0.02) pending = { timer: schedule(go, waitSeconds * 1000), resolve }; else void go();
        });
        if (!started) {   // отменили ожидание или автозапуск отклонён: новый не звучит, старый продолжает
            try { next.pause(); } catch { /* уже остановлен */ }
            if (nextUrl) URL.revokeObjectURL(nextUrl);
            currentUrl = previousUrl;
            return { ok: true, started: false };
        }
        const t0 = context.currentTime, fadeSec = plan.fadeSec, level = volume;
        const aAtStart = previous.currentTime;
        element = next; currentUrl = nextUrl; currentId = id;
        endedListener = typeof onEnded === 'function' ? onEnded : null;
        if (plan.kind === 'beat') {
            const swap = Math.max(0.1, Math.min(plan.bassSwapAt ?? fadeSec / 2, fadeSec * 0.8));
            const rise = Math.min(fadeSec * 0.4, swap + 0.5);
            incoming.gain.gain.setValueAtTime(0, t0); incoming.gain.gain.linearRampToValueAtTime(level, t0 + rise);
            incoming.low.gain.setValueAtTime(BASS_CUT_DB, t0); incoming.low.gain.setValueAtTime(BASS_CUT_DB, t0 + swap - 0.02); incoming.low.gain.linearRampToValueAtTime(0, t0 + swap + 0.1);
            outgoing.low.gain.setValueAtTime(0, t0 + swap - 0.02); outgoing.low.gain.linearRampToValueAtTime(BASS_CUT_DB, t0 + swap + 0.1);
            outgoing.gain.gain.setValueAtTime(level, t0 + swap); outgoing.gain.gain.linearRampToValueAtTime(0, t0 + fadeSec);
        } else {   // без ритма: плавный кроссфейд равной мощности
            const steps = 32;
            incoming.gain.gain.setValueCurveAtTime(Float32Array.from({ length: steps }, (_, i) => level * Math.sin((i / (steps - 1)) * Math.PI / 2)), t0, fadeSec);
            outgoing.gain.gain.setValueCurveAtTime(Float32Array.from({ length: steps }, (_, i) => level * Math.cos((i / (steps - 1)) * Math.PI / 2)), t0, fadeSec);
        }
        fade = { previous, previousUrl, timer: schedule(() => finishPlannedFade(), (fadeSec + 0.2) * 1000), planned: true };
        // Подгонка: пока новый ещё почти не слышен, выравниваем его позицию с сеткой старого (старт <audio> редко точен).
        schedule(() => {
            try {
                if (element !== next) return;
                const expected = Math.max(0, previous.currentTime - (Number.isFinite(plan.outAt) ? plan.outAt : aAtStart)) * (plan.rate || 1);
                const drift = next.currentTime - expected;
                if (Math.abs(drift) > 0.025 && Math.abs(drift) < 0.5) next.currentTime = Math.max(0, next.currentTime - drift);
            } catch { /* элемент уже остановлен */ }
        }, 260);
        return { ok: true, started: true };
    }

    function finishPlannedFade() {
        if (!fade?.planned) return;
        const { previous, previousUrl } = fade;
        fade = null;
        try { previous.pause(); } catch { /* уже остановлен */ }
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        if (element) setLevel(element, volume);
    }

    const unregisters = [
        bus.register('audio.playback.play', async ({ id, blob, source, onEnded, volume: requested, transition } = {}) => {
            const stream = source?.kind === 'url';
            if (stream ? !source.ref : !blob) return { ok: false };
            if (transition) { const planned = await playPlanned({ id, blob, source, onEnded, volume: requested, transition }); if (planned) return planned; }
            const fading = crossfadeMs > 0 && element && !element.paused && !element.ended && id && id !== currentId;
            if (fading) {
                // Плавная смена: старый элемент доигрывает, новый начинает с тишины.
                finishFade();
                const previous = element, previousUrl = currentUrl;
                currentUrl = null;
                element = newElement();
                currentId = id;
                if (stream) element.src = source.ref;
                else { currentUrl = URL.createObjectURL(blob); element.src = currentUrl; }
                endedListener = typeof onEnded === 'function' ? onEnded : null;
                if (Number.isFinite(requested)) volume = clamp01(requested);
                setLevel(element, 0);
                try {
                    await element.play();
                } catch {
                    fade = { previous, previousUrl, timer: null };   // автозапуск отклонён — не оставляем тишину из двух затихших треков
                    finishFade();
                    return { ok: true, started: false };
                }
                startFade(previous, previousUrl, element);
                return { ok: true, started: true };
            }
            const el = ensureElement();
            if (!id || id !== currentId) {
                releaseUrl();
                currentId = id ?? null;
                if (stream) el.src = source.ref;
                else { currentUrl = URL.createObjectURL(blob); el.src = currentUrl; }
            }
            endedListener = typeof onEnded === 'function' ? onEnded : null;
            if (Number.isFinite(requested)) { volume = clamp01(requested); setLevel(el, volume); }
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
            cancelPending();
            finishFade();
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
                if (element && !fade) setLevel(element, volume);   // во время кроссфейда громкость ведёт сам переход (и придёт к новому уровню)
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
        cancelPending();
        finishFade();
        releaseUrl();
        element?.pause();
        element = null;
        for (const unregister of unregisters) unregister();
    };
}
