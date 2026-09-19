/**
 * Чистые решения плавающего дока-«пилюли» (правое поле экрана: запуск панели, графа, музыки, картинки, настроек, светофор активности).
 * Без DOM и без браузера — само построение и события в [cores/ui/launcher-dock.js](../../cores/ui/launcher-dock.js), здесь только то,
 * что можно проверить как функцию. Такие решения раньше сидели прямо в `index.js` и ловились только на живом телефоне.
 */

/** Кнопки дока по порядку: `id` — ключ действия, `icon` — Font Awesome, `title` — подсказка (и ключ перевода ST). */
export const DOCK_BUTTONS = Object.freeze([
    Object.freeze({ id: 'main', icon: 'fa-flask', title: 'Open ST Module Engine (Beta)', translate: true }),
    Object.freeze({ id: 'graph', icon: 'fa-diagram-project', title: 'Open Memory Graph', translate: true }),
    Object.freeze({ id: 'music', icon: 'fa-music', title: 'Show Music player', translate: true }),
    // Кнопка-картинка — тумблер плавающего окна «Картинка»; своего ключа перевода у неё нет.
    Object.freeze({ id: 'image', icon: 'fa-image', title: 'Picture', translate: false }),
    Object.freeze({ id: 'settings', icon: 'fa-gear', title: 'Open engine settings', translate: true }),
]);

export const DOCK_CLASSES = Object.freeze({
    zone: 'stme-launcher-dock-zone',
    pill: 'stme-launcher-dock',
    button: 'stme-launcher-dock-btn',
    touch: 'stme-launcher-dock-touch',
    open: 'stme-launcher-dock-open',
});

export const buttonClassOf = id => (id === 'main' ? DOCK_CLASSES.button : `${DOCK_CLASSES.button} ${DOCK_CLASSES.button}-${id}`);

/**
 * Сохранённая высота дока (перетаскивание мышью) на телефоне НЕ применяется. Там док не таскают — pointer-события пальца
 * игнорируются, — а старая запись из другого режима (например, «Версия для ПК» с другой высотой окна) выставляла бы `bottom` поверх
 * CSS и уносила пилюлю вверх за экран: док и светофор становились недоступны, а с ними и настройки.
 */
export const shouldRestoreSavedPosition = ({ touch }) => !touch;

/**
 * Первое касание раскрывает пилюлю (на тач-экране нет :hover, и спрятанная за край она недоступна), второе выполняет действие.
 * `true` — касание надо перехватить и лишь раскрыть.
 */
export const shouldInterceptTap = ({ touch, open }) => Boolean(touch) && !open;

/** Касание вне зоны сворачивает раскрытую пилюлю. */
export const shouldCollapseOnOutsideTap = ({ touch, open, inside }) => Boolean(touch) && open && !inside;
