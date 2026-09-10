import { wireEngine } from './harness/engine-wiring.js';
import { createFullScreenPanel } from './harness/full-screen-panel.js';
import { isMobileSurface } from './cores/ui/final-ui-android.js';
import { effect } from './cores/ui/reactive.js';
import { createEdgeDrag } from './libraries/shared/edge-drag.js';

/**
 * Real SillyTavern entry point — verification-only, NOT the real Раннер
 * from ARCHITECTURE.md/ROADMAP.md (that one still needs generic Module
 * loading and a real semver/compatibility gate). This exists so the
 * built Ядра/Сервисы can be exercised inside a real ST page, against real
 * `chatMetadata`/`extensionSettings`/`fetch` — showing the SAME engine panel
 * proven in the standalone browser harness ([harness/index.html](harness/index.html)),
 * mounted verbatim from [cores/ui/engine-panel.js](cores/ui/engine-panel.js), so
 * the two never drift apart.
 *
 * The extensions drawer itself (a narrow sidebar) stays down to one line +
 * a fallback button — the actual panel opens as a page-width overlay
 * instead (see [harness/full-screen-panel.js](harness/full-screen-panel.js)),
 * same shape as Alpha's own full-screen panel and for the same reason:
 * several rows of fields simply don't fit a narrow drawer. The REAL, one-
 * click way in is a persistent floating launcher dock (`addLauncherDock()`
 * below), not a top-bar icon — see that function's own doc-comment for why.
 */

const DRAWER_HTML = `
<div id="stme_beta" class="stmeBeta-drawer">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>ST Module Engine (Beta) — engine panel</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
            <p><small>Opens a full-width engine panel with a button for every built Core.</small></p>
            <button type="button" class="menu_button" id="stmeBetaOpenPanel">Open engine panel</button>
        </div>
    </div>
</div>`;

