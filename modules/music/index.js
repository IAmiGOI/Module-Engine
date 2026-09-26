import { h } from '../../cores/ui/tree.js';
import { signal, computed, effect } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { selectTrack, shouldSwitch } from '../../libraries/core/track-selection.js';
import { clampToViewport, createDragHandlers } from '../../libraries/shared/draggable.js';
import { Button, TextInput, TextArea, Slider, Toggle, Field, Row, EmptyState, FloatingPanel } from '../../libraries/shared/widgets.js';
import { MusicPlayerBody } from '../../libraries/shared/music-player-view.js';

/**
 * Модуль «Music» — переработка Alpha'вского концепта, и разница ПОДХОДА, не
 * только кода: Alpha классифицировала сцену LLM'ом (через Tracker/SideCar) в
 * словарь ключей и сопоставляла их с ключами трека по keyword-overlap. Здесь
 * классификация НЕ нужна вовсе:
 *
 *  - трек описывается текстовой «визиткой» (по умолчанию — само имя файла),
 *    вектор считается ОДИН раз при добавлении/правке и кэшируется на треке;
 *  - сцена — текст последних реплик чата, один локальный `embedding.compute`
 *    на смену трека (модель уже загружена Memory Graph'ом или качается один
 *    раз; LLM не вызывается никогда, воркеры не нужны, сеть не нужна);
 *  - выбор — максимум косинуса, кластер близких — взвешенный biased random
 *    `1/(playCount+1)` (наследие Alpha's `selection.js`, см.
 *    [track-selection.js](../../libraries/core/track-selection.js));
 *  - ниже порога или без значимого выигрыша у кандидата играющий трек
 *    ПРОДОЛЖАЕТ играть: рваная смена на нерелевантное хуже устоявшегося.
 *
 * По критерию Ядро/Модуль — Модуль: движок работает без него, подключает
 * пользователь. Аудио-байты — через Сервис `audio.put/get/delete`
 * ([audio-store.js](../../services/audio-store.js)), метаданные — свой
 * неймспейс в `storage.settings`, как у всех Модулей.
 */

export const MODULE_ID = 'module.music';
const SETTINGS_NAMESPACE = MODULE_ID;
const TRACKS_KEY = 'tracks';
const PLAYER_KEY = 'player';
/** Размер плавающего окна плеера — по CSS (`styles/modules/music-player.css`); нужен только для удержания окна в пределах экрана при перетаскивании. */
const WINDOW_SIZE = Object.freeze({ width: 336, height: 300 });

const DEFAULTS = Object.freeze({
    autoSwitch: true,     // менять трек по сцене или только вручную
    contextMessages: 4,   // сколько последних реплик складывать в вектор сцены
    minSimilarity: 0.55,  // ниже — «ничего не подходит», играем дальше
    switchMargin: 0.05,   // насколько кандидат должен быть лучше играющего
    volume: 0.7,
    player: {},           // позиция/размер/свёрнутость FloatingPanel
});

/** Строгая нормализация списка треков из стора — мусор из JSON не должен доходить до плеера. */
export function sanitizeTracks(tracks) {
    if (!Array.isArray(tracks)) return [];
    return tracks
        .filter(track => track && typeof track === 'object')
        .map((track, index) => ({
            id: String(track.id ?? `track_${index}`),
            name: String(track.name ?? 'Untitled'),
            description: String(track.description ?? ''),
            vector: Array.isArray(track.vector) ? track.vector : null,
            playCount: Number.isFinite(track.playCount) ? track.playCount : 0,
        }));
}

/** Текст сцены: последние реплики (системные — мусор для атмосферы, выкидываем). */
export function buildSceneText(messages, limit) {
    return (Array.isArray(messages) ? messages : [])
        .filter(message => !message?.isSystem)
        .slice(-Math.max(1, limit))
        .map(message => String(message?.text ?? ''))
        .filter(Boolean)
        .join('\n')
        .trim();
}

