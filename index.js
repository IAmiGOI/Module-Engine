import './harness/boot-start.js';
import { wireEngine } from './harness/engine-wiring.js';
import { createFullScreenPanel } from './harness/full-screen-panel.js';
import { isMobileSurface } from './cores/ui/final-ui-android.js';
import { createLauncherDockCore } from './cores/ui/launcher-dock.js';
import { createActivityLightDom } from './cores/ui/activity-light-dom.js';
import { h } from './cores/ui/tree.js';
import { createEdgeDrag } from './libraries/shared/edge-drag.js';
import { FloatingPanel, Button } from './libraries/shared/widgets.js';

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
 * Онбординг, шаг 1 — ТОЛЬКО сцена (решено с пользователем: содержимое окна
 * придёт с настоящим сценарием, сейчас внутри пусто).
 *
 * Состав:
 *  - Затемнение — ЖИДКОЕ СТЕКЛО, как у обновляющего оверлея (`stme-overlay`):
 *    страница видна сквозь blur, работать с ней нельзя. Не глухая заливка —
 *    Alpha делала так, и страница «исчезала», а не «стеклилась».
 *  - Окно — БИБЛИОТЕЧНЫЙ `FloatingPanel` (не ручная сборка): своего
 *    модального виджета у библиотеки нет, а плавающее окно — ближайший
 *    готовый контейнер. Пусто внутри, размер — «примерно 1/5 экрана»:
 *    задан в CSS (`stme-onboarding-window`).
 *
 * Рендер — через `uiEngine.mount('onboarding', …)`, НЕ ручной DOM:
 * `FloatingPanel` возвращает абстрактное дерево (`h()`, cores/ui/tree.js), и
 * только рендер Финального UI превращает его в элементы — как это делают
 * memory-graph-panel и update-overlay. Слоту сцены (затемнение) хватает
 * обычного `document.createElement`: дерево у нас одно, и оно идёт в слот.
 *
 * Закрытия здесь НЕТ намеренно: без содержимого сценария закрывать нечего,
 * а случайный клик мимо окна сорвал бы первый контакт. Снять сцену можно
 * из консоли (`window.STModuleEngineBetaOnboarding.close()`) или она уйдёт
 * вместе со страницей при перезагрузке — счётчик уже посчитан, сцена второй
 * раз не покажется.
 */
async function showOnboardingIntro(uiEngine) {
    if (document.getElementById('stmeBetaOnboarding')) return;
    const scene = document.createElement('div');
    scene.id = 'stmeBetaOnboarding';
    scene.className = 'stme-onboarding';
    document.body.append(scene);
    window.STModuleEngineBetaOnboarding = {
        close: () => { uiEngine.unmount('onboarding'); scene.remove(); },
        /**
         * Следующий шаг сценария: перемонтирует окно в ТОМ ЖЕ слоте
         * `onboarding` (mount сам сносит предыдущее дерево — реестр держит
         * один ключ = одно дерево) и подменяет корень в сцене на НОВЫЙ:
         * mount() создаёт свежий Final UI со СВОИМ корнем, и без подмены
         * в сцене остался бы висеть старый, уже отсоединённый узел — ровно
         * «Yes не переключает шаг», поймано живьём. Сцена-затемнение при
         * этом не трогается: мигания стекла между шагами нет. Рендер
         * асинхронный (тот же Гейт-очередной путь), поэтому подмена —
         * после settled.
         */
        showStep: tree => {
            const finalUi = uiEngine.mount('onboarding', h('div', { class: 'stme-onboarding-window' }, tree));
            void finalUi.settled().then(() => {
                scene.replaceChildren(finalUi.getRoot());
            });
        },
        /** Открыватель основной панели — вставляет init() после его создания. */
        openMain: null,
    };
    const finalUi = uiEngine.mount('onboarding', h('div', { class: 'stme-onboarding-window' },
            FloatingPanel('ST Module Engine', { resizable: false },
                h('div', { class: 'stme-onboarding-question' },
                    h('strong', { class: 'stme-onboarding-question-text' }, 'Is this your first time using Module Engine?'),
                    h('div', { class: 'stme-onboarding-buttons' },
                        Button('Yes', () => showOnboardingStepApi()),
                        Button('No', () => window.STModuleEngineBetaOnboarding.close()),
                    ),
                ),
            ),
        ));
    // Рендер Финального UI — ASYNC (каждый DOM-примитив идёт через Гейт и
    // обрабатывается очередью по одному), корень появляется НЕ сразу.
    // `scene.append(finalUi.getRoot())` до settled вставлял бы literal
    // `null` (append приводит аргумент к строке) — ровно «null вместо
    // окна», поймано живьём. Ждём, пока дерево реально применено.
    await finalUi.settled();
    scene.append(finalUi.getRoot());
    // Плавное появление: класс ставится СЛЕДУЮЩИМ кадром, иначе transition
    // склеивается с моментом вставки и первый кадр рисуется уже непрозрачным.
    requestAnimationFrame(() => scene.classList.add('stme-onboarding-visible'));
}

