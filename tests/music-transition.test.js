import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAudioPlaybackService } from '../services/audio-playback.js';
import { cleanTransition, parsePick } from '../libraries/shared/music-catalog.js';

function makeBus() {
    const handlers = new Map();
    return { register: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); }, call: (name, params) => handlers.get(name)(params) };
}
function makeAudio() {
    const el = { paused: true, ended: false, currentTime: 0, duration: 200, volume: 1, playbackRate: 1, src: '', addEventListener() {}, play: async () => { el.paused = false; }, pause: () => { el.paused = true; } };
    return el;
}
/** Фейковый Web Audio: запоминает расписания параметров. */
function makeContext() {
    const param = value => ({ value, events: [], setValueAtTime(v, t) { this.events.push(['set', v, t]); }, linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); }, setValueCurveAtTime(curve, t, d) { this.events.push(['curve', curve.length, t, d]); } });
    const node = extra => ({ connect() {}, ...extra });
    const context = { currentTime: 10, destination: {}, resume: async () => {}, created: [], createMediaElementSource: el => node({ el }), createBiquadFilter: () => { const n = node({ type: '', frequency: { value: 0 }, gain: param(0) }); context.created.push(['low', n]); return n; }, createGain: () => { const n = node({ gain: param(1) }); context.created.push(['gain', n]); return n; } };
    return context;
}
const blob = () => new Blob(['x']);

test('cleanTransition keeps a sane plan and drops everything else; parsePick carries it on a play answer only', () => {
    assert.deepEqual(cleanTransition({ kind: 'beat', outAt: 31.2, fadeSec: 8, bassSwapAt: 0.6, rate: 1.03, extra: 1 }), { kind: 'beat', outAt: 31.2, fadeSec: 8, bassSwapAt: 0.6, rate: 1.03 });
    assert.deepEqual(cleanTransition({ kind: 'plain', outAt: 90, fadeSec: 6, bassSwapAt: null, rate: 9 }), { kind: 'plain', outAt: 90, fadeSec: 6, bassSwapAt: null, rate: 1 });
    for (const bad of [null, 'x', { kind: 'weird', outAt: 1, fadeSec: 5 }, { kind: 'beat', outAt: -1, fadeSec: 5 }, { kind: 'beat', outAt: 5, fadeSec: 0 }, { kind: 'beat', outAt: 5, fadeSec: 99 }]) assert.equal(cleanTransition(bad), null);
    const play = parsePick(JSON.stringify({ action: 'play', id: 'abc', ext: 'mp3', similarity: 0.7, transition: { kind: 'beat', outAt: 31.2, fadeSec: 8, bassSwapAt: 0.6, rate: 1 } }), { server: 'http://x', sectionId: 's' });
    assert.equal(play.transition.outAt, 31.2);
    assert.equal(parsePick(JSON.stringify({ action: 'play', id: 'abc', ext: 'mp3', transition: { kind: 'x' } }), { server: 'http://x', sectionId: 's' }).transition, undefined);
    assert.equal(parsePick(JSON.stringify({ action: 'keep', transition: { kind: 'beat', outAt: 1, fadeSec: 5 } }), { server: 'http://x', sectionId: 's' }).transition, undefined);
});

test('a planned transition waits for the exit point of the playing track, starts the new one at the planned tempo, swaps the bass on the strong beat and retires the old track after the fade', async () => {
    const bus = makeBus(), elements = [], context = makeContext(), timers = [];
    registerAudioPlaybackService(bus, { createAudio: () => { const el = makeAudio(); elements.push(el); return el; }, createContext: () => context, schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {} });
    await bus.call('audio.playback.play', { id: 'a', blob: blob() });
    elements[0].currentTime = 28;
    const started = bus.call('audio.playback.play', { id: 'b', blob: blob(), transition: { kind: 'beat', outAt: 31, fadeSec: 8, bassSwapAt: 0.6, rate: 1.04 } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(elements.length, 2);
    assert.equal(elements[1].paused, true, 'the new track has not started: the old one is not at its exit point yet');
    const wait = timers[0];
    assert.ok(wait.ms > 2700 && wait.ms < 3000, `waits ~3 s minus the start latency (${wait.ms})`);
    elements[0].currentTime = 30.9;
    wait.fn();
    assert.deepEqual(await started, { ok: true, started: true });
    assert.equal(elements[1].paused, false);
    assert.equal(elements[1].playbackRate, 1.04, 'tempo is nudged to the old track');
    assert.equal((await bus.call('audio.playback.state')).id, 'b', 'the new track is the current one');
    const lows = context.created.filter(([kind]) => kind === 'low').map(([, node]) => node);
    assert.equal(lows.length, 2);
    const [outLow, inLow] = lows;
    assert.ok(inLow.gain.events.some(([kind, value]) => kind === 'set' && value === -26), 'the new track enters with its bass cut');
    assert.ok(inLow.gain.events.some(([kind, value]) => kind === 'ramp' && value === 0), 'and gets it back on the strong beat');
    assert.ok(outLow.gain.events.some(([kind, value]) => kind === 'ramp' && value === -26), 'the old track loses its bass at the same moment');
    elements[0].currentTime = 31.1; elements[1].currentTime = 0.35;
    timers.find(item => item.ms === 260).fn();
    assert.ok(Math.abs(elements[1].currentTime - 0.104) < 0.001, 'the position of the new track is aligned to the grid once after the start');
    const retire = timers.find(item => item.ms > 8000);
    assert.ok(retire, 'the old track is retired after the fade');
    retire.fn();
    assert.equal(elements[0].paused, true);
});

test('a plan that cannot be carried out (no Web Audio, nothing playing, same track) falls back to the usual playback', async () => {
    const bus = makeBus(), elements = [];
    registerAudioPlaybackService(bus, { createAudio: () => { const el = makeAudio(); elements.push(el); return el; }, createContext: () => null });
    const plan = { kind: 'beat', outAt: 31, fadeSec: 8, bassSwapAt: 0.6, rate: 1.04 };
    assert.deepEqual(await bus.call('audio.playback.play', { id: 'a', blob: blob(), transition: plan }), { ok: true, started: true }, 'nothing playing yet: just play');
    assert.deepEqual(await bus.call('audio.playback.play', { id: 'b', blob: blob(), transition: plan }), { ok: true, started: true }, 'no Web Audio: the ordinary path');
    assert.equal((await bus.call('audio.playback.state')).id, 'b');
});

test('pausing while the planned start is pending cancels it and keeps the old track', async () => {
    const bus = makeBus(), elements = [], context = makeContext(), timers = [];
    registerAudioPlaybackService(bus, { createAudio: () => { const el = makeAudio(); elements.push(el); return el; }, createContext: () => context, schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, cancel: () => {} });
    await bus.call('audio.playback.play', { id: 'a', blob: blob() });
    elements[0].currentTime = 20;
    const started = bus.call('audio.playback.play', { id: 'b', blob: blob(), transition: { kind: 'plain', outAt: 40, fadeSec: 6, bassSwapAt: null, rate: 1 } });
    await Promise.resolve(); await Promise.resolve();
    await bus.call('audio.playback.pause', {});
    assert.deepEqual(await started, { ok: true, started: false });
    assert.equal(elements[1].paused, true);
    assert.equal((await bus.call('audio.playback.state')).id, 'a');
});
