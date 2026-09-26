import { createUiMountRegistry } from '../../../libraries/shared/ui-mount-registry.js';

/**
 * Общий контекст Ядра Chat Viewport. Одно Ядро = один активный чат-вьюпорт (несколько одновременных вьюпортов вне
 * сегодняшнего плана), поэтому всё состояние живёт в ОДНОМ объекте `ctx`, а модули этого каталога (`install*`)
 * получают его и вешают на него свои функции — вместо одного замыкания на 1900 строк.
 *
 * `ctx.s` — ИЗМЕНЯЕМЫЕ скаляры и ссылки (переприсваиваются), модули читают/пишут их как `s.имя`.
 * Остальные поля `ctx` — неизменяемые: опции, карты-кэши (их только наполняют/чистят) и вызовы Сервисов.
 * Функции других модулей берутся ЛЕНИВО как `ctx.имя(...)` в момент вызова — порядок `install*` тогда неважен.
 *
 * ВСЁ, что касается layout/скролла/измерений (`viewportWidth/Height`, `scrollTop`, `heights`) — ЛОГИЧЕСКИЕ CSS-пиксели,
 * ровно то, что естественно возвращают `dom.measureRect`/скролл браузера. `devicePixelRatio` умножает их ТОЛЬКО в
 * двух местах (backing store канваса и цель растеризации) — иначе на экране с DPR > 1 текст растеризуется в меньшем
 * разрешении, чем экран может показать, и выглядит пиксельным при апскейле GPU.
 */
