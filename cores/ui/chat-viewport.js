import { createChatViewportContext } from './chat-viewport/state.js';
import { installCalls } from './chat-viewport/calls.js';
import { installSkeletons } from './chat-viewport/skeletons.js';
import { installChromeWatch } from './chat-viewport/chrome-watch.js';
import { installMeasure } from './chat-viewport/measure.js';
import { installRowHelpers } from './chat-viewport/row-helpers.js';
import { installRowTree } from './chat-viewport/row-tree.js';
import { installRowChrome } from './chat-viewport/row-chrome.js';
import { installGlyphBg } from './chat-viewport/glyph-bg.js';
import { installBodyCache } from './chat-viewport/body-cache.js';
import { installBodySync } from './chat-viewport/body-sync.js';
import { installBodyImages } from './chat-viewport/body-images.js';
import { installLastCanvas } from './chat-viewport/last-canvas.js';
import { installPrefetch } from './chat-viewport/prefetch.js';
import { installGenerationStatus } from './chat-viewport/generation-status.js';
import { installRenderSnapshot } from './chat-viewport/render-snapshot.js';
import { installRenderRow } from './chat-viewport/render-row.js';
import { installRenderCommit } from './chat-viewport/render-commit.js';
import { installRender } from './chat-viewport/render.js';
import { installMessageTools } from './chat-viewport/message-tools.js';
import { installLifecycle } from './chat-viewport/lifecycle.js';
import { DEFAULT_ROW_HEIGHT, DEFAULT_OVERSCAN } from './chat-viewport/constants.js';

/**
 * Ядро Chat Viewport — гибридный рендер истории чата поверх ST (см. план
 * `chat-viewport`): тело каждого видимого сообщения растеризуется из
 * настоящего HTML ST (`stChat.formatMessage`) в WebGL-текстуру
 * (`services/html-rasterizer.js` → `services/webgl-renderer.js`), а не
 * рисуется своим text-layout движком. `context.chat` остаётся ЕДИНСТВЕННЫМ
 * источником истины — это Ядро только читает его через `services/st-chat.js`
 * и точечно пишет туда же (`deleteMessage`/`swipe`/`regenerate`/`setText`),
 * теми же контрактами, что уже существуют.
 *
 * **Невидимое DOM-зеркало — не просто ради выделения текста/Ctrl+F,
 * оно ЕЩЁ и единственный надёжный источник реальной высоты строки.**
 * Открытие в процессе реализации: пытаться заранее угадать высоту
 * растеризованной текстуры (а не измерить), а затем растеризовать ПОД эту
 * оценку — обратный порядок причины и следствия: настоящая высота известна
 * только после того, как HTML реально положили в документ и браузер сделал
 * layout. Зеркало (`dom.setInnerHtml` в скрытый узел, класс которого держит
 * его вне потока документа, но не `display:none` — иначе `getBoundingClientRect`
 * вернул бы ноль) даёт эту высоту через `dom.measureRect` БЕСПЛАТНО, тем же
 * проходом, что уже нужен для доступности/выделения — а не гадает её и не
 * подгоняет задним числом.
 *
 * **Три рубежа защиты от "перерисовки, о которой никто не сообщил"** — тот
 * же принцип, что у [message-footer.js](message-footer.js): (1) события ST
 * (`REDRAW_EVENTS` ниже, плюс `st.streamTokenReceived` — специально
 * размостированное для этого Ядра явно, см. wiring), (2) `render()`
 * идемпотентен — вызвать его повторно вхолостую безопасно, (3) `attach()`/
 * `render()` не предполагают, что предыдущий вызов вообще случился.
 *
 * **`getContext().deleteMessage` требует, чтобы нативный `.mes[mesid]`
 * СУЩЕСТВОВАЛ в DOM** (подтверждено чтением реального исходника ST, см. doc-
 * comment `services/st-chat.js`'s `deleteMessage`) — поэтому подавление
 * нативного `#chat` (`setEnabled`) обязано быть CSS-скрытием, а не удалением
 * узла из документа. Это Ядро само `#chat` не создаёт и не удаляет — только
 * переключает класс на уже существующем контейнере.
 *
 * **Хром (аватарка/шапка/действия/рассуждения, widgets.js) — обычный
 * DOM-дерево `h()`, смонтированное ПОВЕРХ канваса**, не WebGL: тот же
 * `uiMountRegistry`, что у [message-footer.js](message-footer.js), один
 * независимый Final UI на `mesid`. Позиционирование — ЕДИНСТВЕННОЕ, что
 * меняется на каждый скролл, поэтому оно в СВОЁМ, отдельном от контента
 * сигнале (`state.position`): скролл не должен пересобирать дерево
 * шапки/кнопок, только сдвигать `transform: translateY(...)` — то самое,
 * что делает синхронизацию со скроллом дешёвой и не требующей layout (см.
 * [[feedback-no-animated-effects-reflow]]).
 */

