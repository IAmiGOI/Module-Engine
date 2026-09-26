import { h } from '../tree.js';
import { REDRAW_EVENTS, STREAM_TOKEN_ST_EVENT, SUPPRESS_CLASS } from './constants.js';

/** Подключение/отключение, размер вьюпорта, действия над сообщениями. */
export function installLifecycle(ctx) {
    const { s, heights, rasterizedText, mirrors, rowStates, chromeRoots, glyphHeadOf, footerSlots, genStatus, glyphBgRoots, lastChromeHeight, textureHome, subscriptions, persistentCache, getDevicePixelRatio, host, serviceOrThrow, serviceOrNull, coreOrNull } = ctx;

    async function forgetAll() {
        ctx.hideTools();   // другой чат — панель действий старого глифа больше не про то, что на экране
        // Не только `mirrors`: у ToolCall-строк тела/зеркала нет вовсе, их хром иначе переживал бы смену чата и висел на экране в новом.
        for (const mesid of new Set([...mirrors.keys(), ...chromeRoots.keys(), ...rowStates.keys(), ...textureHome.keys()])) await ctx.forgetMesid(mesid);
        for (const headerMesid of [...glyphBgRoots.keys()]) await ctx.forgetGlyphBg(headerMesid);
        heights.clear();
        s.snapshot = null;
        lastChromeHeight.clear();
        s.lastFrame = null;
        s.prefetchGen += 1;
        s.lastNeeded = new Set();
        s.lastNeededGlyphs = new Set();
        // `genStatus` — НЕ в `forgetMesid()` (тот чистит за собой при обычном
        // выезде строки за пределы окна виртуализации — статус светофора
        // должен ПЕРЕЖИТЬ прокрутку, "фиксирует свой последний цвет"
        // навсегда, а не только пока строка на экране). Здесь — да: `st.
        // chatChanged` (другой чат) делает те же числа-`mesid` совсем
        // ДРУГИМИ сообщениями, старая раскраска была бы враньём про новый
        // чат.
        genStatus.clear();
    }

    /** CSS-подавление нативного `#chat` — НИКОГДА удаление узла (см. doc-comment файла: `deleteMessage` требует, чтобы `.mes[mesid]` физически существовал). */
    async function applySuppression(shouldSuppress) {
        const container = await serviceOrNull('stChat.container');
        if (!container) return;
        if (shouldSuppress) await serviceOrThrow('dom.setProp', { el: container, key: 'class', value: SUPPRESS_CLASS });
        else await serviceOrThrow('dom.removeProp', { el: container, key: 'class' });
    }

    async function setEnabled({ enabled: next } = {}) {
        s.enabled = Boolean(next);
        await ctx.applySuppression(s.enabled);
        if (s.enabled) return ctx.render();
        await ctx.forgetAll();
        return true;
    }

    /** Backing store канваса — ФИЗИЧЕСКИЕ пиксели; CSS-размер самого элемента остаётся логическим явным стилем, иначе канвас визуально раздулся бы до backing-store размера. */
    async function applyCanvasSize() {
        s.lastQuadsKey = null; // ресайз очищает канвас — следующий кадр обязан нарисоваться
        s.dirtyMain = true;
        await serviceOrThrow('webglChat.resize', { canvas: s.canvas, width: Math.round(s.viewportWidth * s.devicePixelRatio), height: Math.round(ctx.canvasHeight() * s.devicePixelRatio) });
        await serviceOrThrow('dom.setProp', { el: s.canvas, key: 'style', value: { width: `${s.viewportWidth}px`, height: `${ctx.canvasHeight()}px`, top: `${-ctx.canvasPad()}px` } });
    }

    async function attach({ canvas: nextCanvas, lastCanvas: nextLastCanvas, mirrorContainer: nextMirrorContainer, chromeContainer: nextChromeContainer, width, height, css: nextCss = '' } = {}) {
        if (!nextCanvas || !nextMirrorContainer) throw new Error('chatViewport.attach: "canvas" and "mirrorContainer" are required.');
        s.canvas = nextCanvas;
        s.mirrorContainer = nextMirrorContainer;
        // `chromeContainer` — опционален: без него (или без `createFinalUi`,
        // см. конструктор) Ядро по-прежнему рисует тело сообщений, просто
        // без DOM-хрома поверх — обратная совместимость с уже написанными
        // сценарными тестами, которые о хроме ничего не знают.
        s.chromeContainer = nextChromeContainer ?? null;
        s.css = String(nextCss ?? '');
        s.viewportWidth = Math.max(1, Math.round(Number(width) || 0));
        s.viewportHeight = Math.max(1, Math.round(Number(height) || 0));
        s.devicePixelRatio = Math.max(1, Number(getDevicePixelRatio()) || 1);

        const glReady = await serviceOrNull('webglChat.attach', {
            canvas: s.canvas,
            width: Math.round(s.viewportWidth * s.devicePixelRatio),
            height: Math.round(ctx.canvasHeight() * s.devicePixelRatio),
        });
        if (!glReady) return false; // нет WebGL — Модуль/потребитель сам решает откатываться на нативный чат
        await serviceOrThrow('dom.setProp', { el: s.canvas, key: 'style', value: { width: `${s.viewportWidth}px`, height: `${ctx.canvasHeight()}px`, top: `${-ctx.canvasPad()}px` } });
        // ^ webglChat.attach() уже само выставило backing store в физических
        // пикселях — здесь только логический CSS-размер элемента (без него
        // канвас визуально раздулся бы до backing-store размера).

        s.attached = true;
        s.lastQuadsKey = null;
        s.dirtyMain = true;
        s.lastCanvas = null;
        if (nextLastCanvas) {
            const ready = await serviceOrNull('webglChat.attach', { canvas: nextLastCanvas, width: 1, height: 1 });
            if (ready) { s.lastCanvas = nextLastCanvas; s.lastCanvasSize = { w: 0, h: 0 }; s.lastQuadKeyL3 = null; s.lastTransformL3 = null; s.dirtyLast = true; }
        }
        if (persistentCache) setTimeout(() => { serviceOrNull('rasterCache.prune', {}).catch(() => {}); }, 5000);
        for (const event of REDRAW_EVENTS) subscriptions.push(host.events.subscribe(event, () => { ctx.render(); }));
        // Состав/цвета говорящих изменились — все растры устарели (ключ кэша строки — текст, не покраска).
        subscriptions.push(host.events.subscribe('speaker.castChanged', () => { rasterizedText.clear(); ctx.render({ fresh: true }); }));
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { ctx.forgetAll().then(() => ctx.render()); }));

        // Подвал сообщения (RP Time и т.п.) — см. doc-comment у
        // `.stme-chat-viewport-footer-slot` в `buildRowTree()`. Резолвер живёт
        // РОВНО пока этот Chat Viewport подключён — `detach()` ниже снимает
        // его, возвращая `message-footer.js` к его собственному дефолту
        // (настоящий `.mes`), иначе владелец `hostResolver` пережил бы
        // отключение Chat Viewport и указывал бы на чужие, уже удалённые
        // узлы.
        await coreOrNull('ui.messageFooter.setHostResolver', { resolver: mesid => footerSlots.get(glyphHeadOf.get(mesid) ?? mesid) ?? null });

        ctx.subscribeGeneration();

        // Прямая подписка на сырое ST-событие, В ОБХОД `host.events` — см.
        // doc-comment `STREAM_TOKEN_ST_EVENT` выше за причиной. `onStreamToken`
        // — та же ссылка на функцию, что нужна `stEvents.unsubscribe()` в
        // `detach()` (см. doc-comment `services/st-events.js`'s `.off()`
        // — снять подписку можно только ТЕМ ЖЕ обработчиком).
        const onStreamToken = () => { ctx.render(); };
        await serviceOrNull('stEvents.subscribe', { event: STREAM_TOKEN_ST_EVENT, handler: onStreamToken });
        subscriptions.push(() => { serviceOrNull('stEvents.unsubscribe', { event: STREAM_TOKEN_ST_EVENT, handler: onStreamToken }); });

        await ctx.applySuppression(s.enabled);
        await ctx.mountTools();   // панель действий сообщения (по наведению на глиф) — в слое хрома
        await ctx.render();
        // Найдено живьём: сразу после `webglChat.attach()` (свежий GL-контекст
        // на только что вставленном канвасе) самый первый `drawFrame()`
        // иногда не докомпозичивается браузером — пиксели реально нарисованы
        // (подтверждено прямым `readPixels()`), но не отображаются, пока не
        // случится ЕЩЁ один рендер. `requestAnimationFrame` для этого
        // защитного повтора НЕ подошёл — не срабатывает для фоновой/
        // неактивной вкладки (проверено живьём: событие `render.completed`
        // так и не пришло второй раз в этом окружении), а именно так чаще
        // всего и открыт реальный чат ST, когда пользователь смотрит в
        // другое окно. `setTimeout` не настолько зависим от видимости
        // вкладки. `typeof window !== 'undefined'` — только в реальном
        // браузере, не в Node-тестах (там `window` нет вовсе).
        if (typeof window !== 'undefined') setTimeout(() => { ctx.render(); }, 50);
        return true;
    }

    async function detach() {
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        await coreOrNull('ui.messageFooter.clearHostResolver', {});
        await ctx.unmountTools();
        await ctx.forgetAll();
        await ctx.applySuppression(false);
        if (s.canvas) await serviceOrNull('webglChat.detach', { canvas: s.canvas });
        if (s.lastCanvas) { await serviceOrNull('webglChat.detach', { canvas: s.lastCanvas }); s.lastCanvas = null; }
        textureHome.clear();
        s.attached = false;
        s.canvas = null;
        s.mirrorContainer = null;
        await ctx.clearSkeletons();
        s.chromeContainer = null;
    }

    async function setViewport({ scrollTop: nextScrollTop, viewportHeight: nextViewportHeight, viewportWidth: nextViewportWidth } = {}) {
        if (Number.isFinite(nextScrollTop)) {
            const target = Math.max(0, nextScrollTop);
            if (target !== s.scrollTop) {
                const nowT = performance.now();
                const dt = nowT - s.lastVelAt;
                s.scrollVelocity = (dt > 0 && dt < 500) ? s.scrollVelocity * 0.5 + ((target - s.scrollTop) / dt) * 0.5 : 0;
                s.lastVelAt = nowT;
                s.lastScrollAt = nowT;
            }
            s.scrollTop = target;
        }
        const sizeChanged =
            (Number.isFinite(nextViewportHeight) && nextViewportHeight !== s.viewportHeight) ||
            (Number.isFinite(nextViewportWidth) && nextViewportWidth !== s.viewportWidth);
        if (Number.isFinite(nextViewportHeight)) s.viewportHeight = Math.max(0, nextViewportHeight);
        if (Number.isFinite(nextViewportWidth)) s.viewportWidth = Math.max(0, nextViewportWidth);
        // Канвас (и его backing store) меняет размер только когда контейнер
        // реально изменил размер — обычный скролл (только `scrollTop`) не
        // должен дёргать WebGL-ресайз на каждый пиксель прокрутки.
        if (sizeChanged && s.attached) await ctx.applyCanvasSize();
        return ctx.render({ fresh: sizeChanged });
    }

    async function deleteMessage({ mesid } = {}) {
        await serviceOrThrow('stChat.deleteMessage', { mesid });
        return ctx.render();
    }

    async function swipe({ mesid, direction } = {}) {
        await serviceOrThrow('stChat.swipe', { mesid, direction });
        return ctx.render();
    }

    async function regenerate() {
        await serviceOrThrow('stChat.regenerate', {});
        return ctx.render();
    }

    async function editMessage({ mesid, text } = {}) {
        await serviceOrThrow('stChat.setText', { mesid, text });
        return ctx.render();
    }

    Object.assign(ctx, { forgetAll, applySuppression, setEnabled, applyCanvasSize, attach, detach, setViewport, deleteMessage, swipe, regenerate, editMessage });
}