export function createChatViewportContext(host, {
    publish, rowHeight, overscan, prerenderFactor, textureBudgetBytes, prefetchScreens, prefetchConcurrency, persistentCache,
    getDevicePixelRatio, createFinalUi, copyText,
}) {
    const s = {
        canvas: null, mirrorContainer: null, chromeContainer: null, css: '',
        viewportWidth: 0, viewportHeight: 0, devicePixelRatio: 1, scrollTop: 0,
        // scrollTop, по которому построен ПОСЛЕДНИЙ закоммиченный кадр — панель сдвигает слой на разницу с живым scrollTop, пока не пришёл следующий кадр.
        renderedScrollTop: 0,
        enabled: true, attached: false,
        rendering: false, renderQueued: false, pendingFresh: false, settlePasses: 0,
        // Перерисовка вызвана ручным раскрытием/сворачиванием блока — рост высоты от неё НЕ повод автопрокручивать вниз.
        toggleRender: false,
        lastScrollAt: 0, fullPassTimer: null,
        snapshot: null,                    // снимок чата (сообщения, порядок, глифы) — пересобирается только по событиям изменения чата
        lastFrame: null,                   // данные последнего кадра для фонового префетча
        lastGlyphSpans: [],                // [{headerMesid, top, height}] последнего кадра — по ним панель действий находит глиф под курсором
        prefetchGen: 0, prefetchRunning: false, warmRunning: false,
        lastQuadsKey: null,
        dirtyMain: true,                   // на основном канвасе появилась новая текстура — кадр надо нарисовать даже при тех же квадах
        // Уровень 3: отдельный маленький канвас под тело ПОСЛЕДНЕГО сообщения — стрим перерисовывает только его.
        lastCanvas: null, lastCanvasSize: { w: 0, h: 0 }, lastQuadKeyL3: null, lastTransformL3: null, dirtyLast: true, lastBodyMesid: null,
        scrollVelocity: 0,                 // px/мс, со знаком (EMA) — направление и скорость прокрутки для упреждающей предзагрузки
        lastVelAt: 0,
        footerAttachTimer: null, footerAttachDirty: false,
        chromeReflowTimer: null,
        measureQueue: [], measureTimer: null,
        cssHashCache: { css: null, hash: '' },
        lastNeeded: new Set(),             // mesid'ы, для которых были загружены текстура+зеркало на ПРЕДЫДУЩЕМ render()
        lastNeededGlyphs: new Set(),       // headerMesid'ы глифов, чей фон был на экране на ПРЕДЫДУЩЕМ render()
        lastTotalHeight: 0,                // сумма высот ВСЕХ сообщений — для родного скроллбара обёртки в UI движка
        // Правка, начатая кнопкой в шапке глифа, когда строка финального сообщения ещё не смонтирована: применится, как только она появится.
        pendingEditMesid: null,
    };

    const ctx = {
        host, s,
        rowHeight, overscan, prerenderFactor, textureBudgetBytes, prefetchScreens, prefetchConcurrency, persistentCache, getDevicePixelRatio,
        publishEvent: publish ?? ((event, payload) => host.events.emit(event, payload)),
        chromeMounts: createFinalUi ? createUiMountRegistry(createFinalUi) : null,
        subscriptions: [],
        copyText,

        heights: new Map(),                // mesid -> измеренная высота (px)
        rasterizedText: new Map(),         // mesid -> ключ (заглушка+текст), на котором построена ТЕКУЩАЯ текстура/зеркало
        // mesid -> {width, height} — РЕАЛЬНЫЙ физический размер ТЕКСТУРЫ, возвращённый `htmlRasterizer.rasterize()` (уже округлённый ВНУТРИ
        // сервиса). Квад берёт ровно это число, а не пересчитывает `contentWidth() * devicePixelRatio` заново: при дробном DPR пересчёт давал
        // размер на пиксель шире текстуры, GPU растягивал её, `LINEAR` интерполировал край — лёгкий блюр/ореол вокруг текста.
        physicalTextureSize: new Map(),
        // mesid -> { el, html }: чем ПОСЛЕДНИЙ РАЗ заполнили `.stme-toolcall-body`. Без сравнения `ensureRowChrome()` переinject'ил бы HTML на КАЖДЫЙ
        // render(), включая тот, что вызвал `toggle`-обработчик: раскрытый `<details>` перезаписывался закрытым, и открытие сбрасывалось.
        toolCallHtmlWritten: new Map(),
        mirrors: new Map(),                // mesid -> DOM-узел зеркала
        rowStates: new Map(),              // mesid -> { position, content, editing, draft, editRect } — сигналы хрома
        chromeRoots: new Map(),            // mesid -> реальный корневой DOM-узел хрома (для forgetRowChrome)
        glyphHeadOf: new Map(),            // mesid -> mesid заголовка его глифа (обновляется в render())
        bodyImages: new Map(),             // mesid -> [{ src, x, y, width, height }] — картинки тела, показываются настоящим DOM поверх канваса
        imageLayers: new Map(),            // mesid -> { layer, root, key } — DOM-слой с этими картинками внутри хрома строки
        footerSlots: new Map(),            // mesid -> заглушка `.stme-chat-viewport-footer-slot` (для ui.messageFooter.setHostResolver)
        contentCols: new Map(),            // mesid -> `.stme-chat-viewport-content-col` (измеряется вместо `root` — см. ensureRowChrome())
        // mesid -> 'working'|'success'|'error' — полоска-светофор генерации. НАВСЕГДА, не по таймеру (в отличие от Activity Light, у которого те же
        // события гаснут в idle): запись живёт, пока жив экземпляр Ядра; чистится только сменой чата (`forgetAll`).
        genStatus: new Map(),
        glyphBgApplied: new Map(),         // headerMesid -> последний применённый стиль фона (top|width|height)
        rowPositionApplied: new Map(),     // mesid -> последняя применённая позиция строки хрома (y|width)
        glyphBgRoots: new Map(),           // headerMesid -> DOM-узел фона глифа
        bodyUse: new Map(),                // mesid -> порядок последнего использования тела (LRU: первый ключ — самый давний)
        syncInflight: new Map(),           // mesid -> { key, promise } — не растеризовать одно и то же дважды параллельно
        lastChromeHeight: new Map(),       // mesid -> последняя измеренная высота хрома (для оценки заглушки при предрастеризации)
        textureHome: new Map(),            // mesid -> канвас, на чей GL-контекст загружена текстура строки
        // mesid -> { sig, height, pad }: измеренная высота хрома строки. Меряется ТОЛЬКО когда изменилось содержимое/ширина/раскрытие —
        // раньше каждая видимая строка мерилась на КАЖДОМ кадре, и принудительная раскладка съедала ~46% главного потока при прокрутке.
        chromeHeightCache: new Map(),
        chromeObservers: new Map(),        // mesid -> { el, handler } — ResizeObserver за высотой хрома
        bodyHeights: new Map(),            // mesid -> последняя измеренная высота тела (нужна, когда тело пришло из постоянного кэша без зеркала)
        avatarScaled: new Map(),           // "url|dpr" -> { ready: blob-URL | null }
        skeletonPool: [],                  // заглушки строк, что ещё грузятся: пул <div> со «строчками текста» вместо пустого экрана
    };
    ctx.canvasHeight = () => Math.round(s.viewportHeight * prerenderFactor);
    ctx.canvasPad = () => Math.round(s.viewportHeight * (prerenderFactor - 1) / 2);
    return ctx;
}
