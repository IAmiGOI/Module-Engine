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
