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
    delete state.feedbackProps;
    const tree = MusicPlayerBody({
        ...state, feedback: overrides.feedbackProps,
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
    assert.equal(Object.keys(ICONS).length, 12);
});

test('right/wrong buttons exist only when the caller gives a feedback handle, show only while visible, say what happened, and call back with the mark', () => {
    assert.equal(find(setup().tree, 'stme-music-feedback'), null, 'no handle — no row at all');

    const marks = [];
    const feedbackProps = { visible: signal(false), state: signal({ mark: null, status: 'idle' }), onMark: mark => marks.push(mark) };
    const { tree } = setup({ feedbackProps });
    const slot = tree.children.find(child => typeof child === 'function' && (read(child) === null || read(child)?.props?.class === 'stme-music-feedback'));
    assert.ok(slot, 'the row lives in a reactive slot');
    assert.equal(read(slot), null, 'hidden while no server track plays');

    feedbackProps.visible.set(true);
    const row = read(slot);
    assert.equal(row.props.class, 'stme-music-feedback');
    assert.equal(read(find(row, 'stme-music-feedback-label').children[0]), 'Is this the right music?');
    const [up, down] = row.children.filter(child => child?.tag === 'button');
    assert.equal(read(up.props['aria-label']), 'Right music for this scene');
    assert.equal(read(down.props['aria-label']), 'Wrong music for this scene');
    up.props['on:click'](); down.props['on:click']();
    assert.deepEqual(marks, ['good', 'bad']);

    feedbackProps.state.set({ mark: 'bad', status: 'sending' });
    assert.equal(read(find(row, 'stme-music-feedback-label').children[0]), 'Sending…');
    assert.equal(read(down.props['aria-pressed']), 'true');
    assert.equal(read(up.props['aria-pressed']), 'false');
    assert.equal(read(up.props.disabled), true, 'no double sending');
    feedbackProps.state.set({ mark: 'bad', status: 'sent' });
    assert.equal(read(find(row, 'stme-music-feedback-label').children[0]), 'Sent: wrong music for this scene');
    assert.equal(read(up.props.disabled), false);
});


test('the pencil next to the marks opens the list of right-music choices only when the caller supports it; the list shows loading/failed notes and calls back with the chosen id', () => {
    const marks = [], picked = [];
    const choices = { state: signal({ open: false, status: 'idle', list: [] }), onOpen: () => marks.push('open'), onPick: id => picked.push(id) };
    const feedbackProps = { visible: signal(true), state: signal({ mark: null, status: 'idle' }), onMark: () => {}, choices };
    const { tree } = setup({ feedbackProps });
    const slot = tree.children.filter(child => typeof child === 'function').find(child => read(child)?.props?.class === 'stme-music-choices-box');
    assert.ok(slot, 'a slot for the choices exists');
    const box = read(slot);
    const [pencil, list] = [box.children.find(child => child?.tag === 'button'), box.children.find(child => typeof child === 'function')];
    assert.equal(read(pencil.props['aria-label']), 'Choose the right music for this scene');
    pencil.props['on:click']();
    assert.deepEqual(marks, ['open']);
    assert.equal(read(list), null, 'closed — nothing shown');
    choices.state.set({ open: true, status: 'loading', list: [] });
    assert.equal(read(list).children[0], 'Loading…');
    choices.state.set({ open: true, status: 'failed', list: [] });
    assert.equal(read(list).children[0], 'No choices available for this section');
    choices.state.set({ open: true, status: 'ready', list: [{ id: 'n1', label: 'Fight' }, { id: 'n2', label: 'Calm' }] });
    const buttons = read(list).children.filter(child => child?.tag === 'button');
    assert.deepEqual(buttons.map(button => button.children[0]), ['Fight', 'Calm']);
    buttons[1].props['on:click']();
    assert.deepEqual(picked, ['n2']);
    feedbackProps.visible.set(false);
    assert.equal(read(slot), null, 'hidden together with the marks');
    const plain = setup({ feedbackProps: { visible: signal(true), state: signal({ mark: null, status: 'idle' }), onMark: () => {} } });
    assert.equal(plain.tree.children.some(child => typeof child === 'function' && read(child)?.props?.class === 'stme-music-choices-box'), false, 'no handle — no pencil');
});
