import { wireEngine } from './harness/engine-wiring.js';
import { createFullScreenPanel } from './harness/full-screen-panel.js';
import { isMobileSurface } from './cores/ui/final-ui-android.js';
import { effect } from './cores/ui/reactive.js';
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
function addLauncherDock(panel, { openMemoryGraphPanel, openSettingsPanel, toggleMain, requestModuleHud, activityState, memoryGraphPanel, picturePanel } = {}) {
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
            <!-- Кнопка-картинка: только ВИД, функционала пока нет (решено с
                 пользователем: «добавь кнопку с видом картинки, пока без
                 функционала»). Клик честно ничего не делает — обработчика нет.
                 Обязана быть в :not()-цепочке селектора главной кнопки ниже,
                 иначе клик по ней тумблерил бы панель движка. -->
            <button type="button" class="stme-launcher-dock-btn stme-launcher-dock-btn-image" title="Picture">
                <i class="fa-solid fa-image fa-fw"></i>
            </button>
            <button type="button" class="stme-launcher-dock-btn stme-launcher-dock-btn-settings" title="Open engine settings" data-i18n="[title]Open engine settings">
                <i class="fa-solid fa-gear fa-fw"></i>
            </button>
        </div>`;
    // Graph и Music в доке — тоже ТУМБЛЕРЫ (решено с пользователем: «с
    // музыкой и графом сделай также, чтобы закрывались»). Граф умеет
    // show()/hide()/isVisible() — переключаем по его собственному ответу;
    // Music идёт через GENERIC requestHud(id) Раннера, который сам стал
    // тумблером (engine-wiring.js).
    const toggleGraph = () => {
        if (memoryGraphPanel?.isVisible?.()) { memoryGraphPanel.hide(); return; }
        openMemoryGraphPanel?.();
    };
    // Кнопка-картинка — тумблер Плавающего окна «Картинка» (тот же контракт,
    // что у графа выше: show()/hide()/isVisible(), окно ведёт себя как у
    // музыки/трекера, только крупнее — дефолт 3:4).
    const togglePicture = () => {
        if (picturePanel?.isVisible?.()) { picturePanel.hide(); return; }
        picturePanel?.show();
    };
    zone.querySelector('.stme-launcher-dock-btn:not(.stme-launcher-dock-btn-graph):not(.stme-launcher-dock-btn-music):not(.stme-launcher-dock-btn-settings):not(.stme-launcher-dock-btn-image)').addEventListener('click', () => (toggleMain ?? (() => panel.toggle()))());
    zone.querySelector('.stme-launcher-dock-btn-graph').addEventListener('click', toggleGraph);
    zone.querySelector('.stme-launcher-dock-btn-image').addEventListener('click', togglePicture);
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
    // СТАТИЧНАЯ DOM-полоска (::before в panel.css, градиент + свечение на
    // переменной --stme-light): Ядро кладёт класс stme-light-<state> на ЗОНУ
    // (cores/ui/activity-light-dom.js), CSS перекрашивает переменную обычным
    // transition. Никакого бесконечного animation и никакого canvas:
    // канвас-версия (activity-light-canvas.js) по замерам всё равно красила
    // пол-окна каждый кадр — в этом окружении любой canvas в DOM инвалидирует
    // paint вверх по дереву (живые замеры 09.09–11.09).
    if (activityState) {
        createActivityLightDom(zone, activityState);
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
    const { engine, panelUi, selfUpdate, memoryGraphPanel, picturePanel, activityLight, modules, enginePanel, firstLoad, firstLoadResult, uiEngine } = await wireEngine({
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
    addLauncherDock(panel, {
        openMemoryGraphPanel: () => memoryGraphPanel.show(),
        openSettingsPanel: toggleSettings,
        requestModuleHud: id => modules.requestHud(id),
        activityState: activityLight.state,
        memoryGraphPanel,
        picturePanel,
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