export function createMusicModule(host) {
    const tracks = signal([]);
    const autoSwitch = signal(DEFAULTS.autoSwitch);
    const contextMessages = signal(DEFAULTS.contextMessages);
    const minSimilarity = signal(DEFAULTS.minSimilarity);
    const switchMargin = signal(DEFAULTS.switchMargin);
    const volume = signal(DEFAULTS.volume);
    const muted = signal(false);
    const progress = signal({ time: 0, duration: 0 }); // секунды; обновляется опросом Сервиса, пока трек играет

    const nowPlaying = signal({ trackId: null, name: null, playing: false, blocked: false, similarity: null });
    const busy = signal(false); // идёт пересчёт вектора сцены — защита от повторного входа
    const hudCollapsed = signal(false);
    const hudVisible = signal(true);
    const hudPosition = signal({});

    let currentTrackId = null;
    let currentSimilarity = null;
    let userPaused = false;

    async function call(contract, params) {
        return request(host.cores, contract, { params });
    }

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    async function saveTracks() {
        return call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: TRACKS_KEY, value: tracks.peek() });
    }

    async function savePlayer() {
        return call('storage.settings.set', {
            namespace: SETTINGS_NAMESPACE,
            key: PLAYER_KEY,
            value: {
                volume: volume.peek(), muted: muted.peek(), autoSwitch: autoSwitch.peek(), contextMessages: contextMessages.peek(),
                minSimilarity: minSimilarity.peek(), switchMargin: switchMargin.peek(), player: {
                    collapsed: hudCollapsed.peek(), visible: hudVisible.peek(), position: hudPosition.peek(),
                },
            },
        });
    }

    /**
     * Звук — только через Сервис `audio.playback.*`
     * ([audio-playback.js](../../services/audio-playback.js)): Модуль не
     * трогает ни DOM, ни `new Audio()`, ни `URL.createObjectURL`. Здесь же
     * оптимистичное состояние: `play()` Сервиса не ждёт (autoplay-политика
     * может молча отклонить промис) — настоящий факт «играет/нет» Модуль
     * уточняет у `audio.playback.state` (см. refreshPlayingState).
     */
    async function servicePlay(blob, track, similarity) {
        const result = await request(host.services, 'audio.playback.play', {
            params: { id: track.id, blob, volume: volume.peek(), onEnded: () => { if (!userPaused) replayCurrent(); } },
        });
        if (!result?.ok) return false;
        currentTrackId = track.id;
        currentSimilarity = similarity;
        return true;
    }

    /** Громкость: сигнал → Сервис. Читаем ЧЕРЕЗ tracked-вызов `volume()`, а не `peek()`: peek не регистрирует зависимость, и эффект не перезапускался бы никогда — ползунок ходил, громкость стояла (поймано вживую). */
    effect(() => {
        const value = muted() ? 0 : volume();
        void request(host.services, 'audio.playback.volume', { params: { value } });
    });

    /**
     * Позиция трека — опрос `audio.playback.state` раз в полсекунды, ТОЛЬКО пока трек играет: на паузе и без трека таймера нет (в тестах и в фоне он не висит).
     * Обновление — небольшой сигнал, перерисовываются только время и заливка полосы в плавающем окне.
     */
    const POLL_MS = 500;
    let pollTimer = null;
    function stopPolling() {
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    }
    async function pollProgress() {
        const result = await request(host.services, 'audio.playback.state', {});
        if (result?.ok) {
            const { currentTime = 0, duration = 0 } = result.value ?? {};
            const prev = progress.peek();
            if (prev.time !== currentTime || prev.duration !== duration) progress.set({ time: currentTime, duration });
        }
        if (!nowPlaying.peek().playing) stopPolling();
    }
    function startPolling() {
        if (pollTimer !== null) return;
        pollTimer = setInterval(() => { void pollProgress(); }, POLL_MS);
        pollTimer?.unref?.();
    }

    /** Перемотка из окна: Сервису и сразу в сигнал — полоса не ждёт следующего опроса. */
    function seek(time) {
        void request(host.services, 'audio.playback.seek', { params: { time } });
        progress.set({ ...progress.peek(), time });
    }

    function toggleMute() {
        muted.set(!muted.peek());
        savePlayer();
    }

    function toggleAutoSwitch() {
        autoSwitch.set(!autoSwitch.peek());
        savePlayer();
    }

    function setNowPlaying(patch) {
        nowPlaying.set({ ...nowPlaying.peek(), ...patch });
    }

    async function playTrack(track, similarity = null) {
        const blobResult = await request(host.services, 'audio.get', { params: { id: track.id } });
        if (!blobResult.ok || !blobResult.value) {
            await notify('error', `Audio for "${track.name}" is missing from this browser's storage — re-import it.`);
            return;
        }
        const started = await servicePlay(blobResult.value, track, similarity);
        if (!started) return;
        if (nowPlaying.peek().trackId !== track.id) {
            // playCount растёт один раз на трек (не на каждый replay) — ровно тот контракт, что ловят тесты.
            const next = tracks.peek().map(item => (item.id === track.id ? { ...item, playCount: (item.playCount ?? 0) + 1 } : item));
            tracks.set(next);
            await saveTracks();
        }
        userPaused = false;
        setNowPlaying({ trackId: track.id, name: track.name, playing: true, blocked: false, similarity });
        if (track.id !== currentTrackId || !progress.peek().duration) progress.set({ time: 0, duration: 0 });
        startPolling();
        await refreshPlayingState();
    }

    /** Уточнить у Сервиса, реально ли звучит: autoplay мог отклонить play(). */
    async function refreshPlayingState() {
        const stateResult = await request(host.services, 'audio.playback.state', {});
        if (!stateResult?.ok) return;
        const { id, playing } = stateResult.value ?? {};
        if (!playing && !userPaused) {
            setNowPlaying({ playing: false, blocked: Boolean(id) });
        }
    }

    function pause() {
        userPaused = true;
        void request(host.services, 'audio.playback.pause', {});
        setNowPlaying({ playing: false, blocked: false });
    }

    function resume() {
        const track = tracks.peek().find(item => item.id === nowPlaying.peek().trackId);
        if (!track) return skip();
        userPaused = false;
        return playTrack(track, nowPlaying.peek().similarity);
    }

    /** Вручную перебросить на следующий подходящий трек (Skip) — без порога и гистерезиса: пользователь попросил сам. */
    async function skip() {
        const sceneVector = await computeSceneVector();
        if (!sceneVector) return;
        const picked = selectTrack({
            tracks: tracks.peek(), sceneVector,
            minSimilarity: -1, // skip — намеренный: играем лучший из имеющихся, даже слабый
            closeMargin: 1, randomFn: Math.random,
        });
        if (picked) await playTrack(picked.track, picked.similarity);
    }

    function replayCurrent() {
        const track = tracks.peek().find(item => item.id === currentTrackId);
        if (track) playTrack(track, currentSimilarity).catch(() => {});
    }

    /** Один `embedding.compute` на смену трека. Недоступен — мягкая деградация: музыка продолжает играть, это не ошибка прогона. */
    async function computeSceneVector() {
        const messagesResult = await call('chatHistory.messages', { limit: Math.max(1, contextMessages.peek()) });
        if (!messagesResult.ok) return null;
        const sceneText = buildSceneText(messagesResult.value, contextMessages.peek());
        if (!sceneText) return null;
        const embeddingResult = await request(host.services, 'embedding.compute', { params: { text: sceneText, kind: 'query' } });
        return embeddingResult.ok ? embeddingResult.value : null;
    }

    /**
     * Главная смена по сцене — прямая подписка на `generation.completed`,
     * как у «RP Time» и Post-Turn Processor. Автопереключение: кандидат
     * обязан и пройти порог релевантности, и быть ЗНАЧИМО лучше играющего —
     * шум косинуса не дёргает музыку каждое сообщение.
     */
    async function onGenerationCompleted() {
        if (busy.peek() || !autoSwitch.peek() || !tracks.peek().length) return;
        busy.set(true);
        try {
            const sceneVector = await computeSceneVector();
            if (!sceneVector) return;
            const picked = selectTrack({
                tracks: tracks.peek(), sceneVector,
                minSimilarity: minSimilarity.peek(),
                closeMargin: 0.04, randomFn: Math.random,
            });
            if (!picked) return; // ничего не прошло порог — играем дальше
            const same = picked.track.id === currentTrackId;
            if (!same && !shouldSwitch({ currentSimilarity, candidateSimilarity: picked.similarity, hysteresis: switchMargin.peek() })) return;
            await playTrack(picked.track, picked.similarity);
        } finally {
            busy.set(false);
        }
    }

    // --- Библиотека треков (карточка Модуля) ---

    /** Импорт файлов: байты — в Сервис аудио, метаданные — в стор; вектор считается сразу, чтобы трек сразу участвовал в подборе. Элементы — `{name, blob}` (File в браузере: имя + байты; тесты подсовывают пару явно). */
    async function importFiles(files) {
        busy.set(true);
        try {
            for (const file of [...(files ?? [])]) {
                const rawName = String(file.name ?? 'Untitled');
                const id = `track_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                const name = rawName.replace(/\.[^./\\]+$/, '') || rawName;
                const description = name; // визитка по умолчанию — имя; пользователь перепишет своими словами
                try {
                    const putResult = await request(host.services, 'audio.put', { params: { id, blob: file.blob ?? file } });
                    if (!putResult.ok) throw new Error(putResult.error?.message ?? 'audio.put failed');
                    const vectorResult = await request(host.services, 'embedding.compute', { params: { text: description, kind: 'passage' } });
                    const vector = vectorResult.ok ? vectorResult.value : null;
                    tracks.set([...tracks.peek(), { id, name, description, vector, playCount: 0 }]);
                } catch (error) {
                    await notify('error', `Could not import "${rawName}": ${error?.message ?? String(error)}`);
                }
            }
            await saveTracks();
        } finally {
            busy.set(false);
        }
    }

    /** Правка визитки → вектор пересчитывается немедленно (иначе подбор до перезагрузки жил бы по старому описанию). */
    async function updateDescription(trackId, description) {
        const clean = String(description ?? '').trim();
        const vectorResult = await request(host.services, 'embedding.compute', { params: { text: clean, kind: 'passage' } });
        tracks.set(tracks.peek().map(item => (item.id === trackId
            ? { ...item, description: clean, vector: vectorResult.ok ? vectorResult.value : item.vector }
            : item)));
        await saveTracks();
    }

    async function removeTrack(trackId) {
        await request(host.services, 'audio.delete', { params: { id: trackId } }).catch(() => {});
        tracks.set(tracks.peek().filter(item => item.id !== trackId));
        if (currentTrackId === trackId) {
            pause();
            currentTrackId = null;
            setNowPlaying({ trackId: null, name: null, playing: false, similarity: null });
        }
        await saveTracks();
    }

    async function saveSettings() {
        await savePlayer();
        await notify('ok', 'Music settings saved');
        return true;
    }

    // --- Плавающий плеер (паттерн HUD Трекера) ---

    function playerPanel() {
        const hasTracks = computed(() => tracks().length > 0);
        return FloatingPanel('Music', {
            position: hudPosition,
            // Размера у окна нет: оно фиксированное (CSS `.stme-music-window`). Сохранённый размер прежнего изменяемого окна больше не читается — иначе его инлайновые
            // width/height обрезали бы новое (владелец: «старый размер остался в кэше, окно обрезано»).
            collapsed: hudCollapsed,
            className: 'stme-music-window',
            onToggle: value => { hudCollapsed.set(value); savePlayer(); },
            onClose: () => { hudVisible.set(false); savePlayer(); },
            drag: createDragHandlers(hudPosition, {
                onDrop: dropped => {
                    hudPosition.set(clampToViewport(dropped, {
                        width: WINDOW_SIZE.width,
                        height: WINDOW_SIZE.height,
                        viewportWidth: globalThis.innerWidth ?? 1920,
                        viewportHeight: globalThis.innerHeight ?? 1080,
                    }));
                    savePlayer();
                },
            }),
            // Окно плеера НЕизменяемое: onResize не передаём — виджет
            // сам ставит resize:none и не вешает обработчик растяжения
            // (см. FloatingPanel в libraries/shared/widgets.js).
        },
            // Разметка окна — libraries/shared/music-player-view.js (на модели music-player-model.js); здесь только состояние и действия.
            MusicPlayerBody({
                now: nowPlaying, progress, volume, muted, autoSwitch, hasTracks,
                onPlayPause: () => { if (nowPlaying.peek().playing) pause(); else resume(); },
                onSkip: skip,
                onRestart: () => seek(0),
                onSeek: seek,
                onToggleMute: toggleMute,
                onToggleAuto: toggleAutoSwitch,
                onVolumeCommit: savePlayer,
            }),
        );
    }

    /** Отдельное дерево поверх страницы — как HUD Трекера; корень обязан быть узлом, условным — только ребёнок. */
    function hud() {
        return h('div', { class: 'stme-music-hud-root' }, computed(() => (hudVisible() ? playerPanel() : null)));
    }

    // --- Карточка Модуля в панели движка ---

    function trackRow(track) {
        const draft = signal(track.description);
        const input = TextArea(draft, { rows: 2, placeholder: 'Describe the mood, e.g. "tense urban fight at night"' });
        // TextArea пишeт в сигнал сама (см. widgets.js); правка визитки
        // коммитится по `change` (он всплывает от textarea до этой обёртки)
        // через props `on:change` — у vnode нет addEventListener, слушатели
        // ставит Сервис DOM при рендере.
        const committed = h('div', { 'on:change': () => { if (draft.peek() !== track.description) updateDescription(track.id, draft.peek()); } }, input);
        return h('div', { class: 'stme-music-track' },
            Row(
                h('strong', {}, track.name),
                h('small', { class: 'stme-music-plays' }, `${track.playCount ?? 0} plays`),
                Button('×', () => { removeTrack(track.id); }, { variant: 'danger' }),
            ),
            Field('Mood description', committed, { hint: track.vector ? 'Vector computed.' : 'Vector will be computed when embedding is available.' }),
        );
    }

    function tree() {
        // Внимание: `h()` даёт АБСТРАКТНОЕ дерево, у узла нет ни addEventListener,
        // ни click() (в отличие от Alpha, где виджеты — настоящие DOM-узлы).
        // Слушатели ставит Сервис DOM по props `on:*` при рендере — значит, и
        // file-input обязан быть видимым элементом со своим `on:change`, а не
        // скрытым, кликаемым из кнопки: кнопку «нажать» за vnode нечем.
        const fileInput = h('input', {
            type: 'file', accept: 'audio/*', multiple: true, class: 'stme-music-file',
            'on:change': event => {
                const input = event.target;
                importFiles([...(input.files ?? [])].map(file => ({ name: file.name, blob: file })));
                input.value = '';
            },
        });
        return h('div', { class: 'stme-module-body' },
            Row(
                h('small', { class: 'stme-module-hint' }, 'Picks background music that matches the scene — locally, by meaning, with no model calls. Describe each track in words; the closer its description to what is happening in the chat, the more likely it plays.'),
                Button('Save settings', saveSettings),
            ),
            Row(
                Toggle('Auto-switch with the scene', autoSwitch, { onChange: savePlayer }),
                Slider('Scene depth (last messages)', contextMessages, { min: 1, max: 12, step: 1 }),
                Slider('Min similarity', minSimilarity, { min: 0, max: 1, step: 0.05 }),
                Slider('Switch margin', switchMargin, { min: 0, max: 0.5, step: 0.01 }),
            ),
            Field('Import audio files', fileInput, { hint: 'Stored locally in this browser — metadata is portable, bytes are not.' }),
            h('div', { class: 'stme-music-list' },
                computed(() => (tracks().length ? tracks().map(trackRow) : [EmptyState('No tracks yet — import audio files above.')])),
            ),
        );
    }

    // --- Жизненный цикл ---

    const subscriptions = [
        host.events.subscribe('generation.completed', () => { onGenerationCompleted(); }),
        host.events.subscribe('st.chatChanged', () => {
            // Смена чата — сцена чужого разговора: играющий трек не обязан
            // соответствовать. Не выключаем — просто пересчитываем по новой
            // сцене при следующем ответе (гистерезис сам решит).
            currentSimilarity = null;
        }),
    ];

    async function load() {
        const saved = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: TRACKS_KEY, fallback: null });
        tracks.set(sanitizeTracks(saved.ok ? saved.value : []));
        const player = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: PLAYER_KEY, fallback: null });
        if (player.ok && player.value) {
            autoSwitch.set(player.value.autoSwitch !== false);
            contextMessages.set(Number.isFinite(player.value.contextMessages) ? player.value.contextMessages : DEFAULTS.contextMessages);
            minSimilarity.set(Number.isFinite(player.value.minSimilarity) ? player.value.minSimilarity : DEFAULTS.minSimilarity);
            switchMargin.set(Number.isFinite(player.value.switchMargin) ? player.value.switchMargin : DEFAULTS.switchMargin);
            volume.set(Number.isFinite(player.value.volume) ? player.value.volume : DEFAULTS.volume);
            muted.set(Boolean(player.value.muted));
            hudCollapsed.set(Boolean(player.value.player?.collapsed));
            hudVisible.set(player.value.player?.visible !== false);
            // Позицию, сохранённую при другом размере окна (или экрана), возвращаем в пределы экрана: окно у края, ставшее шире, иначе оказалось бы обрезанным.
            const savedPosition = player.value.player?.position ?? {};
            hudPosition.set(Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.top)
                ? clampToViewport(savedPosition, { ...WINDOW_SIZE, viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })
                : savedPosition);
        }
    }

    /** Кнопка дока вызвала показ HUD-окна (generic-канал Раннера — см. requestHud в engine-wiring.js). Отсутствует у Модуля без hud — Раннер честно вернёт false. */
    function setHudVisible(value) {
        hudVisible.set(Boolean(value));
        savePlayer();
    }

    return {
        id: MODULE_ID,
        title: 'Music',
        description: 'Plays background music that matches the scene — chosen locally by embedding meaning, with no model calls.',
        load,
        tree,
        hud,
        tracks,
        nowPlaying,
        progress,
        muted,
        busy,
        volume,
        hudVisible,
        setHudVisible,
        playTrack,
        pause,
        resume,
        skip,
        seek,
        toggleMute,
        onGenerationCompleted,
        importFiles,
        updateDescription,
        removeTrack,
        saveSettings,
        stop: () => {
            stopPolling();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            void request(host.services, 'audio.playback.pause', {});
        },
    };
}
