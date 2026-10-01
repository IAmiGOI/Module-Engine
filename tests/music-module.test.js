import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../libraries/shared/engine.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { createSettingsCore } from '../cores/settings/index.js';
import {
    createMusicModule, sanitizeTracks, buildSceneText, MODULE_ID,
} from '../modules/music/index.js';
import { selectTrack, shouldSwitch } from '../libraries/core/track-selection.js';

// --- Чистые функции ---------------------------------------------------------

test('sanitizeTracks() keeps only the real fields (source, artist and tag kind included) and repairs garbage defaults', () => {
    const cleaned = sanitizeTracks([
        { id: 'a', name: 'A', description: 'd', vector: [1, 2], playCount: 3 },
        { name: 'no id' },
        null,
        'junk',
    ]);
    const local = { kind: 'local', ref: null };
    assert.deepEqual(cleaned, [
        { id: 'a', name: 'A', description: 'd', vector: [1, 2], playCount: 3, source: local, artist: '', tagged: 'name' },
        { id: 'track_1', name: 'no id', description: '', vector: null, playCount: 0, source: local, artist: '', tagged: 'name' },
    ]);
    assert.deepEqual(sanitizeTracks('junk'), []);
});

test('buildSceneText() takes the last N non-system messages and joins their text', () => {
    const messages = [
        { text: 'old', isSystem: false },
        { text: 'sys', isSystem: true },
        { text: 'mid', isSystem: false },
        { text: 'new', isSystem: false },
    ];
    assert.equal(buildSceneText(messages, 2), 'mid\nnew');
    assert.equal(buildSceneText([], 4), '');
    assert.equal(buildSceneText('junk', 4), '');
});

// --- Сценарный уровень: настоящий движок, настоящие Гейты; фейк — только аудио и indexedDB-сервис

const AXES = { fight: 0, calm: 1, sea: 2, city: 3 };
const vec = (...names) => {
    const v = [0, 0, 0, 0];
    for (const name of names) v[AXES[name]] += 1;
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    return v.map(x => x / norm);
};