/**
 * Шаг 2 сценария: вопрос об API-ключе Sidecar-модели.
 *
 * «Get one» открывает ссылку в НОВОЙ вкладке (`window.open(url, '_blank',
 * 'noopener')`) — пользователь не теряет окно онбординга, «noopener» не
 * даёт открытой странице дотянуться обратно до ST. Шаг следующий у всех
 * трёх кнопок общий (решено с пользователем: пока это просто следующее
 * окно, содержимое определится позже).
 */
function showOnboardingStepApi() {
    const API_REFERRAL_URL = 'https://nano-gpt.com/r/gXaqL9hY';
    window.STModuleEngineBetaOnboarding.showStep(
        FloatingPanel('ST Module Engine', { resizable: false },
            h('div', { class: 'stme-onboarding-question' },
                h('strong', { class: 'stme-onboarding-question-text' }, 'Do you have a separate API key for the Sidecar model?'),
                h('div', { class: 'stme-onboarding-buttons' },
                    Button('Yes', () => showOnboardingStepEnginePanel()),
                    Button('Local model', () => showOnboardingStepEnginePanel()),
                ),
                h('div', { class: 'stme-onboarding-buttons stme-onboarding-buttons-wide' },
                    Button('Get one', () => { window.open(API_REFERRAL_URL, '_blank', 'noopener'); showOnboardingStepEnginePanel(); }),
                ),
            ),
        ),
    );
}

/** Финальный шаг (содержимое ещё не задано пользователем) — заглушка-окно. */
function showOnboardingStepFinal() {
    window.STModuleEngineBetaOnboarding.showStep(
        FloatingPanel('ST Module Engine', { resizable: false },
            h('div', { class: 'stme-onboarding-question' },
                h('strong', { class: 'stme-onboarding-question-text' }, 'TODO: next step.'),
            ),
        ),
    );
}

/**
 * Шаг 3: основное меню движка с подсветкой вкладки моделей.
 *
 * Каркас:
 *  1. ОКНО онбординга закрывается ВМЕСТЕ со сценой-стеклом: сцена (9100)
 *    выше панели движка (6000) и накрыла бы её целиком вторым слоем блюра.
 *    Затемнение вокруг подсвечиваемой карточки даёт сам прожектор.
 *  2. Открывается основная панель движка (openMain из init(): тот
 *    full-screen оверлей, что и по кнопке дока).
 *  3. Поверх неё — «прожектор»: стекло с ДЫРКОЙ ровно над карточкой «Model
 *    connections». Дырка собирается из ЧЕТЫРЁХ сегментов (над, под, слева и
 *    справа от карточки) — проще и надёжнее mask/box-shadow по
 *    viewport-координатам. Позиция карточки читается из ЖИВОГО DOM
 *    (`getBoundingClientRect` — тот же приём, что у edge-drag), поэтому слой
 *    ставится после rAF: панель к этому кадру уже отрисована.
 *  4. Карточка под дыркой пульсирует той же обводкой, что кнопка «Test»
 *    подключения (keyframes stme-pulse).
 */
