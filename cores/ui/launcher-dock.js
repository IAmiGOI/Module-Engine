import {
    DOCK_BUTTONS, DOCK_CLASSES, buttonClassOf, shouldCollapseOnOutsideTap, shouldInterceptTap, shouldRestoreSavedPosition,
} from '../../libraries/shared/dock-model.js';

/**
 * Ядро дока — плавающая «пилюля» у правого края: кнопки панелей и светофор активности. Раньше жила прямо в `index.js` (130 строк
 * DOM без единого теста), и именно там нашёлся баг: на телефоне светофора не было, а сохранённая высота могла унести пилюлю за экран.
 *
 * Док намеренно строится обычным DOM, а не деревом `h()`: пилюля живёт мимо деревьев Ядер (у неё нет дерева Android-ядра, а полоска
 * светофора — статичный DOM без перерисовок; см. styles/). Поэтому всё браузерное приходит инъекцией (`document`, `storage`, фабрики
 * светофора и перетаскивания), а Ядро только собирает и связывает — и целиком проверяется на подставном DOM.
 *
 * Действия кнопок — тоже инъекция (`actions`), Ядро про сами панели ничего не знает: тумблер графа или картинки собирает вызывающий.
 */

// Ниже, в конце файла, — историческое обоснование выбора «плавающий док, а не иконка в верхней панели ST» (перенесено из index.js без изменений).
const STORAGE_KEY = 'stmeBetaLauncherDockY';
const ZONE_ID = 'stmeBetaLauncherDock';

const defaultStorage = () => ({
    getItem: () => { try { return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null; } catch { return null; } },
    setItem: value => { try { globalThis.localStorage?.setItem(STORAGE_KEY, value); } catch { /* приватный режим — место просто не сохранится */ } },
});

export function createLauncherDockCore(host, {
    document: doc = globalThis.document,
    touch = false,
    storage = defaultStorage(),
    actions = {},
    activityState,
    mountActivityLight,
    createEdgeDrag,
    getViewportHeight = () => globalThis.innerHeight,
} = {}) {
    let zone = null;
    let pill = null;

    const buttonFor = spec => {
        const button = doc.createElement('button');
        button.setAttribute('type', 'button');
        button.className = buttonClassOf(spec.id);
        button.setAttribute('title', spec.title);
        // ST переводит подсказки по data-i18n; у кнопки-картинки ключа перевода нет.
        if (spec.translate) button.setAttribute('data-i18n', `[title]${spec.title}`);
        const icon = doc.createElement('i');
        icon.className = `fa-solid ${spec.icon} fa-fw`;
        button.append(icon);
        // Клик кнопки без назначенного действия ничего не делает — вид без функционала допустим (так и было у «Picture»).
        button.addEventListener('click', () => { actions[spec.id]?.(); });
        return button;
    };

    function mount() {
        if (doc.getElementById?.(ZONE_ID)) return null;
        zone = doc.createElement('div');
        zone.id = ZONE_ID;
        zone.className = DOCK_CLASSES.zone;
        pill = doc.createElement('div');
        pill.className = DOCK_CLASSES.pill;
        for (const spec of DOCK_BUTTONS) pill.append(buttonFor(spec));
        zone.append(pill);

        // Тач: на телефоне нет :hover — пилюля постоянно видна, первое касание раскрывает, второе выполняет действие.
        if (touch) {
            zone.classList.add(DOCK_CLASSES.touch);
            const isOpen = () => zone.classList.contains(DOCK_CLASSES.open);
            // capture: перехватить касание кнопки ДО её собственного обработчика
            pill.addEventListener('click', event => {
                if (!shouldInterceptTap({ touch, open: isOpen() })) return;
                event.stopPropagation();
                zone.classList.add(DOCK_CLASSES.open);
            }, true);
            doc.addEventListener('click', event => {
                if (shouldCollapseOnOutsideTap({ touch, open: isOpen(), inside: zone.contains(event.target) })) zone.classList.remove(DOCK_CLASSES.open);
            });
        }

        // Светофор: статичная полоска, класс состояния на зоне кладёт фабрика (cores/ui/activity-light-dom.js).
        if (activityState && mountActivityLight) mountActivityLight(zone, activityState);

        const edgeDrag = createEdgeDrag({
            storage,
            getViewportHeight,
            getHeight: () => zone.offsetHeight,
            getBottom: () => getViewportHeight() - zone.getBoundingClientRect().bottom,
            setBottom: px => { zone.style.bottom = `${px}px`; },
        });
        if (shouldRestoreSavedPosition({ touch })) edgeDrag.restore();
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) zone.addEventListener(type, edgeDrag[`on:${type}`]);
        // Гашение клика, досланного браузером после перетаскивания, — ДО обработчиков кнопок (capture).
        zone.addEventListener('click', event => {
            if (edgeDrag.suppressClick) { event.stopPropagation(); event.preventDefault(); }
        }, true);

        doc.body.append(zone);
        return zone;
    }

    return {
        mount,
        zone: () => zone,
        isOpen: () => Boolean(zone?.classList.contains(DOCK_CLASSES.open)),
        dispose: () => { zone?.remove(); zone = null; pill = null; },
    };
}

/*
 * A persistent floating launcher, fixed to the right edge of the viewport —
 * NOT inserted into ST's own top-bar. Used to be a `.drawer` icon appended
 * next to `#rightNavHolder`/inside `#top-bar` (same shape as Alpha's own
 * `addTopBarLauncher()`), but that made it disappear completely under the
 * popular third-party extension "SillyTavern-ProbablyTooManyTabs": its own
 * `style.css` sets `#top-bar, #top-settings-holder { display: none !important; }`
 * UNCONDITIONALLY (checked against its real source, not just its README) —
 * the whole container is hidden, not filtered by content, so nothing placed
 * there survives, regardless of id/class. A `position: fixed` element on
 * `<body>` doesn't depend on that container at all, so the SAME code shows
 * the SAME launcher whether or not that extension (or any other that
 * reorganizes the top bar) is installed.
 *
 * Five icon-sized slots by height — THREE of them real now
 * (`stme-launcher-dock-btn`, opens the engine panel; `stme-launcher-dock-btn-graph`,
 * opens the Memory Graph editor's own floating window directly, without
 * detouring through the settings panel's card first — решено с пользователем:
 * "вынеси заход в граф в боковую панель тоже"; `stme-launcher-dock-btn-music`,
 * показывает HUD-плеер Модуля «Music» через GENERIC `modules.requestHud(id)`
 * Раннера — кнопка знает только id и не знает, включён ли Модуль: если нет,
 * клик честно ничего не откроет), `stme-launcher-dock-btn-image` — кнопка с
 * видом картинки (fa-image), ПОКА БЕЗ ФУНКЦИОНАЛА (решено с пользователем):
 * клик ничего не делает, а сама она внесена в :not()-цепочку селектора
 * главной кнопки ниже, чтобы клик по ней не тумблерил панель. Шестерёнка
 * (`stme-launcher-dock-btn-settings`) переехала В НИЖНИЙ СЛОТ: пустых слотов
 * в доке больше нет, все пять мест заняты настоящими кнопками.
 *
 * Wrapped in a `.stme-launcher-dock-zone` — a stationary hover hitbox, NOT
 * the pill itself. An earlier version put `:hover` directly on the sliding
 * pill: moving the mouse to the very edge made the pill slide out from under
 * the cursor, dropping `:hover`, sliding back under it, re-triggering
 * `:hover` — a visible vibration (caught live). The zone never moves; only
 * the pill inside it does.
*/
