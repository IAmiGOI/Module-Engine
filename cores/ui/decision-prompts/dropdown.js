import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';

/**
 * Свой выпадающий список для окна разделов промптов — без нативного
 * `<select>` и попапа ОС, который тема движка не стилизует. Тот же интерфейс,
 * что у общего `Select()`, но список всегда в дереве, а видимость — классом:
 * условный монтаж давал гонку insert/remove одного слота.
 */
export function Select(valueSignal, options, { onChange } = {}) {
    const read = typeof options === 'function' ? options : () => options;
    const open = signal(false);
    const labelOf = value => read().find(option => option.value === value)?.label ?? value ?? '';
    let outsideHandler = null;
    let rootEl = null;

    function close() {
        open.set(false);
        if (outsideHandler) { document.removeEventListener('pointerdown', outsideHandler, true); outsideHandler = null; }
    }
    function openList(root) {
        rootEl = root;
        open.set(true);
        outsideHandler = event => { if (!rootEl.contains(event.target)) close(); };
        document.addEventListener('pointerdown', outsideHandler, true);
    }
    const choose = value => {
        valueSignal.set(value);
        onChange?.(value);
        close();
        queueMicrotask(close);
        setTimeout(close, 400);
    };

    return h('div', {
        class: 'stme-dp-dropdown',
        'on:keydown': event => { if (event.key === 'Escape') close(); },
    },
        h('button', {
            type: 'button',
            class: 'stme-dp-dropdown-btn',
            'aria-expanded': computed(() => String(open())),
            'on:click': event => { if (open.peek()) close(); else openList(event.currentTarget.parentElement); },
        },
            h('span', { class: 'stme-dp-dropdown-label' }, computed(() => labelOf(valueSignal()))),
            h('span', { class: 'stme-dp-dropdown-arrow' }, '▾')),
        h('div', {
            class: computed(() => `stme-dp-dropdown-list${open() ? ' stme-dp-dropdown-list-open' : ''}`),
            role: 'listbox',
        },
            computed(() => read().map(option => h('div', {
                class: `stme-dp-dropdown-option${option.value === valueSignal() ? ' stme-dp-dropdown-option-active' : ''}`,
                role: 'option',
                'on:click': () => choose(option.value),
            }, option.label ?? option.value)))),
    );
}
