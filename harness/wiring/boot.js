import { createSyncToastsCore } from '../../cores/ui/sync-toasts.js';

/** Запуск: восстановление сохранённого, открытие окон и панели, подключение пайплайна генерации — строго в этом порядке. Получает общий контекст сборки (`ctx`), возвращает то, что создал. */
export async function wireBoot(ctx) {
    const { engine, late, eventsCore, modelsCore, diffusionCore, generationCore, promptManagerCore, macrosCore, trackingCore, speakerCore, mapCore, mapNarrationCore, lorebookCore, classifierCore, summaryCore, memoryGraphCore, memoryGraphPanel, promptManagerPanel, picturePanel, notifications, firstLoad, messageFooter, updateOverlay, modules, guide, enginePanel } = ctx;

    // Every Ядро is constructed by now (Settings Core included) — safe to
    // actually read back whatever was persisted last time.
    //
    // `lorebookCore.scan()` must FINISH before `memoryGraphCore.load()`
    // starts, not just be "in the same batch": its bootstrap
    // (`bootstrapFromLorebook()`) reads `lorebook.books()`/`.find()`/`.get()`,
    // which only see real data AFTER `scan()`'s own awaited I/O settles —
    // racing them in one `Promise.all` let the graph's read win sometimes,
    // silently leaving a real, non-empty Lorebook's graph bootstrap empty
    // (found live in the harness: `lorebook.find()` returned real entries
    // right after boot, but `memoryGraphCore.nodes()` stayed `[]`).
    await Promise.all([modelsCore.restoreWorkers().then(list => { modelsCore.startMonitoring(); return list; }), modelsCore.restorePresets(), diffusionCore.restoreWorkers(), trackingCore.restoreTrackers(), macrosCore.restorePrograms(), speakerCore.restore(), mapCore.restore(), mapNarrationCore.load(), lorebookCore.scan(), classifierCore.load(), summaryCore.load(), promptManagerCore.load()]);
    // `memoryGraphCore.load()` сама больше НЕ ждёт бутстрап из Lorebook
    // (решено с пользователем: "зависание при bootstrap... вынеси его
    // отдельно" — при большом Lorebook эмбединг каждой записи по
    // отдельности реально долгий, и этот один `await` держал весь движок,
    // включая панель и докер запуска). `load()` сама возвращается быстро
    // (настройки+состояние+регистрация этапов пайплайна), бутстрап уходит
    // в фон — см. `memoryGraphCore.waitForBootstrap()`'s doc-comment в
    // `cores/memory-graph/index.js`, если где-то ДЕЙСТВИТЕЛЬНО нужно
    // дождаться его результата (а не просто не блокировать остальных).
    await memoryGraphCore.load();

    // Инкремент счётчика запусков — после того как ВСЯ конфигурация на диске
    // восстановлена: событие `firstLoad.firstLaunch` обязано прийти к
    // подписчикам, когда движок уже цел (панель открыта ниже, модули
    // восстановлены) — онбординг стартует на живом движке, а не на пустом.
    const firstLoadResult = await firstLoad.load();

    // Панель монтируется здесь же, а не у вызывающего: реестру Модулей нужно
    // уметь дождаться её перерисовки, чтобы положить дерево Модуля в слот.
    // Строго ПОСЛЕ восстановления: панель читает конфигурацию один раз при
    // открытии, и смонтируй мы её раньше — она честно показала бы пустоту,
    // хотя настройки на диске есть. Ровно это и случилось при первой попытке.
    late.panelUi = await enginePanel.open();
    await late.panelUi.settled();

    // Состав Модулей — СТРОГО после панели: Модулю нужен слот, а слот рисует
    // панель. До этого включённые Модули просто не переживали перезагрузку.
    await modules.restore();

    await messageFooter.start();

    // Тосты синхронизации: ход и итог — нашими плавающими плашками (Ядро уведомлений), не родными уведомлениями ST.
    createSyncToastsCore(engine.registerCaller('core.ui.syncToasts', 'cores', { tier: 'official' }), {
        isBootActive: () => Boolean(globalThis.__stmeBoot) && !globalThis.__stmeBoot.isClosed(),
    });
    const notificationsUi = notifications.open();
    await notificationsUi.settled();
    document.body.append(notificationsUi.getRoot());

    // Тоже на BODY, а не в панель: перекрытие относится ко всей странице, а
    // полоса обязана быть видна и при свёрнутой панели.
    const updateOverlayUi = updateOverlay.open();
    await updateOverlayUi.settled();
    document.body.append(updateOverlayUi.getRoot());

    // Корень должен быть в ЖИВОМ документе ДО activate() — та ленивым
    // эффектом ищет `#stme-memory-graph-canvas` через `document.getElementById`,
    // который ничего не находит в отсоединённом дереве.
    const memoryGraphPanelUi = await memoryGraphPanel.open();
    document.body.append(memoryGraphPanelUi.getRoot());
    memoryGraphPanel.activate();

    // Окно «Картинка» — тот же порядок, что у графа выше: open() (дерево +
    // loadWindowState), append корня в body после settled(), активации (CSS-
    // инициализации) у окна нет — содержимого пока нет.
    const promptManagerPanelUi = await promptManagerPanel.open();
    document.body.append(promptManagerPanelUi.getRoot());
    const picturePanelUi = await picturePanel.open();
    document.body.append(picturePanelUi.getRoot());
    await guide.load();
    const guideUi = await guide.mountWindow();
    document.body.append(guideUi.getRoot());

    // Слух движка включается ПОСЛЕ восстановления конфигурации: иначе
    // событие ST могло бы прилететь трекеру, которого ещё нет.
    await eventsCore.bridge();

    // И только теперь движок забирает себе саму отправку. Строго последним:
    // с этого момента генерация ST физически идёт через нас, и делать это до
    // того, как вкладчики восстановлены, значило бы держать первую генерацию
    // ради ещё не собранного пайплайна.
    await generationCore.install();

    return { firstLoadResult, notificationsUi, updateOverlayUi, memoryGraphPanelUi, promptManagerPanelUi, picturePanelUi, guideUi };
}