function buildEngine({ chat = [], model = null, serverTracks = null } = {}) {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    // Сервис аудио — Map вместо IndexedDB: тот же контракт, иначе среда.
    const blobs = new Map();
    engine.buses.services.register('audio.put', ({ id, blob }) => { blobs.set(String(id), blob); return true; });
    engine.buses.services.register('audio.get', ({ id }) => blobs.get(String(id)) ?? null);
    engine.buses.services.register('audio.delete', ({ id }) => blobs.delete(String(id)) || true);

    // Сервис воспроизведения — фейк над тем же контрактом (реальный владеет
    // <audio> и URL.createObjectURL, недоступными в Node).
    const playback = { id: null, playing: false, playCalls: 0, onEnded: null, volume: 0.7, time: 0, duration: 0, seekedTo: null, lastSource: null, failWith: null };
    engine.buses.services.register('audio.playback.play', ({ id, blob, source, onEnded }) => {
        playback.lastSource = source ?? null;
        if (playback.failWith) return typeof playback.failWith === 'object' ? { ok: false, ...playback.failWith } : { ok: false, error: playback.failWith };
        if (!blob && !source) return { ok: false };
        playback.id = id ?? null;
        playback.playing = true;
        playback.playCalls += 1;
        playback.onEnded = typeof onEnded === 'function' ? onEnded : null;
        return { ok: true, started: true };
    });
    engine.buses.services.register('audio.playback.pause', () => { playback.playing = false; return { ok: true }; });
    engine.buses.services.register('audio.playback.volume', ({ value }) => { if (Number.isFinite(value)) playback.volume = value; return { ok: true }; });
    // ВАЖНО: шина сама оборачивает ответ в {ok, value} — фейк возвращает голый снимок, как реальный Сервис (см. audio-playback.js).
    engine.buses.services.register('audio.playback.state', () => ({ id: playback.id, playing: playback.playing, currentTime: playback.time, duration: playback.duration }));
    engine.buses.services.register('audio.playback.seek', ({ time }) => { playback.seekedTo = time; playback.time = time; return { ok: true }; });

    // Текстовая модель пользователя — фейк над `model.generate`; без него вызов отказывает, как без подключённой модели.
    const modelCalls = [];
    if (model) engine.buses.cores.register('model.generate', params => { modelCalls.push(params); return model(params); });

    // Эмбединг-фейк: вектор — СУММА осей, чьи имена встретились в тексте
    // (нормированная). Детерминированно, «ничего не встретилось» — фон города.
    engine.buses.services.register('embedding.compute', ({ text }) => {
        const lower = String(text).toLowerCase();
        const hits = Object.keys(AXES).filter(name => lower.includes(name));
        return vec(...(hits.length ? hits : ['city']));
    });

    // chatHistory.messages — фейк над тем же контрактом (реальный живёт на stChat/DOM).
    engine.buses.cores.register('chatHistory.messages', params => {
        const limit = Math.max(0, params?.limit ?? 10);
        return chat.slice(-limit).map((text, index, array) => ({
            mesid: String(chat.length - array.length + index),
            isUser: false, isSystem: false, name: '', text,
        }));
    });

    // Ядро музыкального сервера — фейк над теми же контрактами (реальное ходит в сеть). `serverTracks` — треки единственного раздела «fantasy»; без него сервера нет.
    if (serverTracks) {
        engine.buses.cores.register('musicServer.sections', () => ({ configured: true, ok: true, sections: [{ id: 'fantasy', name: 'Fantasy', tracks: serverTracks.length }] }));
        engine.buses.cores.register('musicServer.section', ({ id }) => (id === 'fantasy'
            ? { ok: true, name: 'Fantasy', tracks: serverTracks }
            : { ok: false, reason: 'no such section', tracks: [] }));
    }

    const notifications = [];
    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'ui.notify',
            'chatHistory.messages', 'audio.put', 'audio.get', 'audio.delete',
            'audio.playback.play', 'audio.playback.pause', 'audio.playback.state', 'audio.playback.volume', 'audio.playback.seek', 'model.generate',
            'embedding.compute', 'musicServer.sections', 'musicServer.section',
        ],
    });
    const rawNotify = moduleHost.cores.subscribe.bind(moduleHost.cores);
    moduleHost.cores.subscribe = (contract, options, callback) => {
        if (contract === 'ui.notify') notifications.push(options.params);
        return rawNotify(contract, options, callback);
    };

    const module = createMusicModule(moduleHost);

    return { engine, module, audio: playback, blobs, notifications, moduleHost, settingsContext, modelCalls };
}

test('load() restores tracks from settings; import computes vectors and persists both bytes and metadata', async () => {
    const { module, blobs } = buildEngine();
    await module.load();
    assert.deepEqual(module.tracks.peek(), []);

    await module.importFiles([{ name: 'tense urban fight at night.mp3', blob: new Blob(['audio-bytes']) }]);

    assert.equal(blobs.size, 1);
    const imported = module.tracks.peek()[0];
    assert.equal(imported.name, 'tense urban fight at night');
    assert.deepEqual(imported.vector, vec('fight'), 'vector computed immediately from the default description');
    assert.equal(imported.playCount, 0);
});

test('generation.completed picks the track whose description matches the fresh scene — with no LLM call anywhere', async () => {
    const chat = ['The heroes storm the docks at dawn.', 'Blades clash in the rain — a brutal fight erupts.'];
    const { module, audio } = buildEngine({ chat });
    await module.load();
    await module.importFiles([{ name: 'tense urban fight at night.mp3', blob: new Blob(['a']) }]); // файл назван по сцене боя

    await module.onGenerationCompleted();

    assert.equal(audio.playing, true);
    assert.equal(module.nowPlaying.peek().trackId, module.tracks.peek()[0].id);
    assert.ok(module.nowPlaying.peek().similarity > 0.99);
});

