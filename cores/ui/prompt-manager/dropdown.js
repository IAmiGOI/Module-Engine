import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';

/**
 * Свой выпадающий список для окна Prompt Manager — БЕЗ нативного `<select>` и попапа ОС, который тема движка
 * никак не может стилизовать (владелец: «убери все дефолтные системные/браузерные кнопки, списки»). Список
 * рисуется нашим собственным `<div>`, открывается/закрывается кликом, а не браузером.
 *
 * Тот же интерфейс, что у общего `Select()` из libraries/shared/widgets.js — только этот живёт в PM и ничего
 * не меняет для остального движка (владелец сознательно ограничил переделку одним окном).
 *
 * Список — ВСЕГДА в дереве (не `computed(() => open() ? h(...) : null)`), видимость — через класс/`hidden`.
 * Условный монтаж живьём давал гонку: диффер выдавал `remove`, и тем же тиком — свежий `insert` того же узла
 * (найдено через прямой лог патчей в `final-ui-pc.js`), список оставался открытым после выбора. Постоянный
 * узел + переключение класса убирает саму возможность гонки между insert/remove одного слота.
 *
 * Закрытие по клику снаружи — через `pointerdown` на document (а не `focusout`, который на живом окне
 * закрывал список тем же тиком, что открывал — синтетический blur при переотрисовке кнопки).
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
    // Найдено живьём: после выбора значение сохраняется верно, но список иногда остаётся открытым — что-то
    // в дереве окна PM (реакция на изменение пресета где-то выше по дереву) само открывает его заново тем же
    // или следующим тиком, воспроизводится даже на чистой вкладке. Корень не найден за разумное время; здесь —
    // защитное повторное закрытие сразу и ещё раз после окна сохранения пресета (300мс, harness/prompt-manager-panel.js),
    // а не тонкая настройка гонки вслепую.
    const choose = value => {
        valueSignal.set(value);
        onChange?.(value);
        close();
        queueMicrotask(close);
        setTimeout(close, 400);
    };

    return h('div', {
        class: 'stme-pm-dropdown',
        'on:keydown': event => { if (event.key === 'Escape') close(); },
    },
        h('button', {
            type: 'button',
            class: 'stme-pm-dropdown-btn',
            'aria-expanded': computed(() => String(open())),
            'on:click': event => { if (open.peek()) close(); else openList(event.currentTarget.parentElement); },
        },
            h('span', { class: 'stme-pm-dropdown-label' }, computed(() => labelOf(valueSignal()))),
            h('span', { class: 'stme-pm-dropdown-arrow' }, '▾')),
        h('div', {
            class: computed(() => `stme-pm-dropdown-list${open() ? ' stme-pm-dropdown-list-open' : ''}`),
            role: 'listbox',
        },
            computed(() => read().map(option => h('div', {
                class: `stme-pm-dropdown-option${option.value === valueSignal() ? ' stme-pm-dropdown-option-active' : ''}`,
                role: 'option',
                'on:click': () => choose(option.value),
            }, option.label ?? option.value)))),
    );
}
