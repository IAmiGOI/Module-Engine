import test from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '../cores/ui/reactive.js';
import { MusicPlayerBody, ICONS } from '../libraries/shared/music-player-view.js';

/** Дерево — данные: ищем узел по классу; значение сигнала-ребёнка читаем как есть. */
function find(node, className) {
    if (!node || typeof node !== 'object' || typeof node === 'function') return null;
    if (String(node.props?.class ?? '').split(/\s+/).includes(className)) return node;
    for (const child of node.children ?? []) {
        const hit = find(child, className);
        if (hit) return hit;
    }
    return null;
}
const read = value => (typeof value === 'function' ? value() : value);

function setup(overrides = {}) {
    const calls = [];
    const state = {
        now: signal({ trackId: null, name: null, playing: false, blocked: false, similarity: null }),
        progress: signal({ time: 0, duration: 0 }),
        volume: signal(0.6), muted: signal(false), autoSwitch: signal(true), hasTracks: signal(true),
        ...overrides,
    };
    const tree = MusicPlayerBody({
        ...state,
        onPlayPause: () => calls.push('playPause'), onSkip: () => calls.push('skip'), onRestart: () => calls.push('restart'),
        onSeek: time => calls.push(['seek', time]), onToggleMute: () => calls.push('mute'), onToggleAuto: () => calls.push('auto'), onVolumeCommit: () => calls.push('commit'),
    });
    return { tree, state, calls };
}

test('the window text follows the player state through signals: idle, then a playing track with its match', () => {
    const { tree, state } = setup();
    const title = find(tree, 'stme-music-title');
    const subtitle = find(tree, 'stme-music-subtitle');
    assert.equal(read(title.children[0]), 'Nothing playing');
    assert.equal(read(tree.props['data-status']), 'idle');
    state.now.set({ trackId: 't1', name: 'Midnight Chase', playing: true, blocked: false, similarity: 0.82 });
    assert.equal(read(title.children[0]), 'Midnight Chase');
    assert.equal(read(subtitle.children[0]), 'Matches the scene · 82%');
    assert.equal(read(tree.props['data-status']), 'playing');
});

test('the play button reads Play or Pause and is disabled while the library is empty', () => {
    const { tree, state } = setup({ hasTracks: signal(false) });
    const primary = find(tree, 'stme-music-btn-primary');
    assert.equal(read(primary.props['aria-label']), 'Play');
    assert.equal(read(primary.props.disabled), true);
    state.hasTracks.set(true);
    state.now.set({ trackId: 't1', name: 'x', playing: true });
    assert.equal(read(primary.props['aria-label']), 'Pause');
    assert.equal(read(primary.props.disabled), false);
});

test('buttons call their actions', () => {
    const { tree, calls } = setup();
    find(tree, 'stme-music-btn-primary').props['on:click']();
    find(tree, 'stme-music-btn-auto').props['on:click']();
    find(tree, 'stme-music-btn-small').props['on:click']();
    assert.deepEqual(calls, ['playPause', 'auto', 'mute']);
});

test('the elapsed time and the fill follow the progress; the total shows a dash until the duration is known', () => {
    const { tree, state } = setup();
    const [elapsed, total] = ['stme-music-time', 'stme-music-time-total'].map(name => find(tree, name));
    assert.equal(read(elapsed.children[0]), '0:00');
    assert.equal(read(total.children[0]), '–:––');
    state.progress.set({ time: 47, duration: 188 });
    assert.equal(read(elapsed.children[0]), '0:47');
    assert.equal(read(total.children[0]), '3:08');
    assert.equal(read(find(tree, 'stme-music-seekbar').children[0].children[0].props.style).width, '25%');
});

test('dragging the seek bar previews the target time and seeks ONCE, on release; without a duration nothing seeks', () => {
    const { tree, state, calls } = setup();
    state.progress.set({ time: 10, duration: 200 });
    const input = find(tree, 'stme-music-seekbar').children[1];
    const elapsed = find(tree, 'stme-music-time');
    input.props['on:input']({ target: { value: '50' } });
    assert.equal(read(elapsed.children[0]), '1:40', 'the time under the thumb shows where it would jump');
    assert.deepEqual(calls, [], 'no seek while dragging');
    input.props['on:change']({ target: { value: '50' } });
    assert.deepEqual(calls, [['seek', 100]]);
    assert.equal(read(elapsed.children[0]), '0:10', 'after release the real position is shown again');

    const idle = setup();
    const idleInput = find(idle.tree, 'stme-music-seekbar').children[1];
    idleInput.props['on:input']({ target: { value: '50' } });
    idleInput.props['on:change']({ target: { value: '50' } });
    assert.deepEqual(idle.calls, []);
});

test('moving the volume writes it back; touching it while muted unmutes; the number shows 0 while muted', () => {
    const { tree, state, calls } = setup();
    const input = find(tree, 'stme-music-volumebar').children[1];
    const number = find(tree, 'stme-music-volume-value');
    input.props['on:input']({ target: { value: '35' } });
    assert.equal(state.volume(), 0.35);
    assert.equal(read(number.children[0]), '35');
    state.muted.set(true);
    assert.equal(read(number.children[0]), '0');
    input.props['on:input']({ target: { value: '50' } });
    assert.deepEqual(calls, ['mute'], 'dragging the volume while muted asks to unmute');
    input.props['on:change']({ target: { value: '50' } });
    assert.deepEqual(calls, ['mute', 'commit'], 'the level is saved on release, not on every move');
});

test('the volume icon follows the level and mute; every control has an accessible name', () => {
    const { tree, state } = setup();
    const button = find(tree, 'stme-music-btn-small');
    const icon = read(button.children[0]);
    assert.equal(icon.tag, 'svg');
    state.volume.set(0.2);
    assert.notDeepEqual(read(button.children[0]), icon, 'a quieter level draws another icon');
    assert.equal(read(button.props['aria-label']), 'Mute');
    state.muted.set(true);
    assert.equal(read(button.props['aria-label']), 'Unmute');
    for (const name of ['stme-music-btn-primary', 'stme-music-btn-auto']) assert.ok(read(find(tree, name).props['aria-label']));
    assert.equal(Object.keys(ICONS).length, 9);
});