test('a track with no matching theme stays below the floor — music is NOT changed', async () => {
    const chat = ['A quiet afternoon tending the garden.'];
    const { module, audio } = buildEngine({ chat });
    await module.load();
    // Импорт честный (создаёт blob в Сервисе аудио); "sea shanty" → вектор sea.
    await module.importFiles([{ name: 'sea shanty.mp3', blob: new Blob(['a']) }]);
    await module.skip(); // вручную выбрали: skip играет лучший даже слабый
    const before = module.nowPlaying.peek().trackId;

    await module.onGenerationCompleted(); // сцена "garden" → фейк даёт city; sea vs city — косинус 0, ниже порога 0.55

    assert.equal(module.nowPlaying.peek().trackId, before, 'weak match must not jerk the music');
    assert.equal(audio.playing, true);
});

test('candidate barely better than the playing track does not switch (hysteresis); clearly better does', async () => {
    const { module, audio } = buildEngine({ chat: ['city street noise'] });
    await module.load();
    await module.importFiles([{ name: 'now.mp3', blob: new Blob(['a']) }, { name: 'cand.mp3', blob: new Blob(['b']) }]);
    // Вектора задаём явно: играющий city (косинус 1.0 к сцене city),
    // кандидат city+sea (~0.707) — ХУЖЕ играющего, гистерезис не пустит.
    module.tracks.set([
        { ...module.tracks.peek()[0], vector: vec('city'), playCount: 0 },
        { ...module.tracks.peek()[1], vector: vec('city', 'sea'), playCount: 0 },
    ]);
    await module.playTrack(module.tracks.peek()[0]);
    await module.onGenerationCompleted();
    assert.equal(module.nowPlaying.peek().trackId, module.tracks.peek()[0].id);

    // Граница гистерезиса — численный контракт Библиотеки, закрепляем и здесь.
    assert.equal(shouldSwitch({ currentSimilarity: 0.7, candidateSimilarity: 0.74 }), false);
    assert.equal(shouldSwitch({ currentSimilarity: 0.7, candidateSimilarity: 0.76 }), true);
});

test('playCount increments only when the track actually starts (not on a blocked play)', async () => {
    const { module } = buildEngine({ chat: ['fight'] });
    await module.load();
    await module.importFiles([{ name: 'fight track.mp3', blob: new Blob(['a']) }]);
    const id = module.tracks.peek()[0].id;

    await module.skip();
    assert.equal(module.tracks.peek().find(item => item.id === id).playCount, 1);
    // Повтор того же трека не перекачивает и не инкрементит второй раз
    await module.skip();
    assert.equal(module.tracks.peek().find(item => item.id === id).playCount, 1);
});

test('removeTrack() drops both the bytes and the metadata, and stops it if it was playing', async () => {
    const { module, audio, blobs } = buildEngine({ chat: ['fight'] });
    await module.load();
    await module.importFiles([{ name: 'fight track.mp3', blob: new Blob(['a']) }]);
    const id = module.tracks.peek()[0].id;
    await module.skip();
    assert.equal(audio.playing, true);

    await module.removeTrack(id);

    assert.equal(blobs.has(id), false);
    assert.deepEqual(module.tracks.peek(), []);
    assert.equal(module.nowPlaying.peek().trackId, null);
});

test('updateDescription() recomputes the vector immediately — selection must not live on a stale description', async () => {
    const { module } = buildEngine({ chat: ['calm morning'] });
    await module.load();
    await module.importFiles([{ name: 'fight track.mp3', blob: new Blob(['a']) }]);
    const id = module.tracks.peek()[0].id;
    assert.deepEqual(module.tracks.peek()[0].vector, vec('fight'));

    await module.updateDescription(id, 'calm sea morning');

    const updated = module.tracks.peek().find(item => item.id === id);
    assert.equal(updated.description, 'calm sea morning');
    assert.deepEqual(updated.vector, vec('calm', 'sea'));
});

