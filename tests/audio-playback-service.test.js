import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAudioPlaybackService } from '../services/audio-playback.js';

/** Минимальная шина: контракт → обработчик. */
function makeBus() {
    const handlers = new Map();
    return { register: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }, call: (name, params) => handlers.get(name)(params) };
}

/** Фейковый <audio>: ровно то, чем пользуется Сервис. */
function makeAudio() {
    const listeners = {};
    const el = {
        paused: true, ended: false, currentTime: 0, duration: NaN, volume: 1, src: '',
        addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
        play: async () => { el.paused = false; },
        pause: () => { el.paused = true; },
        emit: type => (listeners[type] ?? []).forEach(fn => fn()),
    };
    return el;
}

const blob = () => new Blob(['x']);

test('the state snapshot carries the position and the duration; an unknown duration (stream, not loaded yet) is reported as 0', async () => {
    const bus = makeBus();
    const audio = makeAudio();
    registerAudioPlaybackService(bus, { createAudio: () => audio });
    assert.deepEqual(await bus.call('audio.playback.state'), { id: null, playing: false, currentTime: 0, duration: 0 });
    await bus.call('audio.playback.play', { id: 't1', blob: blob() });
    audio.currentTime = 12.5;
    audio.duration = Infinity;
    assert.equal((await bus.call('audio.playback.state')).duration, 0, 'Infinity is not a duration');
    audio.duration = 200;
    assert.deepEqual(await bus.call('audio.playback.state'), { id: 't1', playing: true, currentTime: 12.5, duration: 200 });
});

test('seek moves the position within the duration and refuses when there is nothing to seek in', async () => {
    const bus = makeBus();
    const audio = makeAudio();
    registerAudioPlaybackService(bus, { createAudio: () => audio });
    assert.deepEqual(await bus.call('audio.playback.seek', { time: 5 }), { ok: false }, 'no element yet');
    await bus.call('audio.playback.play', { id: 't1', blob: blob() });
    audio.duration = 100;
    await bus.call('audio.playback.seek', { time: 40 });
    assert.equal(audio.currentTime, 40);
    await bus.call('audio.playback.seek', { time: 999 });
    assert.equal(audio.currentTime, 100, 'clamped to the duration');
    await bus.call('audio.playback.seek', { time: -3 });
    assert.equal(audio.currentTime, 0, 'clamped to the start');
    assert.deepEqual(await bus.call('audio.playback.seek', { time: 'soon' }), { ok: false });
});

test('a volume set before the first track is remembered and applied when the element appears (it used to throw on the missing element)', async () => {
    const bus = makeBus();
    const audio = makeAudio();
    registerAudioPlaybackService(bus, { createAudio: () => audio });
    assert.deepEqual(await bus.call('audio.playback.volume', { value: 0.3 }), { ok: true });
    await bus.call('audio.playback.play', { id: 't1', blob: blob() });
    assert.equal(audio.volume, 0.3);
    await bus.call('audio.playback.volume', { value: 2 });
    assert.equal(audio.volume, 1, 'clamped to 1');
});

test('the ended callback of the LATEST play() is the one that fires, also on an element that already existed', async () => {
    const bus = makeBus();
    const audio = makeAudio();
    registerAudioPlaybackService(bus, { createAudio: () => audio });
    const calls = [];
    await bus.call('audio.playback.play', { id: 't1', blob: blob(), onEnded: () => calls.push('first') });
    await bus.call('audio.playback.play', { id: 't2', blob: blob(), onEnded: () => calls.push('second') });
    audio.emit('ended');
    assert.deepEqual(calls, ['second']);
});

