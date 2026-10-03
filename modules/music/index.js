/*@module
id: module.music
title: Music
description: Plays background music that matches the scene — chosen locally by embedding meaning, with no model calls.
version: 0.2.1
engine: ^0.2
factory: createMusicModule
rights: storage.settings.get, storage.settings.set, ui.notify,
# Текст сцены — через общее Ядро истории чата, не напрямую в ST.
chatHistory.messages,
# Аудио-байты — только через Сервис хранилища (indexedDB).
audio.put, audio.get, audio.delete,
# Звук — только через Сервис воспроизведения (единственный владелец <audio>).
audio.playback.play, audio.playback.pause, audio.playback.state, audio.playback.volume, audio.playback.seek,
# Разметка треков моделью пользователя (описания настроения → эмбединг).
model.generate,
# Вектор сцены и вектора треков — локальный эмбединг.
embedding.compute, embedding.similarity,
# Разделы музыкального сервера владельца (сеть — только у Ядра).
musicServer.sections, musicServer.section, musicServer.pick,
# Умный выбор: Jev пользователя оценивает категории сцены (запрос от сервера, ответ идёт только как номер категории).
classifier.decide
*/
import { numberSetting, booleanSetting } from '../../libraries/core/guide-settings.js';
import { h } from '../../cores/ui/tree.js';
import { signal, computed, effect } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { EMBEDDING_MODEL_ID } from '../../libraries/core/embedding.js';
import { selectTrack, shouldSwitch, pickWeighted } from '../../libraries/core/track-selection.js';
import { clampToViewport, createDragHandlers } from '../../libraries/shared/draggable.js';
import { FloatingPanel } from '../../libraries/shared/widgets.js';
import { MusicPlayerBody } from '../../libraries/shared/music-player-view.js';
import { sanitizeSource, isRemoteSource } from '../../libraries/shared/music-source.js';
import { importLink } from './link-import.js';
import { DEFAULTS, sanitizeTracks, buildSceneText, sceneMessages, blendSceneVectors } from './tracks.js';
import { createMusicCard } from './card.js';
import { createServerSection } from './server-section.js';
import { isServerTrack } from '../../libraries/shared/music-catalog.js';
import { tagWithModel } from './tagging.js';
import { embeddingText, TAG_KINDS } from '../../libraries/shared/music-tagging.js';

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

export { sanitizeTracks, buildSceneText };   // прежнее место импорта для тестов и Раннера
export const MODULE_ID = 'module.music';
const SETTINGS_NAMESPACE = MODULE_ID;
const TRACKS_KEY = 'tracks';
const PLAYER_KEY = 'player';
const EMBEDDING_MODEL_KEY = 'embeddingModel';   // какой моделью посчитаны векторы своих треков
/** Размер плавающего окна плеера — по CSS (`styles/modules/music-player.css`); нужен только для удержания окна в пределах экрана при перетаскивании. */
const WINDOW_SIZE = Object.freeze({ width: 336, height: 300 });

