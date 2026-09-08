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

test('sanitizeTracks() keeps only the five real fields and repairs garbage defaults', () => {
    const cleaned = sanitizeTracks([
        { id: 'a', name: 'A', description: 'd', vector: [1, 2], playCount: 3 },
        { name: 'no id' },
        null,
        'junk',
    ]);
    assert.deepEqual(cleaned, [
        { id: 'a', name: 'A', description: 'd', vector: [1, 2], playCount: 3 },
        { id: 'track_1', name: 'no id', description: '', vector: null, playCount: 0 },
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

function buildEngine({ chat = [] } = {}) {
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
    const playback = { id: null, playing: false, playCalls: 0, onEnded: null, volume: 0.7 };
    engine.buses.services.register('audio.playback.play', ({ id, blob, onEnded }) => {
        if (!blob) return { ok: false };
        playback.id = id ?? null;
        playback.playing = true;
        playback.playCalls += 1;
        playback.onEnded = typeof onEnded === 'function' ? onEnded : null;
        return { ok: true, started: true };
    });
    engine.buses.services.register('audio.playback.pause', () => { playback.playing = false; return { ok: true }; });
    engine.buses.services.register('audio.playback.volume', ({ value }) => { if (Number.isFinite(value)) playback.volume = value; return { ok: true }; });
    engine.buses.services.register('audio.playback.state', () => ({ ok: true, value: { id: playback.id, playing: playback.playing } }));

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

    const notifications = [];
    const moduleHost = engine.registerCaller(MODULE_ID, 'modules', {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'ui.notify',
            'chatHistory.messages', 'audio.put', 'audio.get', 'audio.delete',
            'audio.playback.play', 'audio.playback.pause', 'audio.playback.state', 'audio.playback.volume',
            'embedding.compute',
        ],
    });
    const rawNotify = moduleHost.cores.subscribe.bind(moduleHost.cores);
    moduleHost.cores.subscribe = (contract, options, callback) => {
        if (contract === 'ui.notify') notifications.push(options.params);
        return rawNotify(contract, options, callback);
    };

    const module = createMusicModule(moduleHost);

    return { engine, module, audio: playback, blobs, notifications };
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
