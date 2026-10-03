import { createSyncCore } from '../../cores/sync/index.js';
import { createStartupCore } from '../../cores/startup/index.js';
import { createBackgroundsCore } from '../../cores/backgrounds/index.js';
import { createMusicServerCore } from '../../cores/music-server/index.js';
import { createGlAnimationsCore } from '../../cores/ui/gl-animations.js';
import { createPromptManagerPanelCore } from '../../cores/ui/prompt-manager-panel.js';
import { createFirstLoadCore, FIRST_LAUNCH_EVENT } from '../../cores/first-load/index.js';
import { createUiEngineCore } from '../../cores/ui/ui-engine.js';
import { createFinalUiPc } from '../../cores/ui/final-ui-pc.js';
import { createFinalUiAndroid, isMobileSurface } from '../../cores/ui/final-ui-android.js';
import { createUiModulesCore } from '../../cores/ui/ui-modules.js';
import { createNotificationsCore } from '../../cores/ui/notifications.js';
import { createActivityLightCore } from '../../cores/ui/activity-light.js';
import { createMessageFooterCore } from '../../cores/ui/message-footer.js';
import { createChatViewportCore } from '../../cores/ui/chat-viewport.js';
import { createInputBarCore } from '../../cores/ui/input-bar/index.js';
import { createHomeCore } from '../../cores/ui/home/index.js';
import { createMemoryGraphPanelCore } from '../../cores/ui/memory-graph-panel.js';
import { createPicturePanelCore } from '../../cores/ui/picture-panel.js';
import { MUSIC_SERVER, BACKGROUNDS_REPO } from './config.js';