export function createMusicModule(host) {
    const tracks = signal([]);
    const autoSwitch = signal(DEFAULTS.autoSwitch);
    const contextMessages = signal(DEFAULTS.contextMessages);
    const minSimilarity = signal(DEFAULTS.minSimilarity);
    const switchMargin = signal(DEFAULTS.switchMargin);
    const volume = signal(DEFAULTS.volume);
    const muted = signal(false);
    const autoTag = signal(DEFAULTS.autoTag);
    const smart = signal(DEFAULTS.smart);   // «умное» определение сцены через Jev; сколько и когда спрашивать, решает сервер
    const server = createServerSection(host);   // раздел сервера владельца: треки не показываются и не сохраняются
    const progress = signal({ time: 0, duration: 0 }); // секунды; обновляется опросом Сервиса, пока трек играет

    const nowPlaying = signal({ trackId: null, name: null, playing: false, blocked: false, similarity: null });
    const busy = signal(false); // идёт пересчёт вектора сцены — защита от повторного входа
    const hudCollapsed = signal(false);
    const hudVisible = signal(true);
    const hudPosition = signal({});

    let currentTrackId = null;
    let currentSimilarity = null;
    let userPaused = false;

    // Раздел сервера: подбор делает САМ сервер (ME шлёт только вектор сцены). Трек, который он выбрал, ME знает лишь по id и адресу аудио.
    let remoteTrack = null;
    const remote = () => server.mode.peek() === 'server' && Boolean(server.selected.peek());

    let lastIntensity = null;   // накал прошлой сцены (его вернул сервер): нужен ему для сглаживания
    let lastSceneText = '';

    /**
     * Спросить Jev пользователя про категории сцены. Вопросы пришли от сервера; уходят они в подключение Jev самого пользователя вместе с текстом сцены, а серверу
     * возвращаются только вероятности. Нет подключения / сбой / тайм-аут — пустой ответ, и сервер выбирает по вектору.
     */
    async function askJev(questions) {
        if (!lastSceneText) return {};
        const result = await call('classifier.decide', { calls: [{ state: { latest_turn: lastSceneText }, questions }] });
        return result.ok && result.value?.answers && typeof result.value.answers === 'object' ? result.value.answers : {};
    }

    // Следующий трек просим у сервера заранее (за PREFETCH_S до конца), держим ответ и запускаем за SWITCH_LEAD_S — с кроссфейдом, без тишины на запрос и вопрос к Jev.
    const PREFETCH_S = 20, SWITCH_LEAD_S = 3.5;
    let queuedNext = null;       // { track, similarity } — ответ сервера, ждущий своего часа
    let prefetchFor = null;      // id трека, для которого запрос уже ушёл
    let prefetching = null;      // идущий запрос (Promise)

    async function pickRemote({ vector, ended = false, force = false, queue = false } = {}) {
        const state = nowPlaying.peek().playing ? progress.peek() : { time: null, duration: 0 };
        const params = {
            section: server.selected.peek(), vector, current: remoteTrack?.rawId ?? null, ended, force, minSimilarity: minSimilarity.peek(), switchMargin: switchMargin.peek(),
            smart: smart.peek() && !force, lastIntensity,
            elapsed: state.time, remaining: state.duration ? Math.max(0, state.duration - state.time) : null,
        };
        let result = await request(host.cores, 'musicServer.pick', { params });
        let value = result.ok ? result.value : null;
        if (value?.action === 'ask') {   // смена назрела — сервер просит Jev оценить сцену (один раз, только сейчас)
            const answers = await askJev(value.questions);
            result = await request(host.cores, 'musicServer.pick', { params: { ...params, answers } });
            value = result.ok ? result.value : null;
        }
        if (Number.isFinite(value?.intensity)) lastIntensity = value.intensity;
        if (value?.action !== 'play') return;   // «оставь» и «ничего не подходит» — играющее продолжается
        if (queue) { queuedNext = { track: value.track, similarity: value.similarity }; return; }
        remoteTrack = value.track;
        await playTrack(value.track, value.similarity);
    }

    function playQueued() {
        const next = queuedNext;
        queuedNext = null;
        if (!next) return false;
        remoteTrack = next.track;
        void playTrack(next.track, next.similarity).catch(() => {});
        return true;
    }

    /** Звучащий серверный трек подходит к концу: сначала просим следующий, потом (в последние секунды) запускаем его — раньше ME спрашивал только после «ended», и на запрос уходила тишина. */
    function advanceRemote(time, duration) {
        if (!remote() || userPaused || !nowPlaying.peek().playing || remoteTrack?.id !== currentTrackId || !(duration > 0)) return;
        const remaining = duration - time;
        // Тот же трек (в группе он один) заранее не «переключаем»: он перезапустится сам, когда доиграет (событие ended).
        if (queuedNext) { if (remaining <= SWITCH_LEAD_S && queuedNext.track.id !== currentTrackId) playQueued(); return; }
        if (prefetching || prefetchFor === currentTrackId || remaining > PREFETCH_S || time < 1) return;
        prefetchFor = currentTrackId;
        prefetching = computeSceneVector().then(vector => pickRemote({ vector, ended: true, queue: true })).catch(() => {}).finally(() => { prefetching = null; });
    }

    /** Всё, из чего подбираем: свои треки и треки выбранного раздела сервера. */
    const pool = () => [...tracks.peek(), ...server.tracks.peek()];

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
                section: server.selected.peek(), smart: smart.peek(), serverSelection: server.mode.peek(), volume: volume.peek(), muted: muted.peek(), autoTag: autoTag.peek(), autoSwitch: autoSwitch.peek(), contextMessages: contextMessages.peek(),
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
        const source = sanitizeSource(track.source);
        const result = await request(host.services, 'audio.playback.play', {
            params: {
                id: track.id, volume: muted.peek() ? 0 : volume.peek(), onEnded: () => { if (!userPaused) replayCurrent(); },
                ...(isRemoteSource(source) ? { source } : { blob }),
            },
        });
        if (!result?.ok || result.value?.ok === false) return false;
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
            advanceRemote(currentTime, duration);
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
        const source = sanitizeSource(track.source);
        let blob = null;
        if (!isRemoteSource(source)) {
            const blobResult = await request(host.services, 'audio.get', { params: { id: track.id } });
            if (!blobResult.ok || !blobResult.value) {
                await notify('error', `Audio for "${track.name}" is missing from this browser's storage — re-import it.`);
                return;
            }
            blob = blobResult.value;
        }
        const isNew = nowPlaying.peek().trackId !== track.id;
        queuedNext = null; prefetchFor = null;   // что-то начинает играть — ожидавший следующий трек больше не актуален
        const started = await servicePlay(blob, track, similarity);
        if (!started) return;
        if (isNew) {
            // playCount растёт один раз на трек (не на каждый replay) — ровно тот контракт, что ловят тесты.
            const bump = item => (item.id === track.id ? { ...item, playCount: (item.playCount ?? 0) + 1 } : item);
            if (isServerTrack(track)) server.tracks.set(server.tracks.peek().map(bump));   // у серверных счётчик только в памяти
            else { tracks.set(tracks.peek().map(bump)); await saveTracks(); }
        }
        userPaused = false;
        setNowPlaying({ trackId: track.id, name: isServerTrack(track) ? (server.sectionName.peek() || 'Music') : track.name, playing: true, blocked: false, similarity });
        progress.set({ time: 0, duration: isNew ? 0 : progress.peek().duration });   // время всегда с нуля: иначе повтор того же трека сразу счёл бы себя «концом»
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
        const track = pool().find(item => item.id === nowPlaying.peek().trackId) ?? (remoteTrack?.id === nowPlaying.peek().trackId ? remoteTrack : null);
        if (!track) return skip();
        userPaused = false;
        return playTrack(track, nowPlaying.peek().similarity);
    }

    /** Вручную перебросить на следующий подходящий трек (Skip) — без порога и гистерезиса: пользователь попросил сам. */
    async function skip() {
        const sceneVector = await computeSceneVector();
        if (!sceneVector) return;
        if (remote()) return pickRemote({ vector: sceneVector, force: true });
        const picked = selectTrack({
            tracks: pool(), sceneVector,
            minSimilarity: -1, // skip — намеренный: играем лучший из имеющихся, даже слабый
            closeMargin: 1, randomFn: Math.random,
        });
        if (picked) await playTrack(picked.track, picked.similarity);
    }

    /**
     * Трек закончился: свой трек играет заново, а в серверной группе — другой трек той же группы (по очереди, `1/(playCount+1)`), чтобы группа не крутила один и тот же.
     * В группе один трек — повторяется он.
     */
    function replayCurrent() {
        if (remote() && remoteTrack?.id === currentTrackId) {   // трек доиграл: заранее запрошенный следующий уже ждёт — иначе выбирается по сцене СЕЙЧАС; нет вектора — другой трек той же группы
            void (async () => {
                if (prefetching) await prefetching;
                if (playQueued()) return;
                const vector = await computeSceneVector();
                await pickRemote({ vector, ended: true });
            })().catch(() => {});
            return;
        }
        const all = pool();
        const track = all.find(item => item.id === currentTrackId);
        if (!track) return;
        const sameGroup = track.group ? all.filter(item => item.group === track.group && item.id !== track.id) : [];
        playTrack(pickWeighted(sameGroup) ?? track, currentSimilarity).catch(() => {});
    }

    /** Один `embedding.compute` на смену трека. Недоступен — мягкая деградация: музыка продолжает играть, это не ошибка прогона. */
    async function computeSceneVector() {
        const messagesResult = await call('chatHistory.messages', { limit: Math.max(1, contextMessages.peek()) });
        if (!messagesResult.ok) return null;
        const parts = sceneMessages(messagesResult.value, contextMessages.peek());
        if (!parts.length) return null;
        lastSceneText = buildSceneText(messagesResult.value, contextMessages.peek());
        // Каждая реплика — своим вектором, свежие весят больше (см. blendSceneVectors): длинное старое сообщение не заглушает свежую реплику.
        const vectors = [];
        for (const part of parts) {
            const embedded = await request(host.services, 'embedding.compute', { params: { text: part, kind: 'query' } });
            vectors.push(embedded.ok ? embedded.value : null);
        }
        return blendSceneVectors(vectors);
    }

    /**
     * Главная смена по сцене — прямая подписка на `generation.completed`,
     * как у «RP Time» и Post-Turn Processor. Автопереключение: кандидат
     * обязан и пройти порог релевантности, и быть ЗНАЧИМО лучше играющего —
     * шум косинуса не дёргает музыку каждое сообщение.
     */
    async function onGenerationCompleted() {
        if (busy.peek() || !autoSwitch.peek() || (!pool().length && !remote())) return;
        busy.set(true);
        try {
            const sceneVector = await computeSceneVector();
            if (!sceneVector) return;
            if (remote()) { await pickRemote({ vector: sceneVector }); return; }
            const picked = selectTrack({
                tracks: pool(), sceneVector,
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

    /**
     * Разметка МОДЕЛЬЮ: по названию и исполнителю модель пишет описание настроения и сцены, из него локальный эмбединг делает вектор — так трек включается по смыслу сама,
     * без ручных описаний. `force` — перемаркировать и уже размеченные моделью (кнопка); без него — только размеченные одним названием. Руками правленные (`manual`) не
     * трогаются никогда. Нет модели/отказ — треки остаются на описании по названию, пользователю говорим об этом ОДНИМ сообщением.
     */
    async function tagTracks(ids, { force = false } = {}) {
        const wanted = new Set(ids);
        const items = tracks.peek()
            .filter(track => wanted.has(track.id) && track.tagged !== TAG_KINDS.MANUAL && (force || track.tagged === TAG_KINDS.NAME))
            .map(track => ({ id: track.id, name: track.name, artist: track.artist }));
        if (!items.length) return { tagged: 0, total: 0 };
        busy.set(true);
        try {
            const { descriptions, error } = await tagWithModel({ host, items });
            const updates = new Map();
            for (const item of items) {
                const text = descriptions.get(item.id);
                if (!text) continue;
                const description = embeddingText({ name: item.name, artist: item.artist, description: text });
                const vectorResult = await request(host.services, 'embedding.compute', { params: { text: description, kind: 'passage' } });
                updates.set(item.id, { description, vector: vectorResult.ok ? vectorResult.value : null, tagged: TAG_KINDS.MODEL });
            }
            if (updates.size) {
                // Трек мог быть правлен рукой, пока модель думала — такую запись не перетираем.
                tracks.set(tracks.peek().map(track => (updates.has(track.id) && track.tagged !== TAG_KINDS.MANUAL ? { ...track, ...updates.get(track.id) } : track)));
                await saveTracks();
            }
            if (error && !updates.size) await notify('error', `The model did not describe the tracks: ${error}. They stay described by title — connect a text model and press "Describe with the model".`);
            else if (updates.size < items.length) await notify('warn', `The model described ${updates.size} of ${items.length} tracks${error ? ` (${error})` : ''}. The rest stay described by title.`);
            else await notify('ok', `The model described ${updates.size} track${updates.size === 1 ? '' : 's'}.`);
            return { tagged: updates.size, total: items.length };
        } finally {
            busy.set(false);
        }
    }

    /** Импорт файлов: байты — в Сервис аудио, метаданные — в стор; вектор считается сразу, чтобы трек сразу участвовал в подборе. Элементы — `{name, blob}` (File в браузере: имя + байты; тесты подсовывают пару явно). */
    async function importFiles(files) {
        const imported = [];
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
                    tracks.set([...tracks.peek(), { id, name, description, vector, playCount: 0, source: { kind: 'local', ref: null }, artist: '', tagged: TAG_KINDS.NAME }]);
                    imported.push(id);
                } catch (error) {
                    await notify('error', `Could not import "${rawName}": ${error?.message ?? String(error)}`);
                }
            }
            await saveTracks();
        } finally {
            busy.set(false);
        }
        if (imported.length && autoTag.peek()) await tagTracks(imported);
    }

    /** Добавить трек по прямой ссылке на аудиофайл или поток: адрес и вектор, звук не скачивается. */
    async function importLinkText(text) {
        let added = [];
        busy.set(true);
        try {
            const result = await importLink({ host, text, knownIds: new Set(tracks.peek().map(item => item.id)) });
            if (result.error) { await notify('error', result.error); return false; }
            if (result.tracks.length) { tracks.set([...tracks.peek(), ...result.tracks]); await saveTracks(); }
            added = result.tracks.map(track => track.id);
            await notify('ok', result.tracks.length
                ? `Added ${result.tracks.length} track${result.tracks.length === 1 ? '' : 's'}${result.skipped ? ` (${result.skipped} already in the library)` : ''}.`
                : 'Nothing new — these tracks are already in the library.');
            return true;
        } finally {
            busy.set(false);
            if (added.length && autoTag.peek()) await tagTracks(added);
        }
    }

    /** Правка визитки → вектор пересчитывается немедленно (иначе подбор до перезагрузки жил бы по старому описанию). */
    async function updateDescription(trackId, description) {
        const clean = String(description ?? '').trim();
        const vectorResult = await request(host.services, 'embedding.compute', { params: { text: clean, kind: 'passage' } });
        tracks.set(tracks.peek().map(item => (item.id === trackId
            ? { ...item, description: clean, vector: vectorResult.ok ? vectorResult.value : item.vector, tagged: TAG_KINDS.MANUAL }
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
        const hasTracks = computed(() => tracks().length + server.tracks().length > 0 || (server.mode() === 'server' && server.selected() !== ''));
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

    function tree() {
        return createMusicCard({
            tracks, autoSwitch, contextMessages, minSimilarity, switchMargin, autoTag, smart,
            server,
            actions: { chooseSection, saveSettings, savePlayer, importFiles, importLinkText, tagTracks, updateDescription, removeTrack },
        });
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

    /**
     * Векторы своих треков посчитаны конкретной моделью; после смены модели (5.147: мультиязычная → английская e5) они несравнимы с векторами сцен, поэтому пересчитываются
     * один раз по тексту визитки. Модель недоступна — ничего не трогаем и повторим при следующей загрузке.
     */
    async function migrateVectorsIfNeeded() {
        const stored = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: EMBEDDING_MODEL_KEY, fallback: null });
        if (stored.ok && stored.value === EMBEDDING_MODEL_ID) return;
        const list = tracks.peek();
        if (list.length) {
            const fresh = [];
            for (const track of list) {
                const embedded = await request(host.services, 'embedding.compute', { params: { text: track.description || track.name, kind: 'passage' } });
                if (!embedded.ok || !Array.isArray(embedded.value)) return;
                fresh.push(embedded.value);
            }
            tracks.set(list.map((track, index) => ({ ...track, vector: fresh[index] })));
            await saveTracks();
        }
        await call('storage.settings.set', { namespace: SETTINGS_NAMESPACE, key: EMBEDDING_MODEL_KEY, value: EMBEDDING_MODEL_ID });
    }

    async function load() {
        const saved = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: TRACKS_KEY, fallback: null });
        tracks.set(sanitizeTracks(saved.ok ? saved.value : []));
        await migrateVectorsIfNeeded();
        const player = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: PLAYER_KEY, fallback: null });
        if (player.ok && player.value) {
            autoSwitch.set(player.value.autoSwitch !== false);
            contextMessages.set(Number.isFinite(player.value.contextMessages) ? player.value.contextMessages : DEFAULTS.contextMessages);
            minSimilarity.set(Number.isFinite(player.value.minSimilarity) ? player.value.minSimilarity : DEFAULTS.minSimilarity);
            switchMargin.set(Number.isFinite(player.value.switchMargin) ? player.value.switchMargin : DEFAULTS.switchMargin);
            volume.set(Number.isFinite(player.value.volume) ? player.value.volume : DEFAULTS.volume);
            muted.set(Boolean(player.value.muted));
            autoTag.set(player.value.autoTag !== false);
            smart.set(player.value.smart !== false);
            server.mode.set(player.value.serverSelection === 'local' ? 'local' : 'server');
            server.selected.set(typeof player.value.section === 'string' ? player.value.section : '');
            hudCollapsed.set(Boolean(player.value.player?.collapsed));
            hudVisible.set(player.value.player?.visible !== false);
            // Позицию, сохранённую при другом размере окна (или экрана), возвращаем в пределы экрана: окно у края, ставшее шире, иначе оказалось бы обрезанным.
            const savedPosition = player.value.player?.position ?? {};
            hudPosition.set(Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.top)
                ? clampToViewport(savedPosition, { ...WINDOW_SIZE, viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080 })
                : savedPosition);
        }
        void loadServer().catch(() => {});   // разделы сервера подтягиваются фоном: сбой не мешает запуску
    }

    /** Подтянуть разделы сервера и треки выбранного. Вызывается при старте и по кнопке; без сервера или сети тихо ничего не делает. */
    const loadServer = () => server.refresh();

    /** Пользователь выбрал раздел: запомнить и загрузить его треки. */
    async function chooseSection(id) {
        await server.select(id);
        await savePlayer();
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
        loadServer,
        chooseSection,
        server,
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
        importLinkText,
        tagTracks,
        autoTag,
        smart,
        updateDescription,
        removeTrack,
        saveSettings,
        /** Что гиду разрешено менять (libraries/core/guide-settings.js): те же слайдеры и переключатели, что в карточке, с теми же границами. */
        guideSettings: () => ({
            specs: [
                booleanSetting('autoSwitch', 'Auto-switch with the scene', autoSwitch),
                numberSetting('contextMessages', 'Scene depth (last messages)', contextMessages, { min: 1, max: 12, step: 1 }),
                numberSetting('minSimilarity', 'Min similarity', minSimilarity, { min: 0, max: 1, step: 0.05 }),
                numberSetting('switchMargin', 'Switch margin', switchMargin, { min: 0, max: 0.5, step: 0.01 }),
                booleanSetting('autoTag', 'Describe new tracks with the model', autoTag),
                booleanSetting('smart', 'Smart scene detection (Jev)', smart),
            ],
            save: saveSettings,
        }),
        stop: () => {
            stopPolling();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            void request(host.services, 'audio.playback.pause', {});
        },
    };
}