function showOnboardingStepEnginePanel() {
    const openMain = window.STModuleEngineBetaOnboarding.openMain;
    window.STModuleEngineBetaOnboarding.close(); // окно И сцена ушли
    openMain?.(); // основная панель — теперь самый верхний слой
    // Прожектор ставим ПОСЛЕ того, как панель реально отрисуется: карточку
    // ищем в живом DOM, на ещё не смонтированном дереве её нет.
    requestAnimationFrame(() => {
        const panelRoot = document.querySelector('.stmeBeta-fullscreen:not([hidden])');
        const card = [...(panelRoot?.querySelectorAll('.stme-card') ?? [])]
            .find(node => node.querySelector('.stme-card-title')?.textContent.includes('Model connections'));
        if (!card) return; // панель не нашлась — онбординг просто не подсветит, не падает
        card.classList.add('stme-spotlight-target');
        const box = card.getBoundingClientRect();
        // Дырка БОЛЬШЕ карточки: пульсация (`stme-pulse`) расходится
        // box-shadow'ом ЗА пределы карточки — впритык стекло съедало
        // внешние кольца свечения, поймано живьём. Запас — радиус карточки
        // + чуть сверху на шапку.
        const pad = 18;
        const top = Math.max(0, box.top - pad);
        const left = Math.max(0, box.left - pad);
        const right = Math.min(window.innerWidth, box.right + pad);
        const bottom = Math.min(window.innerHeight, box.bottom + pad);
        const hole = document.createElement('div');
        hole.className = 'stme-onboarding-spotlight';
        // ЧЕТЫРЕ сегмента стекла вокруг дырки: сверху (вся ширина), снизу
        // (вся ширина), слева и справа (только высота дырки).
        const part = styles => { const el = document.createElement('div'); el.className = 'stme-onboarding-spotlight-part'; Object.assign(el.style, styles); hole.append(el); };
        part({ top: 0, left: 0, right: 0, height: `${top}px` });
        part({ top: `${bottom}px`, left: 0, right: 0, bottom: 0 });
        part({ top: `${top}px`, height: `${bottom - top}px`, left: 0, width: `${left}px` });
        part({ top: `${top}px`, height: `${bottom - top}px`, left: `${right}px`, right: 0 });
        document.body.append(hole);
        // Клик по карточке — стекло прожектора убирается, пульсация
        // остаётся: пользователь «вошёл» в подсвеченное, блюр больше не
        // нужен, но точка внимания помечается до конца шага.
        card.addEventListener('click', () => { hole.remove(); }, { once: true });
        // Пульсация живёт ДО ПЕРВОГО теста модели: клик по «Test» (кнопка
        // у каждогоconnection своя) снимает `stme-spotlight-target`.
        // Делегирование по КАРТОЧКЕ, а не по кнопкам: ряды воркеров
        // перерисовываются (EditableList), прямые слушатели терялись бы на
        // каждой перерисовке. Если пользователь ушёл не туда — безопасно:
        // пульсация просто остаётся.
        card.addEventListener('click', event => {
            const button = event.target?.closest?.('button.menu_button');
            if (button && button.textContent.trim() === 'Test') card.classList.remove('stme-spotlight-target');
        });
        window.STModuleEngineBetaOnboarding.closeSpotlight = () => { hole.remove(); card.classList.remove('stme-spotlight-target'); };
    });
}

async function init() {
    // `scriptUrl` — адрес ИМЕННО этого файла: из него берётся имя папки
    // расширения, которого ждут git-эндпоинты ST. Передаём явно, потому что
    // сборщик движка лежит в другой папке, и его собственный `import.meta.url`
    // дал бы не то имя.
    const { engine, panelUi, startup, memoryGraphPanel, picturePanel, activityLight, modules, enginePanel, firstLoad, firstLoadResult, uiEngine } = await wireEngine({
        getContext,
        fetch: window.fetch.bind(window),
        scriptUrl: import.meta.url,
    });

    // Первый запуск движка — `firstLoad` уже посчитал запуски и (при счётчике
    // 0 → 1) объявил событие `firstLoad.firstLaunch` ещё внутри wireEngine().
    void firstLoad;
    void firstLoadResult;

    // Онбординг, шаг 1 (решено с пользователем: сценарий ещё не написан,
    // пока показывается ТОЛЬКО сцена): затемнение страницы жидким стеклом
    // и пустое окно среднего размера по центру. Показывается ТОЛЬКО при
    // самом первом запуске (счётчик 0 → 1). Содержимое окна придёт вместе
    // с настоящим сценарием.
    if (firstLoadResult?.firstLaunch) { void showOnboardingIntro(uiEngine); }

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
    // Взаимное исключение (решено с пользователем: «если открыты настройки и
    // ты открываешь основную панель — они накладываются друг на друга. Я
    // хочу, чтобы они переключались»): оба оверлея — фиксированные слои на
    // body, и открытие одного ДОЛЖНО закрывать другой, иначе они честно
    // лежат друг на друге (тот, кто открыт последним, просто ниже по DOM).
    // `toggle()` у основной панели тоже проходит через это переключение:
    // клик по кнопке дока — самый частый путь, и он обязан гасить настройки.
    const openMain = () => { settingsPanel.close(); panel.open(); };
    // Онбординг (шаг 3) открывает основную панель этой же функцией: объект
    // онбординга создаётся в showOnboardingIntro(), поэтому открыватель
    // вставляется ЗДЕСЬ, после создания, а не в момент создания окна.
    if (window.STModuleEngineBetaOnboarding) window.STModuleEngineBetaOnboarding.openMain = openMain;
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

    window.STModuleEngineBeta = engine;
    console.info('[ST Module Engine (Beta)] Verification panel ready — open it from the floating launcher dock.');
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Module Engine (Beta)] Failed to start:', error); globalThis.__stmeBoot?.finish(); }
});