test('a direct link plays through the same element without an object URL; a link without an address is refused; the state follows the element', async () => {
    const bus = makeBus();
    const audio = makeAudio();
    registerAudioPlaybackService(bus, { createAudio: () => audio });
    assert.deepEqual(await bus.call('audio.playback.play', { id: 'u1', source: { kind: 'url' } }), { ok: false }, 'no address');
    assert.deepEqual(await bus.call('audio.playback.play', { id: 'u1', source: { kind: 'url', ref: 'https://example.com/a.mp3' }, volume: 0.5 }), { ok: true, started: true });
    assert.equal(audio.src, 'https://example.com/a.mp3');
    assert.equal(audio.volume, 0.5);
    audio.currentTime = 7; audio.duration = 90;
    assert.deepEqual(await bus.call('audio.playback.state'), { id: 'u1', playing: true, currentTime: 7, duration: 90 });
    await bus.call('audio.playback.play', { id: 'u1', source: { kind: 'url', ref: 'https://example.com/other.mp3' } });
    assert.equal(audio.src, 'https://example.com/a.mp3', 'the same track id is not reloaded');
});

test('crossfade: a track switched on the fly fades in while the old one fades out, then the old one stops; without crossfade nothing changes', async () => {
    const bus = makeBus();
    const made = [];
    let clock = 0, tick = null;
    registerAudioPlaybackService(bus, {
        createAudio: () => { const el = makeAudio(); made.push(el); return el; }, crossfadeMs: 1000,
        setTimer: callback => { tick = callback; return 1; }, clearTimer: () => { tick = null; }, now: () => clock,
    });
    await bus.call('audio.playback.volume', { value: 0.8 });
    await bus.call('audio.playback.play', { id: 'a', source: { kind: 'url', ref: 'https://x/a.mp3' } });
    assert.equal(made.length, 1);
    await bus.call('audio.playback.play', { id: 'b', source: { kind: 'url', ref: 'https://x/b.mp3' } });
    assert.equal(made.length, 2, 'the next track gets its own element');
    const [oldEl, newEl] = made;
    assert.equal(newEl.volume, 0, 'it starts silent');
    clock = 500; tick();
    assert.ok(Math.abs(oldEl.volume - 0.4) < 1e-9 && Math.abs(newEl.volume - 0.4) < 1e-9, 'halfway: both at half');
    assert.equal(oldEl.paused, false);
    clock = 1000; tick();
    assert.equal(oldEl.paused, true, 'the old track is stopped when the fade ends');
    assert.ok(Math.abs(newEl.volume - 0.8) < 1e-9, 'the new one reaches the set volume');
    assert.equal((await bus.call('audio.playback.state')).id, 'b');
    oldEl.emit('ended');   // старый элемент о конце не сообщает
    let ended = 0;
    await bus.call('audio.playback.play', { id: 'b', source: { kind: 'url', ref: 'https://x/b.mp3' }, onEnded: () => { ended += 1; } });
    oldEl.emit('ended');
    assert.equal(ended, 0);
    newEl.emit('ended');
    assert.equal(ended, 1);
});

test('crossfade: the first track and the same track again start at once (nothing to fade from); crossfade 0 keeps the old hard switch', async () => {
    const bus = makeBus();
    const made = [];
    registerAudioPlaybackService(bus, { createAudio: () => { const el = makeAudio(); made.push(el); return el; }, crossfadeMs: 1000, setTimer: () => 1, clearTimer: () => {} });
    await bus.call('audio.playback.play', { id: 'a', source: { kind: 'url', ref: 'https://x/a.mp3' } });
    await bus.call('audio.playback.play', { id: 'a', source: { kind: 'url', ref: 'https://x/a.mp3' } });
    assert.equal(made.length, 1);

    const hard = [];
    const bus2 = makeBus();
    registerAudioPlaybackService(bus2, { createAudio: () => { const el = makeAudio(); hard.push(el); return el; } });
    await bus2.call('audio.playback.play', { id: 'a', source: { kind: 'url', ref: 'https://x/a.mp3' } });
    await bus2.call('audio.playback.play', { id: 'b', source: { kind: 'url', ref: 'https://x/b.mp3' } });
    assert.equal(hard.length, 1, 'one element, switched at once');
});