test('embedding.compute unavailable — module degrades softly: no throw, notify only on real actions', async () => {
    const engine = createEngine();
    const settingsContext = { extensionSettings: {}, chatMetadata: {}, saveSettingsDebounced: () => {}, saveMetadataDebounced: () => {} };
    registerExtensionSettingsService(engine.buses.services, { getContext: () => settingsContext });
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));
    engine.buses.services.register('audio.put', () => true);
    engine.buses.services.register('audio.get', () => null);
    engine.buses.services.register('audio.delete', () => true);
    // embedding.compute НЕ зарегистрирован вовсе
    engine.buses.cores.register('chatHistory.messages', () => []);
    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: ['storage.settings.get', 'storage.settings.set', 'ui.notify', 'chatHistory.messages', 'audio.put', 'audio.get', 'audio.delete', 'embedding.compute'],
    });
    const module = createMusicModule(moduleHost);
    await module.load();
    await module.importFiles([{ name: 'fight track.mp3', blob: new Blob(['a']) }]);
    const imported = module.tracks.peek()[0];
    assert.equal(imported.vector, null, 'import survives without embedding — vector waits');

    await module.onGenerationCompleted(); // не бросает, ничего не играет
    assert.equal(module.nowPlaying.peek().trackId, null);
});

test('the position is polled while a track plays and NOT after it is paused; seek goes to the Service and moves the bar at once', async () => {
    const chat = ['Blades clash in the rain — a brutal fight erupts.'];
    const { module, audio } = buildEngine({ chat });
    await module.load();
    await module.importFiles([{ name: 'tense urban fight at night.mp3', blob: new Blob(['a']) }]);
    audio.time = 42;
    audio.duration = 180;
    await module.onGenerationCompleted();
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.deepEqual(module.progress.peek(), { time: 42, duration: 180 }, 'the poll took the position and the length from the Service');

    module.seek(90);
    assert.equal(audio.seekedTo, 90);
    assert.equal(module.progress.peek().time, 90, 'the bar does not wait for the next poll');

    module.pause();
    await new Promise(resolve => setTimeout(resolve, 650));   // последний опрос увидит паузу и остановит таймер
    audio.time = 150;
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(module.progress.peek().time, 90, 'no polling on pause: the position stays where it was');
    module.stop();
});

test('mute silences the Service without touching the remembered volume, and unmute brings it back', async () => {
    const { module, audio } = buildEngine();
    await module.load();
    module.volume.set(0.4);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(audio.volume, 0.4);
    module.toggleMute();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(audio.volume, 0);
    assert.equal(module.volume.peek(), 0.4, 'the level itself is kept');
    module.toggleMute();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(audio.volume, 0.4);
});

test('a window size saved by the old resizable player is ignored: the window keeps its own fixed size instead of being cut to the old one', async () => {
    const { module, moduleHost, settingsContext } = buildEngine();
    await module.load();
    module.setHudVisible(true);                                  // пишет состояние окна в настройки
    await new Promise(resolve => setTimeout(resolve, 20));
    // Кладём «старый» размер туда же, где его хранил прежний плеер (player.size), и поднимаем свежий экземпляр.
    const namespaces = Object.values(settingsContext.extensionSettings).filter(value => value && typeof value === 'object');
    let injected = false;
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.player && typeof node.player === 'object' && 'collapsed' in node.player) { node.player.size = { width: 200, height: 80 }; node.player.position = { left: 1900, top: 1000 }; injected = true; }
        Object.values(node).forEach(visit);
    };
    namespaces.forEach(visit);
    assert.ok(injected, 'the saved player state was found and given an old size');
    const fresh = createMusicModule(moduleHost);
    await fresh.load();
    const panel = fresh.hud().children[0]();                     // корень hud() — обёртка; её ребёнок — окно
    const style = panel.props.style();
    assert.equal(style.width, undefined, 'no inline width from the old size');
    assert.equal(style.height, undefined, 'no inline height from the old size');
    assert.equal(panel.props.class, 'stme-floating-panel stme-music-window');
    assert.equal(style.left, '1584px', 'a position saved near the right edge is pulled back so the wider window is not cut off (1920 − 336)');
    assert.equal(style.top, '780px', '1080 − 300');
    fresh.stop();
});


// --- Разметка моделью и прямые ссылки ---

/** Файлы для импорта: имена без ключевых слов сцены — смысл появляется только из описания модели. */
const files = (count, prefix = 'Piece') => Array.from({ length: count }, (_, index) => ({ name: `${prefix} ${String(index + 1).padStart(2, '0')}.mp3`, blob: new Blob(['a']) }));

