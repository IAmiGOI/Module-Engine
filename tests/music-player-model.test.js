import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatClock, progressPercent, timeFromPercent, coverHues, coverGradient, coverGlow, trackInitial, matchPercent, describeNowPlaying, volumeLevel, describeFeedback, describeStyle,
} from '../libraries/shared/music-player-model.js';

test('the clock reads m:ss, adds hours only when needed, and shows a fixed-width dash for an unknown time', () => {
    assert.equal(formatClock(0), '0:00');
    assert.equal(formatClock(7.9), '0:07', 'seconds are floored, like every player does');
    assert.equal(formatClock(187), '3:07');
    assert.equal(formatClock(3729), '1:02:09');
    for (const bad of [NaN, Infinity, -1, undefined, null]) assert.equal(formatClock(bad), '–:––');
});

test('progress is a percentage of the duration, clamped, and 0 without a known duration; the round trip through a percentage finds the same second', () => {
    assert.equal(progressPercent(50, 200), 25);
    assert.equal(progressPercent(999, 200), 100);
    assert.equal(progressPercent(-4, 200), 0);
    assert.equal(progressPercent(10, 0), 0);
    assert.equal(progressPercent(NaN, 200), 0);
    assert.equal(timeFromPercent(25, 200), 50);
    assert.equal(timeFromPercent(150, 200), 200);
    assert.equal(timeFromPercent(50, 0), 0);
});

test('a track always gets the same cover; different tracks get different ones; hues stay on the wheel', () => {
    assert.deepEqual(coverHues('Midnight Chase'), coverHues('Midnight Chase'));
    assert.notDeepEqual(coverHues('Midnight Chase'), coverHues('Quiet Forest'));
    for (const name of ['a', 'Midnight Chase', '夜の街', '', null]) {
        const { hue, hue2 } = coverHues(name);
        assert.ok(hue >= 0 && hue < 360 && hue2 >= 0 && hue2 < 360);
    }
    assert.match(coverGradient('Midnight Chase'), /^linear-gradient\(135deg, hsl\(\d+ 62% 48%\), hsl\(\d+ 58% 28%\)\)$/);
});

test('the letter on the cover is the first letter or digit of the name, a note otherwise', () => {
    assert.equal(trackInitial('midnight chase'), 'M');
    assert.equal(trackInitial('  --- 7 Nation Army'), '7');
    assert.equal(trackInitial('夜の街'), '夜');
    assert.equal(trackInitial('***'), '♪');
    assert.equal(trackInitial(null), '♪');
});

test('scene match reads as whole percents, unknown as null', () => {
    assert.equal(matchPercent(0.824), 82);
    assert.equal(matchPercent(1.4), 100);
    assert.equal(matchPercent(-0.2), 0);
    assert.equal(matchPercent(null), null);
});

test('the window text follows the player state: idle (with a hint for auto or manual), playing (with the match), paused, blocked by autoplay', () => {
    assert.deepEqual(describeNowPlaying({}, { autoSwitch: true }), { status: 'idle', title: 'Nothing playing', subtitle: 'A track is picked to match the scene' });
    assert.equal(describeNowPlaying({}, { autoSwitch: false }).subtitle, 'Press play or skip to pick a track');
    assert.equal(describeNowPlaying({}, { hasTracks: false }).subtitle, 'Add tracks in the Music settings', 'an empty library says where tracks come from');
    const track = { trackId: 't1', name: 'Midnight Chase' };
    assert.deepEqual(describeNowPlaying({ ...track, playing: true, similarity: 0.71 }), { status: 'playing', title: 'Midnight Chase', subtitle: 'Matches the scene · 71%' });
    assert.equal(describeNowPlaying({ ...track, playing: true, similarity: null }).subtitle, 'Chosen by hand');
    assert.deepEqual(describeNowPlaying({ ...track, playing: false }), { status: 'paused', title: 'Midnight Chase', subtitle: 'Paused' });
    assert.equal(describeNowPlaying({ ...track, blocked: true }).status, 'blocked');
    assert.equal(describeNowPlaying({ trackId: 't1', name: '', playing: true }).title, 'Untitled');
});

test('the volume icon: muted at zero or when muted, low under half, high otherwise', () => {
    assert.equal(volumeLevel(0), 'muted');
    assert.equal(volumeLevel(0.9, true), 'muted');
    assert.equal(volumeLevel(0.3), 'low');
    assert.equal(volumeLevel(0.5), 'high');
    assert.equal(volumeLevel(1), 'high');
});

test('the window glow uses the same two hues as the cover, so the window is tinted like the track', () => {
    const { hue, hue2 } = coverHues('Midnight Chase');
    const glow = coverGlow('Midnight Chase');
    assert.ok(glow.includes(`hsl(${hue} `) && glow.includes(`hsl(${hue2} `));
    assert.equal(coverGlow('Midnight Chase'), glow, 'stable');
});


test('describeFeedback names the music the player chose, and only after it was sent', () => {
    assert.equal(describeFeedback({ mark: 'bad', status: 'sent', wanted: 'Calm' }), 'Sent: this scene needs “Calm”');
    assert.equal(describeFeedback({ mark: 'bad', status: 'sending', wanted: 'Calm' }), 'Sending…');
    assert.equal(describeFeedback({ mark: 'bad', status: 'sent' }), 'Sent: wrong music for this scene');
});

test('describeStyle names the type the server chose, and what the owner said after sending', () => {
    assert.equal(describeStyle({ chosen: 'score' }), 'Type: Soundtrack — right?');
    assert.equal(describeStyle({ chosen: 'score', status: 'sent', right: true }), 'Sent: Soundtrack is right for this scene');
    assert.equal(describeStyle({ chosen: 'score', status: 'sent', right: false, correct: 'ambient' }), 'Sent: this scene needs Ambient, not Soundtrack');
    assert.equal(describeStyle({ chosen: 'vocal', status: 'failed' }), 'Could not send — try again');
});
