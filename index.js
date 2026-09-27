import './harness/boot-start.js';
import { wireEngine } from './harness/engine-wiring.js';
import { createFullScreenPanel } from './harness/full-screen-panel.js';
import { isMobileSurface } from './cores/ui/final-ui-android.js';
import { createLauncherDockCore } from './cores/ui/launcher-dock.js';
import { createActivityLightDom } from './cores/ui/activity-light-dom.js';
import { createEdgeDrag } from './libraries/shared/edge-drag.js';
import { createAnchorNavigator } from './cores/ui/anchors.js';

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
 * click way in is a persistent floating launcher dock (`cores/ui/launcher-dock.js`
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
            <button type="button" class="menu_button" id="stmeBetaOpenSettings">Open engine settings</button>
        </div>
    </div>
</div>`;

function getContext() {
    if (!window.SillyTavern?.getContext) throw new Error('SillyTavern context API is unavailable.');
    return window.SillyTavern.getContext();
}

// Плавающий док (пилюля у правого края) — Ядро `cores/ui/launcher-dock.js`; здесь только сборка его действий (см. init() ниже).

/**
 * Открывает основную панель движка на карточке с заголовком `title`: раскрывает её, прокручивает в центр и на несколько секунд подсвечивает той же
 * пульсирующей обводкой, что онбординг (`stme-spotlight-target`). Не нашли карточку — панель просто открыта. Панель рисуется не сразу, поэтому
 * карточку ищем опросом (до секунды).
 */
function revealPanelCard(openMain, title, hubs = []) {
    openMain();
    if (!title) return;
    // Форма блока открывается в хабе (карточка появится в DOM видимой), дальше — подсветка, как раньше.
    for (const hub of hubs) if (hub.groupHas(title)) hub.openCard(title);
    // Опрос по таймеру, а не `requestAnimationFrame`: в скрытой вкладке rAF не идёт, а карточка должна найтись в любом случае.
    let tries = 0;
    const attempt = () => {
        const panelRoot = document.querySelector('.stmeBeta-fullscreen:not([hidden])');
        const card = [...(panelRoot?.querySelectorAll('.stme-card') ?? [])].find(node => node.querySelector('.stme-card-title strong')?.textContent.trim() === title);
        if (!card) { if ((tries += 1) < 20) setTimeout(attempt, 50); return; }
        card.open = true;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('stme-spotlight-target');
        setTimeout(() => card.classList.remove('stme-spotlight-target'), 4000);
    };
    setTimeout(attempt, 0);
}

async function init() {
    // `scriptUrl` — адрес ИМЕННО этого файла: из него берётся имя папки
    // расширения, которого ждут git-эндпоинты ST. Передаём явно, потому что
    // сборщик движка лежит в другой папке, и его собственный `import.meta.url`
    // дал бы не то имя.
    const { engine, panelUi, hub, startup, memoryGraphPanel, picturePanel, activityLight, modules, enginePanel, firstLoadResult, guide } = await wireEngine({
        getContext,
        fetch: window.fetch.bind(window),
        scriptUrl: import.meta.url,
    });

    // Первый запуск движка (счётчик 0 → 1, `firstLoad` внутри wireEngine) — знакомство ведёт гид (cores/guide): его чат открывается сам,
    // а пока модели нет, в нём идёт сценарий настройки. Старое окно онбординга убрано (ROADMAP 5.105).
    if (firstLoadResult?.firstLaunch) { void guide.open(); }

    // Порядок запуска — Ядро запуска (cores/startup): самообновление → (если страница не перезагружается) фоны и синхронизация → экран загрузки.
    // Идёт РАНЬШЕ интерфейса и без ожидания: интерфейс строится параллельно. Итог самообновления печатается в консоль всегда.
    startup.begin().catch(error => console.warn('[ST Module Engine (Beta)] Startup skipped:', error));

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
    // Обзор из блоков над формами: основная панель и экран настроек показывают свои группы; клик по блоку открывает его форму (нынешнюю карточку).
    const hubs = [hub.mount({ container: panel.body, panelRoot: panelUi.getRoot(), group: 'work' }), hub.mount({ container: settingsPanel.body, panelRoot: enginePanel.settingsRoot(), group: 'settings' })];
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
    // Flask в пилюле: закрыть настройки (если открыты) и тумблировать панель.
    const toggleMain = () => { settingsPanel.close(); panel.toggle(); };
    document.getElementById('stmeBetaOpenPanel').addEventListener('click', () => openMain());
    // Запасной путь к настройкам НЕ через док: на телефоне пилюлю может закрыть интерфейс браузера или ST, а меню расширений доступно всегда.
    document.getElementById('stmeBetaOpenSettings')?.addEventListener('click', () => openSettings());
    // Тумблеры окон в доке: граф и картинка умеют show()/hide()/isVisible() — переключаем по их собственному ответу; музыка идёт через
    // GENERIC requestHud(id) Раннера, который сам стал тумблером. Модуль выключен — requestHud вернёт false, клик не сделает вид, что что-то открыл.
    const toggleGraph = () => { if (memoryGraphPanel?.isVisible?.()) { memoryGraphPanel.hide(); return; } memoryGraphPanel.show(); };
    const togglePicture = () => { if (picturePanel?.isVisible?.()) { picturePanel.hide(); return; } picturePanel?.show(); };
    createLauncherDockCore(engine.registerCaller('core.ui.launcherDock', 'cores', { tier: 'official' }), {
        document,
        touch: isMobileSurface(),
        activityState: activityLight.state,
        mountActivityLight: createActivityLightDom,
        createEdgeDrag,
        actions: {
            main: toggleMain,
            graph: toggleGraph,
            music: () => { modules.requestHud('module.music'); },
            image: togglePicture,
            settings: toggleSettings,
        },
    }).mount();

    // Главный экран (шаги чек-листа): «открой панель на этой карточке» — панель принадлежит этому файлу, поэтому подписка здесь.
    engine.events.subscribe('ui.enginePanel.reveal', payload => revealPanelCard(hubs[1].groupHas(payload?.card) ? openSettings : openMain, payload?.card, hubs));
    // Адреса блоков для ссылок гида: `ui.anchors.list` / `ui.reveal({ anchor })` — панель и экран настроек принадлежат этому файлу.
    createAnchorNavigator(engine.registerCaller('core.ui.anchors', 'cores', { tier: 'official' }), {
        document, hubs,
        roots: [{ root: () => panelUi.getRoot(), open: openMain, label: 'Panel' }, { root: () => enginePanel.settingsRoot(), open: openSettings, label: 'Settings' }],
    });

    window.STModuleEngineBeta = engine;
    console.info('[ST Module Engine (Beta)] Verification panel ready — open it from the floating launcher dock.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine (Beta)] Failed to start:', error); globalThis.__stmeBoot?.finish(); }
});