/** Интерфейс: Ядро UI, окна (граф, Prompt Manager, картинка), уведомления, фоны, синхронизация, лента чата, поле ввода, домашний экран. Получает общий контекст сборки (`ctx`), возвращает то, что создал. */
export async function wireUiCores(ctx) {
    const { engine, eventsCore } = ctx;

    const uiHost = engine.registerCaller('core.ui.engine', 'cores', { tier: 'official' });
    // Один и тот же поток патчей — разные финальные рендереры по платформе
    // (CORES.md): на мобильной поверхности работает Android-ядро, чей корень
    // несёт `stme-android` и на которую CSS отвечает компактной вёрсткой.
    const createFinalUi = isMobileSurface() ? () => createFinalUiAndroid(uiHost) : () => createFinalUiPc(uiHost);
    const uiEngine = createUiEngineCore(createFinalUi);

    // Визуальный редактор графа памяти — своё `official`-Ядро, свой
    // floating-корень через `uiEngine.mount()`, тем же способом, что
    // notifications/updateOverlay ниже (решено с пользователем: большое
    // окно, не секция общей панели настроек). `core.memoryGraph` и
    // `core.ui.memoryGraph` оба в домене `cores` — Ядро↔Ядро остаётся на
    // ОДНОЙ Шине, контракты `memoryGraph.*` достижимы через `host.own`
    // самого Ядра UI без Гейта.
    const memoryGraphPanel = createMemoryGraphPanelCore(
        engine.registerCaller('core.ui.memoryGraph', 'cores', { tier: 'official' }),
        { mount: node => uiEngine.mount('memoryGraph', node) },
    );

    // Prompt Manager: своё плавающее окно, открывается иконкой ST «AI Response Configuration», перехваченной
    // сервисом (services/st-pm-ui.js) — родная панель ST под ней не открывается вообще (ROADMAP.md 5.141).
    const promptManagerPanel = createPromptManagerPanelCore(
        engine.registerCaller('core.ui.promptManager', 'cores', { tier: 'official' }),
        { mount: node => uiEngine.mount('promptManager', node) },
    );

    // Плавающее окно «Картинка» — та же форма официального UI-Ядра, что у
    // окна графа выше (решено с пользователем: кнопка дока с видом картинки
    // получает РАСШИРЯЕМУЮ плавающую панель, как у музыки/трекера, только
    // крупнее — дефолт 3:4). Показывает перетащенный файл или картинку по
    // ссылке; ссылка идёт ПОЛНЫМ МАРШРУТОМ: сетевой Гейт → Сервис HTTP —
    // поэтому `networkAccess: true` (не подразумевается уровнем доверия).
    const picturePanel = createPicturePanelCore(
        engine.registerCaller('core.ui.picture', 'cores', { tier: 'official', networkAccess: true }),
        { mount: node => uiEngine.mount('picture', node) },
    );
    // У Модулей СВОЙ реестр UI, отдельный от слотов движка: у каждого
    // включённого Модуля свой независимый Final UI, иначе пути их деревьев
    // столкнулись бы в одной карте (см. ui-mount-registry.js).
    const uiModulesHost = engine.registerCaller('core.ui.modules', 'cores', { tier: 'official' });
    const uiModules = createUiModulesCore(() => createFinalUiPc(uiModulesHost));

    // Уведомления — отдельное UI-Ядро: у поверхности есть свой жизненный цикл
    // (очередь, автоснятие), а значит это не слот. Своя цель монтирования,
    // потому что стек висит в углу ЭКРАНА, а не внутри панели.
    const notifications = createNotificationsCore(
        engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }),
        // Логика (очередь, автоснятие) — в самом Ядре; МЕСТО ему даёт обычный
        // именованный слот Ядра UI для Engine, как и панели. Своего механизма
        // монтирования заводить незачем.
        { mount: node => uiEngine.mount('notifications', node) },
    );

    // Светофор активности: слушает события начала/конца работы ВСЕХ Ядер
    // (генерация, трекинг, саммари, самообновление) и уведомлений, сводит их
    // в одно состояние — а полоску пилюли-дока красит по нему index.js
    // (пилюля живёт мимо движка, поэтому ей отдаётся сам сигнал).
    // Ядро WebGL-анимаций: общий цикл кадров и реестр маленьких эффектов (см. cores/ui/gl-animations.js).
    const glAnimations = createGlAnimationsCore(engine.registerCaller('core.ui.glAnimations', 'cores', { tier: 'official' }));
    // Фоны из отдельного репозитория: единственное ещё Ядро с правом выхода в сеть (как самообновление).
    const backgrounds = createBackgroundsCore(
        engine.registerCaller('core.backgrounds', 'cores', { tier: 'official', networkAccess: true }),
        { ...BACKGROUNDS_REPO, publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.backgrounds' }) },
    );
    // Разделы и векторы треков с музыкального сервера владельца: единственное, что Music берёт из сети (аудио потом тянет плеер по прямой ссылке).
    const musicServer = createMusicServerCore(engine.registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server: MUSIC_SERVER });
    // Синхронизация файлов между устройствами (напрямую по WebRTC) и с репозиторием GitHub. Запускается из index.js вместе с фонами.
    const syncCore = createSyncCore(
        engine.registerCaller('core.sync', 'cores', { tier: 'official', networkAccess: true }),
        { publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.sync' }) },
    );
    // Порядок запуска (самообновление → фоны → синхронизация → экран загрузки) — контрактами, не ссылками; вызывается из index.js.
    const startup = createStartupCore(
        engine.registerCaller('core.startup', 'cores', { tier: 'official' }),
        { screen: globalThis.__stmeBoot },
    );
    const activityLight = createActivityLightCore(
        engine.registerCaller('core.ui.activityLight', 'cores', { tier: 'official' }),
    );
    activityLight.load();

    // First Load — счётчик запусков движка. Само Ядро НЕ вызывает свой
    // `load()` на конструкции: инкремент выполняется ниже, СТРОГО после
    // восстановления конфигурации (см. comment у `Promise.all`), иначе
    // «первый запуск» объявился бы раньше, чем на диске вообще что-то есть.
    // Событие `firstLoad.firstLaunch` — подписка index.js'а на начало
    // онбординга; само Ядро про UI не знает.
    const firstLoad = createFirstLoadCore(
        engine.registerCaller('core.firstLoad', 'cores', { tier: 'official' }),
        { publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.firstLoad' }) },
    );
    void FIRST_LAUNCH_EVENT; // экспортируется наружу для подписчиков (см. return)

    // Полоса под последним сообщением: три независимых виджета, во всю ширину
    // чата. Модель её не видит вовсе — она живёт только в DOM.
    const messageFooterHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    const messageFooter = createMessageFooterCore(messageFooterHost, {
        createFinalUi: () => createFinalUiPc(messageFooterHost),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.messageFooter' }),
    });

    // Chat Viewport — гибридный WebGL/DOM рендер истории чата (план
    // `chat-viewport`): тело сообщения растеризуется в текстуру, действия
    // (delete/swipe/regenerate/edit) идут через `services/st-chat.js`'ы
    // обёртки над экспортированными функциями самой ST. Ядро строится, но
    // `attach()` не зовётся здесь — только по кнопке в харнессе (main.js),
    // чтобы можно было сравнить с нативным `#chat` рядом, а не подавлять его
    // безусловно на загрузке страницы.
    const chatViewportHost = engine.registerCaller('core.ui.chatViewport', 'cores', { tier: 'official' });
    const chatViewport = createChatViewportCore(chatViewportHost, {
        prerenderFactor: 4,
        textureBudgetBytes: 256 * 1024 * 1024, prefetchScreens: 3, prefetchConcurrency: 10, persistentCache: true,
        createFinalUi: () => createFinalUiPc(chatViewportHost),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.chatViewport' }),
    });

    // Собственная панель набора текста и левый док: включаются вместе с оверлеем Chat Viewport (карточка панели зовёт enable/disable).
    const inputBarHost = engine.registerCaller('core.ui.inputBar', 'cores', { tier: 'official' });
    const inputBar = createInputBarCore(inputBarHost, {
        touch: isMobileSurface(),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.inputBar' }),
    });

    // Главный экран из блоков вместо стартового экрана ST: включается вместе с Chat Viewport (карточка панели зовёт enable/disable).
    const home = createHomeCore(engine.registerCaller('core.ui.home', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.home' }),
        // Виджет рабочего стола получает СВОЮ личность на Шине модулей с правами из его описания — Гейт проверяет его, как любой Модуль.
        touch: isMobileSurface(),
        registerWidgetCaller: (widgetId, allowedContracts) => engine.registerCaller(`widget.${widgetId}`, 'modules', { tier: 'community', allowedContracts }),
    });


    return { uiHost, createFinalUi, uiEngine, memoryGraphPanel, promptManagerPanel, picturePanel, uiModulesHost, uiModules, notifications, glAnimations, backgrounds, musicServer, syncCore, startup, activityLight, firstLoad, messageFooterHost, messageFooter, chatViewportHost, chatViewport, inputBarHost, inputBar, home };
}