test('tracks are described BY THE MODEL and then chosen by the meaning of the scene — the file names contain no keyword at all', async () => {
    const model = () => JSON.stringify([{ n: 1, d: 'Relentless drums and brass for a brutal fight in the rain.' }, { n: 2, d: 'Slow waves and gulls for a quiet evening by the sea.' }]);
    const { module, audio, modelCalls } = buildEngine({ chat: ['Blades clash in the rain — a brutal fight erupts.'], model });
    await module.load();
    await module.importFiles(files(2));

    const [first, second] = module.tracks.peek();
    assert.deepEqual([first.tagged, second.tagged], ['model', 'model']);
    assert.match(first.description, /^Piece 01\. Relentless drums/, 'the name and the model text are embedded together');
    assert.deepEqual(first.vector, vec('fight'), 'the vector comes from the model description, not from the file name');
    assert.deepEqual(second.vector, vec('sea'));
    assert.equal(modelCalls.length, 1, 'both tracks went in one batch');
    assert.match(modelCalls[0].prompt, /1\. Piece 01\n2\. Piece 02/);

    await module.onGenerationCompleted();
    assert.equal(module.nowPlaying.peek().trackId, first.id, 'the fight scene picks the fight track by meaning');
    assert.equal(audio.playing, true);
});

test('with no model connected the tracks stay described by name, and the user is told once how to fix it', async () => {
    const { module, notifications } = buildEngine();
    await module.load();
    await module.importFiles(files(3));
    assert.deepEqual(module.tracks.peek().map(track => track.tagged), ['name', 'name', 'name']);
    const errors = notifications.filter(entry => entry.tone === 'error');
    assert.equal(errors.length, 1, 'one message, not one per track');
    assert.match(errors[0].text, /Describe with the model/);
});

test('a big import goes to the model in batches of ten; a cut-off reply tags only what was described', async () => {
    let call = 0;
    const model = ({ prompt }) => {
        call += 1;
        const count = (prompt.match(/^\d+\./gm) ?? []).length;
        if (call === 2) return '[{"n":1,"d":"Calm piano for a quiet night of thinking."},{"n":2,"d":"Cut off mid'; // обрыв: только первая запись целая
        return JSON.stringify(Array.from({ length: count }, (_, index) => ({ n: index + 1, d: 'Gentle strings for a peaceful walk in the calm.' })));
    };
    const { module, modelCalls, notifications } = buildEngine({ model });
    await module.load();
    await module.importFiles(files(23));
    assert.equal(modelCalls.length, 3, '23 tracks → 10 + 10 + 3');
    const tags = module.tracks.peek().map(track => track.tagged);
    assert.equal(tags.filter(tag => tag === 'model').length, 10 + 1 + 3, 'the cut-off batch gave one description');
    assert.equal(tags.filter(tag => tag === 'name').length, 9);
    assert.ok(notifications.some(entry => entry.tone === 'warn' && /14 of 23/.test(entry.text)));
});

test('a track edited by hand is never overwritten by the model, even on "Describe with the model"', async () => {
    const model = () => JSON.stringify([{ n: 1, d: 'Model text that must not replace the human one.' }, { n: 2, d: 'Second model description for another track.' }]);
    const { module } = buildEngine({ model });
    await module.load();
    await module.importFiles(files(2));
    const [first] = module.tracks.peek();
    await module.updateDescription(first.id, 'my own words about the sea');
    assert.equal(module.tracks.peek()[0].tagged, 'manual');
    const result = await module.tagTracks(module.tracks.peek().map(track => track.id), { force: true });
    assert.equal(result.total, 1, 'only the untouched track was sent');
    assert.equal(module.tracks.peek()[0].description, 'my own words about the sea');
});

