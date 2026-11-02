/**
 * Место родного Prompt Manager у SillyTavern. Иконка «AI Response
 * Configuration» (`#ai-config-button`) перехватывается целиком: родная панель
 * ST (`#left-nav-panel`) не открывается ни через неё, ни сохранённым
 * состоянием, и вместо неё открывается окно разделов промптов директора и
 * прозаика.
 *
 * Перехват — на `document` в фазе погружения: у ST обработчик висит прямо на
 * иконке и зарегистрирован раньше нашего кода, поэтому слушатель на том же
 * узле сработал бы после него. На предке погружение идёт раньше пузырька у
 * цели, независимо от порядка регистрации; `stopImmediatePropagation()`
 * останавливает событие до штатного тоггла.
 *
 *   stDecisionUi.install({ onOpen }) — перехватить иконку и спрятать панель ST
 *   stDecisionUi.uninstall()        — снять перехват и спрятанность
 */
const BUTTON_ID = 'ai-config-button';
const PANEL_ID = 'left-nav-panel';
const STYLE_ID = 'stme-dp-suppress';

export function registerStDecisionUiService(bus, { document: doc = globalThis.document } = {}) {
    let onOpenHandler = null;
    let listener = null;

    function toggleOf() {
        return doc?.getElementById?.(BUTTON_ID)?.querySelector?.('.drawer-toggle') ?? doc?.getElementById?.(BUTTON_ID) ?? null;
    }

    function install(params) {
        onOpenHandler = params?.onOpen ?? null;
        const toggle = toggleOf();
        if (!doc || !toggle) return { found: false };
        if (!doc.getElementById(STYLE_ID)) {
            const style = doc.createElement('style');
            style.id = STYLE_ID;
            style.textContent = `#${PANEL_ID} { display: none !important; }`;
            doc.head.append(style);
        }
        if (!listener) {
            listener = event => {
                if (!event.target?.closest?.(`#${BUTTON_ID}`)) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                onOpenHandler?.();
            };
            doc.addEventListener('click', listener, true);
        }
        return { found: true };
    }

    function uninstall() {
        doc?.getElementById?.(STYLE_ID)?.remove();
        if (listener) { doc.removeEventListener('click', listener, true); listener = null; }
        onOpenHandler = null;
        return true;
    }

    const unregisters = [
        bus.register('stDecisionUi.install', params => install(params)),
        bus.register('stDecisionUi.uninstall', () => uninstall()),
    ];
    return { install, uninstall, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