/**
 * Реализация разложена по модулям `cores/ui/chat-viewport/` (каждый ≤300 строк): `state.js` собирает общий контекст,
 * `install*` вешают на него свои функции (см. doc-comment `state.js`). Здесь — только сборка, регистрация контрактов и
 * публичный объект.
 */
export function createChatViewportCore(host, {
    publish, rowHeight = DEFAULT_ROW_HEIGHT, overscan = DEFAULT_OVERSCAN, prerenderFactor = 1,
    // Бюджет памяти под растеризованные тела вне экрана (null — вытеснять сразу за окном, как раньше) и
    // дальность фоновой предрастеризации в высотах экрана (0 — выключена).
    textureBudgetBytes = null, prefetchScreens = 0, prefetchConcurrency = 3, persistentCache = false,
    getDevicePixelRatio = () => globalThis.devicePixelRatio || 1,
    createFinalUi,
    // Копирование текста сообщения (кнопка панели действий); по умолчанию — буфер обмена браузера.
    copyText,
} = {}) {
    const ctx = createChatViewportContext(host, {
        publish, rowHeight, overscan, prerenderFactor, textureBudgetBytes, prefetchScreens, prefetchConcurrency, persistentCache,
        getDevicePixelRatio, createFinalUi, copyText,
    });
    const { s } = ctx;

    // Порядок важен только для `installCalls` (остальные берут `serviceOrThrow`/`serviceOrNull`/`coreOrNull` при установке).
    for (const install of [
        installCalls, installSkeletons, installChromeWatch, installMeasure, installRowHelpers, installRowTree, installRowChrome,
        installGlyphBg, installBodyCache, installBodySync, installBodyImages, installLastCanvas, installPrefetch, installGenerationStatus,
        installRenderSnapshot, installRenderRow, installRenderCommit, installMessageTools, installRender, installLifecycle,
    ]) install(ctx);

    const unregisters = [
        host.own.register('chatViewport.attach', params => ctx.attach(params)),
        host.own.register('chatViewport.detach', () => ctx.detach()),
        host.own.register('chatViewport.setViewport', params => ctx.setViewport(params)),
        host.own.register('chatViewport.setEnabled', params => ctx.setEnabled(params)),
        host.own.register('chatViewport.deleteMessage', params => ctx.deleteMessage(params)),
        host.own.register('chatViewport.swipe', params => ctx.swipe(params)),
        host.own.register('chatViewport.regenerate', () => ctx.regenerate()),
        host.own.register('chatViewport.editMessage', params => ctx.editMessage(params)),
        host.own.register('chatViewport.visibleMesids', () => [...s.lastNeeded]),
        host.own.register('chatViewport.totalHeight', () => s.lastTotalHeight),
    ];

    return {
        attach: ctx.attach,
        detach: ctx.detach,
        setViewport: ctx.setViewport,
        setEnabled: ctx.setEnabled,
        deleteMessage: ctx.deleteMessage,
        swipe: ctx.swipe,
        regenerate: ctx.regenerate,
        editMessage: ctx.editMessage,
        render: ctx.render,
        /** Курсор над чатом (координаты слоя кадра) → панель действий сообщения; `hoverLeave` — курсор ушёл. */
        hoverAt: point => ctx.hoverAt(point),
        hoverLeave: () => ctx.hoverLeave(),
        messageTools: () => ctx.toolsInfo(),
        visibleMesids: () => [...s.lastNeeded],
        totalHeight: () => s.lastTotalHeight,
        renderedScrollTop: () => s.renderedScrollTop,
        canvasPad: () => ctx.canvasPad(),
        isAttached: () => s.attached,
        stop: () => { for (const unregister of unregisters) unregister(); },
    };
}
