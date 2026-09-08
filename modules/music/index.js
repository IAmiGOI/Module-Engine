import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { selectTrack, shouldSwitch } from '../../libraries/core/track-selection.js';
import { clampToViewport, createDragHandlers } from '../../libraries/shared/draggable.js';
import { Button, TextInput, TextArea, Slider, Toggle, Field, Row, EmptyState, FloatingPanel } from '../../libraries/shared/widgets.js';

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

    const nowPlaying = signal({ trackId: null, name: null, playing: false, blocked: false, similarity: null });
    const busy = signal(false); // идёт пересчёт вектора сцены — защита от повторного входа
    const hudCollapsed = signal(false);
    const hudVisible = signal(true);
    const hudPosition = signal({});
    const hudSize = signal({});

    let audio = null;        // HTMLAudioElement — подключается хостом через сервис dom-точки (см. host.provideAudio в тестах)
    let currentUrl = null;
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
                volume: volume.peek(), autoSwitch: autoSwitch.peek(), contextMessages: contextMessages.peek(),
                minSimilarity: minSimilarity.peek(), switchMargin: switchMargin.peek(), player: {
                    collapsed: hudCollapsed.peek(), visible: hudVisible.peek(), position: hudPosition.peek(), size: hudSize.peek(),
                },
            },
        });
    }

    /** Звук отдаётся хостом-окружением (реальный ST — через `host.provideAudio()` при mount), тесты — фейком. Так Модуль не трогает ни DOM, ни `new Audio()` сам. */
    function ensureAudio() {
        if (audio || !host.provideAudio) return;
        audio = host.provideAudio();
        audio.addEventListener?.('ended', () => {
            if (!userPaused) replayCurrent();
        });
        audio.volume = volume.peek();
    }

    function setNowPlaying(patch) {
        nowPlaying.set({ ...nowPlaying.peek(), ...patch });
    }

    async function playTrack(track, similarity = null) {
        ensureAudio();
        if (!audio) return;
        if (currentTrackId !== track.id) {
            const blobResult = await request(host.services, 'audio.get', { params: { id: track.id } });
            if (!blobResult.ok || !blobResult.value) {
                await notify('error', `Audio for "${track.name}" is missing from this browser's storage — re-import it.`);
                return;
            }
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            currentUrl = URL.createObjectURL(blobResult.value);
            audio.src = currentUrl;
            currentTrackId = track.id;
            currentSimilarity = similarity;
            const next = tracks.peek().map(item => (item.id === track.id ? { ...item, playCount: (item.playCount ?? 0) + 1 } : item));
            tracks.set(next);
            await saveTracks();
        }
        userPaused = false;
        try {
            await audio.play();
            setNowPlaying({ trackId: track.id, name: track.name, playing: true, blocked: false, similarity });
        } catch {
            // autoplay-политика браузера: нужен жест пользователя — кнопка ▶
            setNowPlaying({ trackId: track.id, name: track.name, playing: false, blocked: true, similarity });
        }
    }

    function pause() {
        userPaused = true;
        audio?.pause();
        setNowPlaying({ playing: false, blocked: false });
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
        const state = computed(() => nowPlaying());
        const label = computed(() => {
            const current = state();
            if (!current.trackId) return 'Nothing selected — press Skip or play manually.';
            if (current.blocked) return `${current.name} — press ▶ (browser blocked autoplay)`;
            return current.playing ? `Playing: ${current.name}` : `Paused: ${current.name}`;
        });
        return FloatingPanel('Music', {
            position: hudPosition,
            size: hudSize,
            collapsed: hudCollapsed,
            onToggle: value => { hudCollapsed.set(value); savePlayer(); },
            onClose: () => { hudVisible.set(false); savePlayer(); },
            drag: createDragHandlers(hudPosition, {
                onDrop: dropped => {
                    hudPosition.set(clampToViewport(dropped, {
                        width: hudSize.peek().width ?? 240,
                        height: hudSize.peek().height ?? 120,
                        viewportWidth: globalThis.innerWidth ?? 1920,
                        viewportHeight: globalThis.innerHeight ?? 1080,
                    }));
                    savePlayer();
                },
            }),
            onResize: next => {
                if (next.width === hudSize.peek().width && next.height === hudSize.peek().height) return;
                hudSize.set(next);
                savePlayer();
            },
        },
            h('div', { class: 'stme-music-now' }, label),
            Row(
                Button(computed(() => (state().playing ? '⏸' : '▶')), () => {
                    if (state().playing) { pause(); return; }
                    const track = tracks.peek().find(item => item.id === state().trackId);
                    if (track) playTrack(track, state().similarity);
                    else skip();
                }),
                Button('⏭', skip),
            ),
            Slider('Volume', volume, { min: 0, max: 1, step: 0.05 }),
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
        input.addEventListener('change', () => { updateDescription(track.id, draft.peek()); });
        return h('div', { class: 'stme-music-track' },
            Row(
                h('strong', {}, track.name),
                h('small', { class: 'stme-music-plays' }, `${track.playCount ?? 0} plays`),
                Button('×', () => { removeTrack(track.id); }, { variant: 'danger' }),
            ),
            Field('Mood description', input, { hint: track.vector ? 'Vector computed.' : 'Vector will be computed when embedding is available.' }),
        );
    }

    let fileInput = null;
    function tree() {
        fileInput = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
        fileInput.addEventListener('change', () => { importFiles(fileInput.files); fileInput.value = ''; });
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
            Row(Button('Import audio files…', () => fileInput?.click()), fileInput),
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
            hudCollapsed.set(Boolean(player.value.player?.collapsed));
            hudVisible.set(player.value.player?.visible !== false);
            hudPosition.set(player.value.player?.position ?? {});
            hudSize.set(player.value.player?.size ?? {});
        }
        audio?.setAttribute?.('volume-hint', String(volume.peek()));
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
        busy,
        volume,
        hudVisible,
        // Тестам и хосту: подсунуть настоящий/фейковый audio-элемент и играть вручную.
        attachAudio: element => { audio = element; audio.volume = volume.peek(); },
        playTrack,
        pause,
        skip,
        onGenerationCompleted,
        importFiles,
        updateDescription,
        removeTrack,
        saveSettings,
        stop: () => {
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
            audio?.pause?.();
            if (currentUrl) URL.revokeObjectURL(currentUrl);
        },
    };
}
