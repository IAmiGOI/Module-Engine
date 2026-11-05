import { h } from '../tree.js';
import { computed } from '../reactive.js';
import { GAME_MODES } from '../../../libraries/core/game-settings.js';

/**
 * Ряд режимов. Четыре слота ВСЕГДА: Custom не появляется и не исчезает, а
 * просто подсвечивается — иначе при переходе в Custom сетка меняла число
 * колонок и остальные плитки прыгали (часть 14).
 */
export function modeTiles({ mode, onMode }) {
    return h('div', { class: 'stme-gs-modes', role: 'group', 'aria-label': 'Game mode' },
        ...GAME_MODES.map(item => h('button', {
            key: item.id,
            type: 'button',
            class: computed(() => (mode() === item.id ? 'stme-gs-mode stme-gs-mode-active' : 'stme-gs-mode')),
            'aria-pressed': computed(() => (mode() === item.id ? 'true' : 'false')),
            'on:click': () => onMode(item.id),
        },
            h('span', { class: 'stme-gs-mode-label' }, item.label),
            h('small', { class: 'stme-gs-mode-note' }, item.note))),
        h('div', {
            class: computed(() => (mode() === 'custom' ? 'stme-gs-mode stme-gs-mode-custom stme-gs-mode-active' : 'stme-gs-mode stme-gs-mode-custom')),
            role: 'status',
        },
            h('span', { class: 'stme-gs-mode-label' }, 'Custom'),
            h('small', { class: 'stme-gs-mode-note' }, 'Your own mix')));
}
