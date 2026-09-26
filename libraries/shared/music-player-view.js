import { h } from '../../cores/ui/tree.js';
import { signal, computed } from '../../cores/ui/reactive.js';
import {
    formatClock, progressPercent, timeFromPercent, coverGradient, coverGlow, trackInitial, describeNowPlaying, volumeLevel,
} from './music-player-model.js';

/**
 * Тело окна плеера Music — дерево `h()` поверх модели (`music-player-model.js`), без DOM и шин; тестируется как данные. Окно (`FloatingPanel`) даёт модуль, а стили —
 * `styles/modules/music-player.css` (только токены темы, без анимаций: окно висит поверх чата, а любая анимация рядом с ним вызывает полный reflow страницы).
 *
 * Состояние приходит сигналами, действия — колбэками; своего состояния здесь ровно одно — `draft` (положение бегунка, пока его тащат: время под ним показывает, куда
 * прыгнет трек, а сама перемотка уходит в Сервис один раз — по отпусканию).
 */

const svg = (...paths) => h('svg', { viewBox: '0 0 24 24', class: 'stme-music-icon', 'aria-hidden': 'true' }, ...paths);
const fill = d => h('path', { d, fill: 'currentColor' });
const line = d => h('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const SPEAKER = 'M4 9v6h4l5 4V5L8 9H4z';

export const ICONS = Object.freeze({
    play: () => svg(fill('M8 5v14l11-7z')),
    pause: () => svg(fill('M6 5h4v14H6zM14 5h4v14h-4z')),
    next: () => svg(fill('M6 5l9 7-9 7V5zM16 5h2v14h-2V5z')),
    restart: () => svg(fill('M18 5l-9 7 9 7V5zM6 5h2v14H6V5z')),
    auto: () => svg(fill('M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9L11 3zM18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z')),
    note: () => svg(line('M9 18V6l10-2v12'), line('M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM19 16a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z')),
    volumeHigh: () => svg(fill(SPEAKER), line('M16 8.5a5 5 0 010 7M18.6 6a8.6 8.6 0 010 12')),
    volumeLow: () => svg(fill(SPEAKER), line('M16 8.5a5 5 0 010 7')),
    volumeMuted: () => svg(fill(SPEAKER), line('M16.5 9.5l5 5M21.5 9.5l-5 5')),
});

/** Ползунок: дорожка-заливка (ширина в процентах) и невидимый настоящий `<input type=range>` поверх — клавиатура, фокус и жесты остаются родными. */
function Range({ label, percent, onInput, onChange, min = 0, max = 100, step = 0.1, valueText, className = '' }) {
    return h('div', { class: `stme-music-range ${className}`.trim() },
        h('div', { class: 'stme-music-range-track' },
            h('div', { class: 'stme-music-range-fill', style: computed(() => ({ width: `${percent()}%` })) }),
        ),
        h('input', {
            type: 'range', min, max, step, value: percent, 'aria-label': label,
            'aria-valuetext': valueText ? computed(valueText) : undefined,
            'on:input': event => onInput?.(Number(event.target.value)),
            'on:change': event => onChange?.(Number(event.target.value)),
        }),
    );
}

function ControlButton({ icon, label, onClick, className = '', pressed, disabled }) {
    return h('button', {
        type: 'button', class: `stme-music-btn ${className}`.trim(), title: label, 'aria-label': label,
        ...(pressed ? { 'aria-pressed': computed(() => String(Boolean(pressed()))) } : {}),
        ...(disabled ? { disabled } : {}),
        'on:click': onClick,
    }, icon);
}

/**
 * @param {object} props
 * @param {Function} props.now        сигнал `{ trackId, name, playing, blocked, similarity }`
 * @param {Function} props.progress   сигнал `{ time, duration }` (секунды)
 * @param {Function} props.volume     сигнал 0…1 (записываемый)
 * @param {Function} props.muted      сигнал «звук выключен»
 * @param {Function} props.autoSwitch сигнал «трек подбирается по сцене»
 * @param {Function} props.hasTracks  сигнал «в библиотеке есть треки»
 */
export function MusicPlayerBody({ now, progress, volume, muted, autoSwitch, hasTracks, onPlayPause, onSkip, onRestart, onSeek, onToggleMute, onToggleAuto, onVolumeCommit }) {
    const draft = signal(null);
    const info = computed(() => describeNowPlaying(now(), { autoSwitch: autoSwitch(), hasTracks: hasTracks() }));
    const seekPercent = computed(() => (draft() ?? progressPercent(progress().time, progress().duration)));
    const shownTime = computed(() => (draft() === null ? progress().time : timeFromPercent(draft(), progress().duration)));
    const volumePercent = computed(() => Math.round((muted() ? 0 : volume()) * 100));
    const playing = computed(() => Boolean(now().playing));

    return h('div', { class: 'stme-music-player', 'data-status': computed(() => info().status) },
        h('div', { class: 'stme-music-glow', 'aria-hidden': 'true', style: computed(() => (now().trackId ? { background: coverGlow(now().name) } : {})) }),
        h('div', { class: 'stme-music-top' },
            h('div', { class: 'stme-music-cover', 'aria-hidden': 'true', style: computed(() => (now().trackId ? { background: coverGradient(now().name) } : {})) },
                computed(() => (now().trackId ? h('span', { class: 'stme-music-cover-letter' }, trackInitial(now().name)) : ICONS.note())),
            ),
            h('div', { class: 'stme-music-meta' },
                h('div', { class: 'stme-music-title', title: computed(() => info().title) }, computed(() => info().title)),
                h('div', { class: 'stme-music-subtitle' }, computed(() => info().subtitle)),
            ),
        ),
        h('div', { class: 'stme-music-seek' },
            h('span', { class: 'stme-music-time' }, computed(() => formatClock(shownTime()))),
            Range({
                label: 'Seek', className: 'stme-music-seekbar', percent: seekPercent, step: 0.1,
                valueText: () => `${formatClock(shownTime())} of ${formatClock(progress().duration)}`,
                onInput: value => { if (progress().duration > 0) draft.set(value); },
                onChange: value => { const duration = progress().duration; draft.set(null); if (duration > 0) onSeek?.(timeFromPercent(value, duration)); },
            }),
            h('span', { class: 'stme-music-time stme-music-time-total' }, computed(() => (progress().duration > 0 ? formatClock(progress().duration) : '–:––'))),
        ),
        h('div', { class: 'stme-music-transport' },
            ControlButton({ icon: ICONS.auto(), label: 'Pick tracks to match the scene', onClick: onToggleAuto, className: 'stme-music-btn-auto', pressed: autoSwitch }),
            ControlButton({ icon: ICONS.restart(), label: 'Restart track', onClick: onRestart, disabled: computed(() => !now().trackId) }),
            ControlButton({
                icon: computed(() => (playing() ? ICONS.pause() : ICONS.play())), label: computed(() => (playing() ? 'Pause' : 'Play')),
                onClick: onPlayPause, className: 'stme-music-btn-primary', disabled: computed(() => !hasTracks()),
            }),
            ControlButton({ icon: ICONS.next(), label: 'Next track', onClick: onSkip, disabled: computed(() => !hasTracks()) }),
        ),
        h('div', { class: 'stme-music-volume' },
            ControlButton({
                icon: computed(() => ({ muted: ICONS.volumeMuted, low: ICONS.volumeLow, high: ICONS.volumeHigh })[volumeLevel(volume(), muted())]()),
                label: computed(() => (muted() ? 'Unmute' : 'Mute')), onClick: onToggleMute, className: 'stme-music-btn-small',
            }),
            Range({
                label: 'Volume', className: 'stme-music-volumebar', percent: volumePercent, step: 1,
                valueText: () => `${volumePercent()}%`,
                onInput: value => { volume.set(value / 100); if (muted()) onToggleMute?.(); },
                onChange: () => onVolumeCommit?.(),   // сохранить уровень по отпусканию, а не на каждое движение
            }),
            h('span', { class: 'stme-music-volume-value' }, computed(() => `${volumePercent()}`)),
        ),
    );
}