test('a direct audio link becomes a track that plays from its address; anything else is refused with a clear message', async () => {
    const { module, audio, notifications } = buildEngine({ chat: ['A quiet afternoon by the sea.'] });
    await module.load();
    assert.equal(await module.importLinkText('https://example.com/radio/sea%20shanty.mp3'), true);
    const track = module.tracks.peek()[0];
    assert.deepEqual([track.name, track.source], ['sea shanty', { kind: 'url', ref: 'https://example.com/radio/sea%20shanty.mp3' }]);
    assert.deepEqual(track.vector, vec('sea'));
    assert.equal(await module.importLinkText('https://example.com/radio/sea%20shanty.mp3'), true, 'the same link twice adds nothing');
    assert.equal(module.tracks.peek().length, 1);
    await module.playTrack(track);
    assert.deepEqual(audio.lastSource, { kind: 'url', ref: 'https://example.com/radio/sea%20shanty.mp3' }, 'the service is asked for the address, no file bytes');
    assert.equal(module.nowPlaying.peek().playing, true);
    assert.equal(await module.importLinkText('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
    assert.ok(notifications.some(entry => entry.tone === 'error' && /not a direct audio link/.test(entry.text)));
});

test('tracks saved by the earlier YouTube build are dropped on load: they cannot play any more', () => {
    const cleaned = sanitizeTracks([
        { id: 'yt_x', name: 'Old', source: { kind: 'youtube', ref: 'dQw4w9WgXcQ' } },
        { id: 'a', name: 'Kept', source: { kind: 'url', ref: 'https://a.b/c.mp3' } },
        { id: 'b', name: 'Local' },
    ]);
    assert.deepEqual(cleaned.map(track => track.id), ['a', 'b']);
});

// --- Раздел сервера владельца ---------------------------------------------------

const serverTrack = (id, v) => ({
    id: `srv_fantasy_${id}`, name: '', description: '', vector: v, playCount: 0, source: { kind: 'url', ref: `https://music.example/audio/${id}.mp3` },
    artist: '', tagged: 'manual', server: true,
});

test('a chosen server section plays by the scene — its tracks are never listed, saved, or named for the user', async () => {
    const chat = ['Blades clash in the rain — a brutal fight erupts.'];
    const { module, audio, settingsContext } = buildEngine({ chat, serverTracks: [serverTrack('a1', vec('sea')), serverTrack('b2', vec('fight'))] });
    await module.load();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(module.server.sections.peek().map(item => item.id), ['fantasy'], 'sections arrive in the background');

    await module.chooseSection('fantasy');
    assert.equal(module.tracks.peek().length, 0, 'the section is not mixed into the own library');
    await module.onGenerationCompleted();

    assert.equal(audio.playing, true);
    assert.equal(audio.lastSource.ref, 'https://music.example/audio/b2.mp3', 'the fight track fits the fight scene and plays from its address');
    assert.equal(module.nowPlaying.peek().name, 'Fantasy', 'the user sees the section, not a track name');
    const stored = JSON.stringify(settingsContext.extensionSettings);
    assert.equal(stored.includes('srv_fantasy'), false, 'server tracks are not persisted');
    assert.equal(stored.includes('"section":"fantasy"'), true, 'the chosen section is remembered');
});

test('the chosen section is restored after a reload; a section the server no longer has is forgotten', async () => {
    const first = buildEngine({ serverTracks: [serverTrack('a1', vec('fight'))] });
    await first.module.load();
    await first.module.chooseSection('fantasy');
    await first.module.saveSettings();

    const second = buildEngine({ serverTracks: [serverTrack('a1', vec('fight'))] });
    Object.assign(second.settingsContext.extensionSettings, first.settingsContext.extensionSettings);
    await second.module.load();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.module.server.selected.peek(), 'fantasy');
    assert.equal(second.module.server.tracks.peek().length, 1);

    const third = buildEngine();
    Object.assign(third.settingsContext.extensionSettings, first.settingsContext.extensionSettings);
    third.engine.buses.cores.register('musicServer.sections', () => ({ configured: true, ok: true, sections: [{ id: 'other', name: 'Other', tracks: 1 }] }));
    await third.module.load();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(third.module.server.selected.peek(), '', 'a vanished section is dropped, not left selected');
});

test('with no server at all nothing changes: no sections, user tracks play as before', async () => {
    const { module } = buildEngine();
    await module.load();
    assert.equal(module.server.configured.peek(), false);
    assert.deepEqual(module.server.sections.peek(), []);
});
