import { signal } from '../reactive.js';
import { hashString, ROW_PAD } from './constants.js';

/** Жизненный цикл хрома строки: монтирование/обновление/измерение (`ensureRowChrome`), правка (`beginEdit`), снятие (`forgetRowChrome`). */
export function installRowChrome(ctx) {
    const { s, heights, toolCallHtmlWritten, rowStates, chromeRoots, imageLayers, footerSlots, contentCols, rowPositionApplied, chromeHeightCache, rowHeight, publishEvent, chromeMounts, serviceOrNull } = ctx;

    /** Начать правку сообщения: если его строки нет на экране — прокрутить к нему (событие для панели) и открыть правку, когда она смонтируется. */
    async function beginEdit(mesid) {
        const state = rowStates.get(mesid);
        if (state) { state.draft.set(state.content().text); state.editing.set(true); } else s.pendingEditMesid = mesid;
        const frame = s.lastFrame;
        const index = frame?.order?.indexOf(mesid) ?? -1;
        if (index >= 0) {
            const y = frame.order.slice(0, index).reduce((sum, id) => sum + (heights.get(id) ?? rowHeight), 0);
            const onScreen = state && y >= frame.frameScrollTop && y < frame.frameScrollTop + s.viewportHeight * 0.6;
            if (!onScreen) publishEvent('ui.chatViewport.scrollRequest', { scrollTop: Math.max(0, y - 80) });
        }
        await ctx.render({ fresh: false });
        setTimeout(() => serviceOrNull('dom.focusSelector', { el: chromeRoots.get(mesid), selector: '.stme-chat-viewport-edit-area' }), 300);
    }

    /**
     * Хром создаётся один раз на `mesid` (как зеркало) — обновляется через
     * сигналы `state`, никогда не пересобирается целиком. Возвращает РЕАЛЬНУЮ
     * измеренную высоту хрома (0, если `createFinalUi` не дан Ядру — хром
     * опционален, тело сообщения рисуется и без него): шапка/действия — тоже
     * настоящий DOM НАД телом сообщения, и место под них нужно закладывать в
     * общую высоту строки/позицию квада тем же способом, что и высота тела
     * (измерить, а не угадать фиксированной константой) — иначе хром и текст
     * WebGL накладываются друг на друга (найдено живьём в харнессе).
     */

    async function ensureRowChrome(mesid, content) {
        if (!chromeMounts) return 0;
        let state = rowStates.get(mesid);
        if (!state) {
            // Новая строка монтируется ЗА экраном (-1e6), а не в y=0: позицию ей ставит только коммит кадра, и если кадр прервался (пришёл новый скролл),
            // все строки без позиции налезали бы друг на друга в верхней части экрана.
            state = { position: signal({ y: -1e6, width: s.viewportWidth }), content: signal(content), editing: signal(false), draft: signal(''), editRect: signal(null) };
            rowStates.set(mesid, state);
            if (s.pendingEditMesid === mesid) { state.draft.set(content.text); state.editing.set(true); s.pendingEditMesid = null; }
            const finalUi = chromeMounts.mount(mesid, ctx.buildRowTree(mesid, state));
            await chromeMounts.settled(mesid);
            const root = finalUi.getRoot();
            if (root) {
                chromeRoots.set(mesid, root);
                if (s.chromeContainer) await serviceOrNull('dom.append', { parent: s.chromeContainer, child: root });
            }
        } else {
            state.content.set(content);
            await chromeMounts.settled(mesid);
        }
        const root = chromeRoots.get(mesid);
        if (!root) return 0;
        // Заглушка подвала (`.stme-chat-viewport-footer-slot`, см. `buildRowTree()`)
        // — узел статичный, диффинг его не трогает и не пересоздаёт между
        // рендерами, поэтому ищем его ОДИН раз на `mesid`, как и `root`
        // самой строки. Сразу зовём `ui.messageFooter.attach()` — НАЙДЕНО
        // ЖИВЬЁМ у самого `message-footer.js` (см. его `claim()`'s doc-
        // comment: "Модуль «RP Time» занимал слот и оставался невидимым"):
        // без немедленного вызова подвал появился бы только на СЛЕДУЮЩЕЕ
        // стороннее ST-событие, а не как только у строки появилось место
        // его принять — виртуализация вносит новые строки чаще, чем летят
        // такие события.
        if (!footerSlots.has(mesid)) {
            const footerSlot = await serviceOrNull('dom.querySelector', { el: root, selector: '.stme-chat-viewport-footer-slot' });
            if (footerSlot) {
                footerSlots.set(mesid, footerSlot);
                ctx.scheduleFooterAttach();
            }
        }
        // Не кешируется: diff пересоздаёт обёртку при смене формы строки (float
        // аватарки появляется/исчезает) — старый узел оказывается отсоединён и
        // измеряется как 0x0 (найдено живьём: строки после раскрытого ризонинга
        // получали высоту 0 и налезали друг на друга).
        const contentCol = await serviceOrNull('dom.querySelector', { el: root, selector: '.stme-chat-viewport-content-col' });
        if (contentCol) contentCols.set(mesid, contentCol);
        // ToolCall — реальный HTML вставляется ИМПЕРАТИВНО в заглушку
        // (`.stme-toolcall-body`, `buildRowTree()` выше), ДО измерения
        // высоты ниже — иначе измеренная высота хрома не учла бы только что
        // вставленный контент (тот же порядок, что `syncMesid()` уже
        // соблюдает для зеркала: сначала `setInnerHtml`, потом `measureRect`).
        // `toolCallHtmlWritten` — НАЙДЕНО ЖИВЬЁМ: без сравнения "не
        // изменился — не трогаем" (тот же приём, что `rasterizedText` для
        // тела сообщения) HTML переinject'ился бы БЕЗУСЛОВНО на каждый
        // `render()` — включая тот самый рендер, который вызывает наш же
        // `toggle`-обработчик ниже. Свежераспарсенный из строки `<details>`
        // по умолчанию ЗАКРЫТ — открытие пользователем сбрасывалось бы
        // обратно долей секунды спустя, самозамкнутый цикл.
        // Кеш хранит И узел-заглушку: если её пересоздали (гонка перерисовок,
        // ремонт хрома) — сравнение по одному HTML пропустило бы запись, и
        // ToolCall оставался бы пустым (найдено живьём: строка высотой 0).
        const toolCallPlaceholder = (content.isToolCall && content.toolCallHtml)
            ? await serviceOrNull('dom.querySelector', { el: root, selector: '.stme-toolcall-body' })
            : null;
        const writtenToolCall = toolCallHtmlWritten.get(mesid);
        if (toolCallPlaceholder && (writtenToolCall?.el !== toolCallPlaceholder || writtenToolCall?.html !== content.toolCallHtml)) {
            const placeholder = toolCallPlaceholder;
            {
                await serviceOrNull('dom.setInnerHtml', { el: placeholder, html: content.toolCallHtml });
                toolCallHtmlWritten.set(mesid, { el: placeholder, html: content.toolCallHtml });
                // Тот же баг, что раньше был у `ReasoningBlock` (см. его
                // `onToggle` doc-comment) — раскрытие СОБСТВЕННОГО
                // `<details>` ToolCall-сообщения (вставлен сырым HTML,
                // никакого `h()`-дерева/`on:toggle` у него в принципе нет)
                // точно так же меняет реальную высоту строки, а `render()`
                // сам по себе не узнаёт. `'toggle'` слушается на КОНТЕЙНЕРЕ
                // (делегирование — их может быть НЕСКОЛЬКО `<details>` на
                // одно ToolCall-сообщение, навешивать на каждый по
                // отдельности нечем) — ставится ЗДЕСЬ же, только когда HTML
                // реально только что обновился (сам placeholder-узел не
                // пересоздаётся между обновлениями, слушатель остаётся
                // валиден и без повторной установки). `:capture` — НАЙДЕНО
                // ЖИВЬЁМ: обычное всплытие (`on:toggle`) НЕ срабатывало на
                // реальный клик —
                // `toggle` в этом браузере не всплывает (`bubbles: false`),
                // хотя синтетический `bubbles:true`-эвент в тесте ложно
                // создавал впечатление, что делегирование работает. Фаза
                // capture ловит событие на пути вниз независимо от
                // всплытия — см. doc-comment `services/dom.js`'s `setProp()`.
                await serviceOrNull('dom.setProp', { el: placeholder, key: 'on:toggle:capture', value: () => { s.toggleRender = true; chromeHeightCache.clear(); ctx.render({ fresh: false }); } });
            }
        }
        // `contentCols.get(mesid) ?? root` — НАЙДЕНО ЖИВЬЁМ: измерять надо
        // `.stme-chat-viewport-content-col` (имя+дата+ризонинг+ToolCall,
        // БЕЗ аватарки — см. её doc-comment в `buildRowTree()`), не сам
        // `root` — `root` имеет `position: absolute` (виртуализация), а это
        // САМО ПО СЕБЕ заводит BFC независимо от `overflow`, из-за чего
        // `dom.measureRect(root)` всегда включал полную высоту float-
        // аватарки. Фолбэк на `root` — строки без `c.isGlyphStart` (нет
        // аватарки вовсе, `.stme-chat-viewport-content-col` не оборачивает
        // ничего специально, но `root`'s auto-height тогда и так корректна
        // — обёртка есть у ВСЕХ строк, см. `buildRowTree()`, так что этот
        // фолбэк практически не нужен, только на случай сбоя querySelector.
        const { text: _omitted, finalText: _omittedFinal, ...chromeContent } = content;
        const sig = `${s.viewportWidth}|${hashString(JSON.stringify(chromeContent))}`;
        const measureTarget = contentCols.get(mesid) ?? root;
        await ctx.watchChromeHeight(mesid, measureTarget);
        const cached = chromeHeightCache.get(mesid);
        if (cached && cached.sig === sig) return cached.height;
        const rect = await serviceOrNull('dom.measureRect', { el: measureTarget });
        // Padding строки (`root`) в измеряемую обёртку не входит — добавляем.
        const measured = (content.padTop ?? ROW_PAD) + (content.padBottom ?? ROW_PAD) + Math.max(0, Math.round(rect?.height ?? 0));
        chromeHeightCache.set(mesid, { sig, height: measured, pad: measured - Math.max(0, Math.round(rect?.height ?? 0)) });
        return measured;
    }

    /** `chromeMounts.unmount()` только останавливает диффинг — сам корневой узел из документа не убирает (см. ui-mount-registry.js), поэтому `dom.remove` вызывается здесь явно, тем же приёмом, что `message-footer.js`'s `forget()`. */
    async function forgetRowChrome(mesid) {
        if (!chromeMounts) return;
        chromeMounts.unmount(mesid);
        rowStates.delete(mesid);
        chromeHeightCache.delete(mesid);
        await ctx.stopWatchingChromeHeight(mesid);
        rowPositionApplied.delete(mesid);
        toolCallHtmlWritten.delete(mesid);
        footerSlots.delete(mesid);
        contentCols.delete(mesid);
        imageLayers.delete(mesid);
        const root = chromeRoots.get(mesid);
        if (root) {
            await serviceOrNull('dom.remove', { node: root });
            chromeRoots.delete(mesid);
        }
    }

    Object.assign(ctx, { beginEdit, ensureRowChrome, forgetRowChrome });
}
