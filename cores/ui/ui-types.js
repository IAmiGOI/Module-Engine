// @ts-check
/**
 * Типы Ядра UI: реактивные значения и абстрактное дерево. Файл без кода — только `@typedef` в JSDoc.
 * Подключение: `/** @typedef {import('./ui-types.js').Signal<number>} CountSignal *\/`.
 */

/**
 * Реактивное значение (reactive.js). `sig()` читает (и подписывает вычисление, если вызвано внутри `computed()`/`effect()`),
 * `set`/`update` пишут, `peek` читает без подписки.
 * @template [T=any]
 * @typedef {(() => T) & {
 *   set: (next: T) => void,
 *   update: (fn: (current: T) => T) => void,
 *   peek: () => T,
 *   isSignal: true }} Signal
 */

/**
 * Узел абстрактного дерева (tree.js): чистые данные, без DOM. Свойство или потомок МОГУТ быть сигналом — разворачивает diff.js.
 * @typedef {Object} UiNode
 * @property {string} tag
 * @property {Record<string, any>} props
 * @property {any[]} children
 */

/**
 * Обработчики DOM-событий в свойствах узла: `'on:input'`, `'on:click'` … Тип события выводится из имени — `'on:input'` получает `Event`,
 * `'on:pointerdown'` — `PointerEvent`. У события `target`/`currentTarget` — общий `EventTarget`: конкретный элемент автор сужает сам.
 * @typedef {{ [K in keyof HTMLElementEventMap as `on:${K}`]?: ((event: HTMLElementEventMap[K]) => void) | undefined }} UiEventProps
 */

/**
 * Свойства узла: типизированные обработчики + любые прочие (`class`, `style`, `value`, `data-*` … — значение или сигнал).
 * @typedef {UiEventProps & Record<string, unknown>} UiProps
 */

/** @typedef {any} UiChild  Потомок: узел, строка, число, сигнал или (вложенный) массив из них; `null`/`undefined`/`false` отбрасываются. */

export {};
