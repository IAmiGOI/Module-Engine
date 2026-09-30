/**
 * Сервис места родного Prompt Manager у ST — решение владельца (после реального фото: даже сжатая иконка
 * оставляла ПОЛНУЮ левую панель ST «AI Response Configuration» доступной — пресеты, сэмплер, Seed, Quick/Utility
 * Prompts и порядок промптов, всё нативное и вживую редактируемое рядом с нашим PM): «отключи кнопку показа
 * панели ST и подключи нашу кнопку вместо неё». Значит НЕ прячется один под-блок — перехватывается САМА иконка
 * открытия панели (`#ai-config-button`), и панель ST (`#left-nav-panel`) не открывается через неё вообще; открытие
 * зовёт наш обработчик вместо штатного тоггла. Панель заодно прячется CSS насовсем — защита от другого пути её
 * открыть (сохранённое состояние «закреплена открытой» между сессиями, `RossAscends-mods.js`, восстанавливается
 * БЕЗ клика).
 *
 * Перехват — на `document`, в фазе ПОГРУЖЕНИЯ (`capture: true`): у ST обработчик навешан `$('.drawer-toggle').on
 * ('click', ...)` ПРЯМО на иконку при старте страницы, раньше нашего кода; слушатель на том же узле сработал бы
 * ПОСЛЕ него (порядок регистрации, а не фаза), поэтому перехват нужен на предке — там погружение идёт раньше
 * пузырька у цели, независимо от порядка регистрации. `stopImmediatePropagation()` останавливает событие ДО
 * штатного обработчика — панель не успевает получить класс открытия.
 *
 *   stPmUi.install({ onOpen }) — перехватить иконку (вместо штатного тоггла зовёт onOpen), спрятать панель ST насовсем; { found }
 *   stPmUi.uninstall()         — снять перехват и спрятанность (полный демонтаж нашего UI)
 */
const BUTTON_ID = 'ai-config-button';
const PANEL_ID = 'left-nav-panel';
const STYLE_ID = 'stme-pm-suppress';

export function registerStPmUiService(bus, { document: doc = globalThis.document } = {}) {
    let onOpenHandler = null;
    let listener = null;

    function toggleOf() {
        return doc?.getElementById?.(BUTTON_ID)?.querySelector?.('.drawer-toggle') ?? doc?.getElementById?.(BUTTON_ID) ?? null;
    }

    function install(params) {
        onOpenHandler = params?.onOpen ?? null;
        const toggle = toggleOf();
        if (!toggle) return { found: false };
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
        bus.register('stPmUi.install', params => install(params)),
        bus.register('stPmUi.uninstall', () => uninstall()),
    ];
    return { install, uninstall, unregister: () => { for (const unregister of unregisters) unregister(); } };
}