function getContext() {
    if (!window.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return window.SillyTavern.getContext();
}

/**
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
 * клик честно ничего не откроет), the rest stay empty
 * `stme-launcher-dock-slot`s reserved for future quick actions, kept the
 * same visual size so the dock's shape doesn't change when another real
 * action arrives. ВТОРОЙ пустой слот (нижний) заменён ШЕСТЕРЁНКОЙ
 * (`stme-launcher-dock-btn-settings`) — решено с пользователем: Memory Graph
 * из ОСНОВНОГО меню движка убран (он уже живёт своим плавающим окном, вход —
 * здесь и в своей карточке… своей карточки больше нет, см.
 * cores/ui/engine-panel.js), а вместо него в доке — отдельный экран настроек
 * того же full-screen вида, что основная панель.
 *
 * Wrapped in a `.stme-launcher-dock-zone` — a stationary hover hitbox, NOT
 * the pill itself. An earlier version put `:hover` directly on the sliding
 * pill: moving the mouse to the very edge made the pill slide out from under
 * the cursor, dropping `:hover`, sliding back under it, re-triggering
 * `:hover` — a visible vibration (caught live). The zone never moves; only
 * the pill inside it does.
 */
function addLauncherDock(panel, { openMemoryGraphPanel, openSettingsPanel, toggleMain, requestModuleHud, activityState } = {}) {
    if (document.getElementById('stmeBetaLauncherDock')) return;
    const zone = document.createElement('div');
    zone.id = 'stmeBetaLauncherDock';
    zone.className = 'stme-launcher-dock-zone';
    zone.innerHTML = `
        <div class="stme-launcher-dock">
            <button type="button" class="stme-launcher-dock-btn" title="Open ST Module Engine (Beta)" data-i18n="[title]Open ST Module Engine (Beta)">
                <i class="fa-solid fa-flask fa-fw"></i>
            </button>
            <button type="button" class="stme-launcher-dock-btn stme-launcher-dock-btn-graph" title="Open Memory Graph" data-i18n="[title]Open Memory Graph">
                <i class="fa-solid fa-diagram-project fa-fw"></i>
            </button>
            <button type="button" class="stme-launcher-dock-btn stme-launcher-dock-btn-music" title="Show Music player" data-i18n="[title]Show Music player">
                <i class="fa-solid fa-music fa-fw"></i>
            </button>
            <button type="button" class="stme-launcher-dock-btn stme-launcher-dock-btn-settings" title="Open engine settings" data-i18n="[title]Open engine settings">
                <i class="fa-solid fa-gear fa-fw"></i>
            </button>
            <div class="stme-launcher-dock-slot" aria-hidden="true"></div>
        </div>`;
    zone.querySelector('.stme-launcher-dock-btn:not(.stme-launcher-dock-btn-graph):not(.stme-launcher-dock-btn-music):not(.stme-launcher-dock-btn-settings)').addEventListener('click', () => (toggleMain ?? (() => panel.toggle()))());
    zone.querySelector('.stme-launcher-dock-btn-graph').addEventListener('click', () => openMemoryGraphPanel?.());
    zone.querySelector('.stme-launcher-dock-btn-settings').addEventListener('click', () => openSettingsPanel?.());
    // GENERIC-канал: кнопка знает только id Модуля и просит Раннер показать
    // его HUD. Модуль выключен — requestHud вернёт false, клик не сделает вид,
    // что что-то открыл.
    zone.querySelector('.stme-launcher-dock-btn-music').addEventListener('click', () => { requestModuleHud?.('module.music'); });
    // На тач-экране :hover не существует — пилюля, спрятанная за край экрана
    // (видны только 10px щели), для пальца НЕ СУЩЕСТВУЕТ, что и ловил
    // пользователь: «вообще не видно». Поэтому платформа помечается классом
    // `stme-launcher-dock-touch` на ЗОНЕ (пилюля живёт мимо движка, у неё нет
    // дерева Android-ядра — см. panel.css), и на тач-поверхности пилюля
    // постоянно видна: полупрозрачная у края, по тапу выезжает целиком
    // и становится непрозрачной. Первый тап по кнопке только раскрывает,
    // второй — выполняет действие (как у iOS-браузера с тулбаром).
    if (isMobileSurface()) {
        zone.classList.add('stme-launcher-dock-touch');
        const pill = zone.querySelector('.stme-launcher-dock');
        pill.addEventListener('click', event => {
            if (!zone.classList.contains('stme-launcher-dock-open')) {
                event.stopPropagation();
                zone.classList.add('stme-launcher-dock-open');
            }
        }, true); // capture: перехватить клик кнопки ДО её собственного обработчика
        document.addEventListener('click', event => {
            if (!zone.contains(event.target)) zone.classList.remove('stme-launcher-dock-open');
        });
    }
    // Светофор активности: полоска пилюли — «лампочка» состояния движка
    // (cores/ui/activity-light.js сводит события всех Ядер в одно состояние).
    // Сигналы этой кодовой базы не знают .subscribe() — живое чтение тут
    // называется effect(): функция перезапускается при каждом изменении.
    // Класс состояния добавляем ДОБАВЛЕНИЕМ (а не переприсвоением className —
    // та ошибка затёрла бы touch/open классы), предыдущий снимаем.
    if (activityState) {
        let previousClass = null;
        effect(() => {
            const next = `stme-light-${activityState()}`;
            if (previousClass) zone.classList.remove(previousClass);
            zone.classList.add(next);
            previousClass = next;
        });
    }
    // Вертикальное перетаскивание по правому краю — Библиотека
    // ([edge-drag.js](./libraries/shared/edge-drag.js)), здесь только проводка.
    // Двигается САМА зона (неподвижная по договору «анти-вибрации» выше — но
    // ЦЕЛИКОМ и только ПОКА её тащат; пилюля внутри по-прежнему ездит одна,
    // так что вибрации это не возвращает). Раскрытие по наведению не тронуто:
    // `:hover` живёт на зоне и после отпускания пилюля сворачивается на новом
    // месте сама, как только мышь уйдёт.
    const edgeDrag = createEdgeDrag({
        // localStorage, а не storage-Сервис движка: пилюля живёт МИМО дерева
        // Ядер (см. panel.css) и до Раннера с его шинами не добирается — ей
        // доступен только браузер.
        storage: {
            getItem: () => { try { return localStorage.getItem('stmeBetaLauncherDockY'); } catch { return null; } },
            setItem: value => { try { localStorage.setItem('stmeBetaLauncherDockY', value); } catch { /* приватный режим — место просто не сохранится */ } },
        },
        getViewportHeight: () => window.innerHeight,
        getHeight: () => zone.offsetHeight,
        getBottom: () => window.innerHeight - zone.getBoundingClientRect().bottom,
        setBottom: px => { zone.style.bottom = `${px}px`; },
    });
    edgeDrag.restore();
    for (const handler of ['on:pointerdown', 'on:pointermove', 'on:pointerup', 'on:pointercancel']) {
        zone.addEventListener(handler.slice(3).toLowerCase(), edgeDrag[handler]);
    }
    // Гашение досланного после драга клика — ДО обработчиков кнопок (capture).
    zone.addEventListener('click', event => {
        if (edgeDrag.suppressClick) { event.stopPropagation(); event.preventDefault(); }
    }, true);
    document.body.append(zone);
}

async function init() {
    // `scriptUrl` — адрес ИМЕННО этого файла: из него берётся имя папки
    // расширения, которого ждут git-эндпоинты ST. Передаём явно, потому что
    // сборщик движка лежит в другой папке, и его собственный `import.meta.url`
    // дал бы не то имя.
    const { engine, panelUi, selfUpdate, memoryGraphPanel, activityLight, modules, enginePanel } = await wireEngine({
        getContext,
        fetch: window.fetch.bind(window),
        scriptUrl: import.meta.url,
    });

    // Обновление запускается РАНЬШЕ интерфейса: если мы отстали, страница всё
    // равно перезагрузится, и строить панель дважды незачем. Ход молчит, когда
    // сказать нечего — не git-установка, нет сети, уже свежее.
    // Итог хода печатается ВСЕГДА. «Молчит, когда сказать нечего» задумывалось
    // против шума в интерфейсе, а не против диагностики: без строчки в консоли
    // отличить работающее самообновление от сломанного было нечем.
    selfUpdate.run()
        .then(result => console.info('[ST Module Engine (Beta)] Self-update:', result?.outcome ?? 'no result', result?.reason ?? result?.error ?? ''))
        .catch(error => console.warn('[ST Module Engine (Beta)] Self-update skipped:', error));

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('SillyTavern extensions settings container was not found.');
    if (!document.getElementById('stme_beta')) target.insertAdjacentHTML('beforeend', DRAWER_HTML);

    const panel = createFullScreenPanel({ title: 'ST Module Engine' });
    panel.body.append(panelUi.getRoot());

    // Отдельный экран настроек — ТОТ ЖЕ full-screen вид, что основная панель
    // (решено с пользователем: «чтобы вело на такой же экран по принципу и
    // виду основной»). Содержимое рисует САМО Ядро панели вторым деревом
    // (settingsTree: пресеты + апдейты, «перенеси в экран настроек раздел
    // пресетов и апдейтов») — корень забирается здесь в body оверлея. Данные
    // общие с основной панелью, потому что это то же Ядро.
    const settingsPanel = createFullScreenPanel({ title: 'ST Module Engine — Settings' });
    settingsPanel.body.append(enginePanel.settingsRoot());
    // Взаимное исключение (решено с пользователем: «если открыты настройки и
    // ты открываешь основную панель — они накладываются друг на друга. Я
    // хочу, чтобы они переключались»): оба оверлея — фиксированные слои на
    // body, и открытие одного ДОЛЖНО закрывать другой, иначе они честно
    // лежат друг на друге (тот, кто открыт последним, просто ниже по DOM).
    // `toggle()` у основной панели тоже проходит через это переключение:
    // клик по кнопке дока — самый частый путь, и он обязан гасить настройки.
    const openMain = () => { settingsPanel.close(); panel.open(); };
    // Тумблер шестерёнки — зеркало `panel.toggle()` (решено с пользователем:
    // «с настройками так не работает. Сделай так, чтобы работало»): Settings
    // открыты → закрыть; закрыты → открыть (закрыв основную панель).
    // Состояние читаем из DOM-флага `hidden` (единственный источник правды
    // createFullScreenPanel): метода isOpen() у него нет и заводить его
    // ради одной проверки здесь не нужно.
    const settingsOpen = () => !settingsPanel.body.parentElement.hidden;
    const toggleSettings = () => {
        if (settingsOpen()) { settingsPanel.close(); return; }
        panel.close();
        settingsPanel.open();
    };
    const openSettings = () => { panel.close(); settingsPanel.open(); };
    document.getElementById('stmeBetaOpenPanel').addEventListener('click', () => openMain());
    addLauncherDock(panel, {
        openMemoryGraphPanel: () => memoryGraphPanel.show(),
        openSettingsPanel: toggleSettings,
        requestModuleHud: id => modules.requestHud(id),
        activityState: activityLight.state,
        // Пилюля знает только `panel` для своего toggle — обёртка ниже
        // подменяет поведение, не трогая сам createFullScreenPanel.
        toggleMain,
    });

    window.STModuleEngineBeta = engine;
    console.info('[ST Module Engine (Beta)] Verification panel ready — open it from the floating launcher dock.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine (Beta)] Failed to start:', error); }
});
