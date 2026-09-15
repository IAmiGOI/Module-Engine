import { request } from '../../libraries/shared/request.js';
import { computeVisibleRange, reconcileMeasuredHeight } from '../../libraries/shared/chat-viewport-math.js';
import { createUiMountRegistry } from '../../libraries/shared/ui-mount-registry.js';
import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { MessageHeader, MessageActionsRow, ReasoningBlock, TextArea, Button, Row } from '../../libraries/shared/widgets.js';

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

/** События ST, после которых видимое содержимое сообщения могло измениться. */
const REDRAW_EVENTS = Object.freeze([
    'st.messageSwiped',
    'st.messageEdited',
    'st.messageUpdated',
    'st.messageDeleted',
    'st.characterMessageRendered',
    'st.userMessageRendered',
    'st.streamTokenReceived',
]);

const SUPPRESS_CLASS = 'stme-chat-viewport-suppress-native';
const MIRROR_CLASS = 'stme-chat-viewport-mirror';
const DEFAULT_ROW_HEIGHT = 96;
const DEFAULT_OVERSCAN = 3;

export function createChatViewportCore(host, {
    publish, rowHeight = DEFAULT_ROW_HEIGHT, overscan = DEFAULT_OVERSCAN,
    getDevicePixelRatio = () => globalThis.devicePixelRatio || 1,
    createFinalUi,
} = {}) {
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    const chromeMounts = createFinalUi ? createUiMountRegistry(createFinalUi) : null;

    // --- состояние (одно Ядро = один активный чат-вьюпорт; несколько
    // одновременных вьюпортов вне сегодняшнего плана) ---
    let canvas = null;
    let mirrorContainer = null;
    let chromeContainer = null;
    let css = '';
    // ВСЁ, что касается layout/скролла/измерений (viewportWidth/Height,
    // scrollTop, heights) — ЛОГИЧЕСКИЕ CSS-пиксели, ровно то, что и так
    // естественно возвращают `dom.measureRect`/скролл браузера. `devicePixelRatio`
    // умножает их ТОЛЬКО в двух местах ниже (backing store канваса и цель
    // растеризации) — без этого текст на любом экране с DPR > 1 (или просто
    // при масштабе браузера не 100%) растеризуется в меньшем разрешении, чем
    // экран реально может показать, и выглядит пиксельным при апскейле GPU.
    let viewportWidth = 0;
    let viewportHeight = 0;
    let devicePixelRatio = 1;
    let scrollTop = 0;
    let enabled = true;
    let attached = false;
    let rendering = false;
    let renderQueued = false;

    const heights = new Map();          // mesid -> измеренная высота (px)
    const rasterizedText = new Map();   // mesid -> текст, на котором построена ТЕКУЩАЯ текстура/зеркало
    const mirrors = new Map();          // mesid -> DOM-узел зеркала
    const rowStates = new Map();        // mesid -> { position, content, editing, draft } — сигналы хрома
    const chromeRoots = new Map();      // mesid -> реальный корневой DOM-узел хрома (для forgetRowChrome)
    let lastNeeded = new Set();         // mesid'ы, для которых были загружены текстура+зеркало на ПРЕДЫДУЩЕМ render()

    const subscriptions = [];

    async function serviceOrThrow(contract, params) {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    }

    async function serviceOrNull(contract, params) {
        const result = await request(host.services, contract, { params });
        return result.ok ? result.value : null;
    }

    async function readOrderedMessages() {
        return (await serviceOrNull('stChat.messages', { limit: Number.MAX_SAFE_INTEGER })) ?? [];
    }

    /** Зеркало создаётся один раз на `mesid`, дальше только обновляется — пересоздание сорвало бы `ResizeObserver`/фокус выделения без нужды. */
    async function ensureMirror(mesid) {
        let mirror = mirrors.get(mesid);
        if (mirror) return mirror;
        mirror = await serviceOrThrow('dom.createElement', { tag: 'div' });
        await serviceOrThrow('dom.setProp', { el: mirror, key: 'class', value: MIRROR_CLASS });
        await serviceOrThrow('dom.setProp', { el: mirror, key: 'style', value: { width: `${viewportWidth}px` } });
        await serviceOrThrow('dom.append', { parent: mirrorContainer, child: mirror });
        mirrors.set(mesid, mirror);
        return mirror;
    }

    /**
     * Дерево ОДНОЙ строки хрома — построено РОВНО ОДИН РАЗ на `mesid`
     * (см. `ensureRowChrome`), дальше живёт только через свои сигналы.
     * Позиция (`state.position`) и контент (`state.content`) — РАЗНЫЕ
     * `computed()`, каждый в своей реактивной области diff.js: скролл
     * трогает только позицию, не пересобирая шапку/кнопки.
     */
    function buildRowTree(mesid, state) {
        return h('div', {
            class: 'stme-chat-viewport-row',
            style: computed(() => ({
                position: 'absolute', top: '0px', left: '0px',
                transform: `translateY(${state.position().y}px)`,
                width: `${state.position().width}px`,
                // ВЫСОТА НЕ ставится явно — намеренно. Первая версия ставила
                // сюда `state.position().height`, а `ensureRowChrome()` тут же
                // измерял ЭТОТ ЖЕ узел через `dom.measureRect` — циклическая
                // зависимость: на первом кадре высота ещё 0 (значение по
                // умолчанию), измерение получало почти 0 вместо настоящих
                // ~56px, и весь расчёт строки съезжал (поймано живьём в
                // харнессе: шапка/тело реально накладывались друг на друга).
                // Без явной высоты узел сам принимает высоту своего контента
                // (аватар+имя+бейджи/кнопки) — то самое число, что и нужно
                // измерить.
            })),
        }, computed(() => {
            if (state.editing()) {
                return h('div', { class: 'stme-chat-viewport-edit' },
                    TextArea(state.draft),
                    Row(
                        Button('Save', async () => {
                            await editMessage({ mesid, text: state.draft() });
                            state.editing.set(false);
                        }),
                        Button('Cancel', () => state.editing.set(false)),
                    ),
                );
            }
            const c = state.content();
            return h('div', {},
                MessageHeader({
                    name: c.name, avatarUrl: c.avatarUrl, turnIndex: c.turnIndex,
                    genDurationMs: c.genDurationMs, timestampText: c.sendDate, isUser: c.isUser,
                    // Кнопки — В ТОМ ЖЕ ряду, что имя (не отдельной строкой
                    // ниже) и показываются только при наведении на строку
                    // целиком — оба решения владельца, реализованы CSS'ом
                    // (`.stme-message-header-name-row:hover .stme-message-
                    // actions`), а не логикой здесь.
                    actions: MessageActionsRow({
                        onEdit: () => { state.draft.set(c.text); state.editing.set(true); },
                        onDelete: () => deleteMessage({ mesid }),
                        onSwipeLeft: c.swipeCount > 1 ? () => swipe({ mesid, direction: 'left' }) : null,
                        onSwipeRight: c.swipeCount > 1 ? () => swipe({ mesid, direction: 'right' }) : null,
                        onRegenerate: !c.isUser ? () => regenerate() : null,
                        swipeIndex: c.swipeIndex, swipeCount: c.swipeCount,
                    }),
                }),
                ReasoningBlock(c.reasoningText),
            );
        }));
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
            state = { position: signal({ y: 0, width: viewportWidth }), content: signal(content), editing: signal(false), draft: signal('') };
            rowStates.set(mesid, state);
            const finalUi = chromeMounts.mount(mesid, buildRowTree(mesid, state));
            await chromeMounts.settled(mesid);
            const root = finalUi.getRoot();
            if (root) {
                chromeRoots.set(mesid, root);
                if (chromeContainer) await serviceOrNull('dom.append', { parent: chromeContainer, child: root });
            }
        } else {
            state.content.set(content);
            await chromeMounts.settled(mesid);
        }
        const root = chromeRoots.get(mesid);
        if (!root) return 0;
        const rect = await serviceOrNull('dom.measureRect', { el: root });
        return Math.max(0, Math.round(rect?.height ?? 0));
    }

    /** `chromeMounts.unmount()` только останавливает диффинг — сам корневой узел из документа не убирает (см. ui-mount-registry.js), поэтому `dom.remove` вызывается здесь явно, тем же приёмом, что `message-footer.js`'s `forget()`. */
    async function forgetRowChrome(mesid) {
        if (!chromeMounts) return;
        chromeMounts.unmount(mesid);
        rowStates.delete(mesid);
        const root = chromeRoots.get(mesid);
        if (root) {
            await serviceOrNull('dom.remove', { node: root });
            chromeRoots.delete(mesid);
        }
    }

    async function forgetMesid(mesid) {
        const mirror = mirrors.get(mesid);
        if (mirror) {
            await serviceOrNull('dom.remove', { node: mirror });
            mirrors.delete(mesid);
        }
        await serviceOrNull('webglChat.releaseTexture', { canvas, textureId: mesid });
        rasterizedText.delete(mesid);
        await forgetRowChrome(mesid);
    }

    /**
     * Приводит зеркало+текстуру ОДНОГО сообщения в соответствие с его
     * текущим текстом. Не делает ничего, если текст с прошлого прохода не
     * изменился (`rasterizedText` — тот же приём кеша, что у остального
     * движка: сравнить с тем, что писали МЫ, а не гадать по побочным
     * признакам). Возвращает измеренную высоту строки (для `heights`).
     */
    async function syncMesid(message) {
        const { mesid, text } = message;
        const html = await serviceOrThrow('stChat.formatMessage', { mesid });
        const mirror = await ensureMirror(mesid);

        // Сравнение с тем, что записали МЫ прошлый раз — тот же приём, что
        // `dom.js`'s `lastWritten`: без него растеризация/загрузка текстуры
        // повторялась бы на КАЖДЫЙ render(), а не только когда текст реально
        // изменился (стриминг зовёт render() на каждый токен ДРУГОГО
        // сообщения тоже — это не повод перерисовывать текущее).
        const changed = rasterizedText.get(mesid) !== text;
        if (changed) await serviceOrThrow('dom.setInnerHtml', { el: mirror, html });

        const rect = await serviceOrThrow('dom.measureRect', { el: mirror });
        const height = Math.max(1, Math.round(rect.height) || rowHeight);

        if (changed) {
            // `width`/`height` здесь ЛОГИЧЕСКИЕ (совпадают с тем, что измерило
            // зеркало) — физическое разрешение растра задаёт `scale`, а не эти
            // два числа: без этого на экране с devicePixelRatio > 1 текстура
            // растеризовалась бы В РАЗРЕШЕНИИ ЭКРАНА БЕЗ УЧЁТА DPR и потом
            // растягивалась GPU при отрисовке квада большего физического
            // размера — то самое "текст слишком пиксельный".
            const rasterized = await serviceOrThrow('htmlRasterizer.rasterize', { html, width: viewportWidth, height, css, scale: devicePixelRatio });
            await serviceOrThrow('webglChat.uploadTexture', { canvas, textureId: mesid, image: rasterized.image });
            rasterizedText.set(mesid, text);
        }

        return height;
    }

    /**
     * Идемпотентный проход: читает актуальный чат, решает окно видимости,
     * приводит зеркала/текстуры видимых сообщений в соответствие, отпускает
     * то, что вышло из окна, и рисует кадр. Безопасно звать сколько угодно
     * раз подряд — повторный вызов, пока предыдущий ещё не закончился,
     * ставится в очередь РОВНО ОДИН РАЗ (`renderQueued`), а не копится.
     */
    async function render() {
        if (!attached || !enabled) return false;
        if (rendering) { renderQueued = true; return false; }
        rendering = true;
        publishEvent('ui.chatViewport.render.started', {});
        try {
            const messages = await readOrderedMessages();
            const order = messages.map(m => m.mesid);
            const byMesid = new Map(messages.map(m => [m.mesid, m]));

            const range = computeVisibleRange({
                order, heights, scrollTop, viewportHeight,
                estimatedHeight: rowHeight, overscan,
            });
            const needed = new Set(order.slice(range.startIndex, range.endIndex));

            for (const mesid of lastNeeded) if (!needed.has(mesid)) await forgetMesid(mesid);

            let y = range.offsetTop;
            const quads = [];
            for (const mesid of order.slice(range.startIndex, range.endIndex)) {
                const message = byMesid.get(mesid);
                const bodyHeight = await syncMesid(message);
                const topPx = y - scrollTop;

                // Хром (шапка/действия) — реальный DOM НАД телом сообщения, не
                // рядом с ним: тело начинается ПОСЛЕ хрома, а не с той же `y`
                // (найдено живьём в харнессе — без сдвига WebGL-текст и хром
                // рисовались друг НА друге). `chromeHeight` — измеренная РЕАЛЬНАЯ
                // высота (тем же приёмом, что высота тела через зеркало), не
                // угаданная константа, поэтому строки с разной длиной имени/
                // рассуждений не расходятся с реальной раскладкой.
                const chromeHeight = await ensureRowChrome(mesid, {
                    name: message.name, avatarUrl: message.avatarUrl, isUser: message.isUser,
                    turnIndex: Number(mesid), genDurationMs: message.genDurationMs, sendDate: message.sendDate,
                    reasoningText: message.reasoningText, swipeIndex: message.swipeIndex,
                    swipeCount: message.swipeCount, text: message.text,
                });
                const totalHeight = bodyHeight + chromeHeight;
                rowStates.get(mesid)?.position.set({ y: topPx, width: viewportWidth });

                const next = reconcileMeasuredHeight(heights, mesid, totalHeight);
                if (next) for (const [k, v] of next) heights.set(k, v);

                // Квады — в ФИЗИЧЕСКИХ пикселях backing store канваса
                // (`webglChat.attach()`/`resize()` ниже уже выставили его
                // размер как `viewportWidth/Height * devicePixelRatio`) —
                // `computeQuadVertices` в webgl-renderer.js нормирует ровно по
                // `canvas.width/height`, так что единицы должны совпадать.
                // Хром — реальный DOM, остаётся в ЛОГИЧЕСКИХ пикселях (никакого
                // devicePixelRatio здесь — CSS и так рисует его резко).
                quads.push({
                    textureId: mesid, x: 0,
                    y: (topPx + chromeHeight) * devicePixelRatio,
                    width: viewportWidth * devicePixelRatio,
                    height: bodyHeight * devicePixelRatio,
                });
                y += totalHeight;
            }

            lastNeeded = needed;
            await serviceOrNull('webglChat.drawFrame', { canvas, quads });
            publishEvent('ui.chatViewport.render.completed', { visible: quads.length, total: order.length });
            return true;
        } catch (error) {
            publishEvent('ui.chatViewport.render.failed', { message: error.message });
            throw error;
        } finally {
            rendering = false;
            if (renderQueued) { renderQueued = false; render(); }
        }
    }

    async function forgetAll() {
        for (const mesid of [...mirrors.keys()]) await forgetMesid(mesid);
        heights.clear();
        lastNeeded = new Set();
    }

    /** CSS-подавление нативного `#chat` — НИКОГДА удаление узла (см. doc-comment файла: `deleteMessage` требует, чтобы `.mes[mesid]` физически существовал). */
    async function applySuppression(shouldSuppress) {
        const container = await serviceOrNull('stChat.container');
        if (!container) return;
        if (shouldSuppress) await serviceOrThrow('dom.setProp', { el: container, key: 'class', value: SUPPRESS_CLASS });
        else await serviceOrThrow('dom.removeProp', { el: container, key: 'class' });
    }

    async function setEnabled({ enabled: next } = {}) {
        enabled = Boolean(next);
        await applySuppression(enabled);
        if (enabled) return render();
        await forgetAll();
        return true;
    }

    /** Backing store канваса — ФИЗИЧЕСКИЕ пиксели; CSS-размер самого элемента остаётся логическим явным стилем, иначе канвас визуально раздулся бы до backing-store размера. */
    async function applyCanvasSize() {
        await serviceOrThrow('webglChat.resize', { canvas, width: Math.round(viewportWidth * devicePixelRatio), height: Math.round(viewportHeight * devicePixelRatio) });
        await serviceOrThrow('dom.setProp', { el: canvas, key: 'style', value: { width: `${viewportWidth}px`, height: `${viewportHeight}px` } });
    }

    async function attach({ canvas: nextCanvas, mirrorContainer: nextMirrorContainer, chromeContainer: nextChromeContainer, width, height, css: nextCss = '' } = {}) {
        if (!nextCanvas || !nextMirrorContainer) throw new Error('chatViewport.attach: "canvas" and "mirrorContainer" are required.');
        canvas = nextCanvas;
        mirrorContainer = nextMirrorContainer;
        // `chromeContainer` — опционален: без него (или без `createFinalUi`,
        // см. конструктор) Ядро по-прежнему рисует тело сообщений, просто
        // без DOM-хрома поверх — обратная совместимость с уже написанными
        // сценарными тестами, которые о хроме ничего не знают.
        chromeContainer = nextChromeContainer ?? null;
        css = String(nextCss ?? '');
        viewportWidth = Math.max(1, Math.round(Number(width) || 0));
        viewportHeight = Math.max(1, Math.round(Number(height) || 0));
        devicePixelRatio = Math.max(1, Number(getDevicePixelRatio()) || 1);

        const glReady = await serviceOrNull('webglChat.attach', {
            canvas,
            width: Math.round(viewportWidth * devicePixelRatio),
            height: Math.round(viewportHeight * devicePixelRatio),
        });
        if (!glReady) return false; // нет WebGL — Модуль/потребитель сам решает откатываться на нативный чат
        await serviceOrThrow('dom.setProp', { el: canvas, key: 'style', value: { width: `${viewportWidth}px`, height: `${viewportHeight}px` } });
        // ^ webglChat.attach() уже само выставило backing store в физических
        // пикселях — здесь только логический CSS-размер элемента (без него
        // канвас визуально раздулся бы до backing-store размера).

        attached = true;
        for (const event of REDRAW_EVENTS) subscriptions.push(host.events.subscribe(event, () => { render(); }));
        subscriptions.push(host.events.subscribe('st.chatChanged', () => { forgetAll().then(render); }));

        await applySuppression(enabled);
        await render();
        return true;
    }

    async function detach() {
        for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        await forgetAll();
        await applySuppression(false);
        if (canvas) await serviceOrNull('webglChat.detach', { canvas });
        attached = false;
        canvas = null;
        mirrorContainer = null;
        chromeContainer = null;
    }

    async function setViewport({ scrollTop: nextScrollTop, viewportHeight: nextViewportHeight, viewportWidth: nextViewportWidth } = {}) {
        if (Number.isFinite(nextScrollTop)) scrollTop = Math.max(0, nextScrollTop);
        const sizeChanged =
            (Number.isFinite(nextViewportHeight) && nextViewportHeight !== viewportHeight) ||
            (Number.isFinite(nextViewportWidth) && nextViewportWidth !== viewportWidth);
        if (Number.isFinite(nextViewportHeight)) viewportHeight = Math.max(0, nextViewportHeight);
        if (Number.isFinite(nextViewportWidth)) viewportWidth = Math.max(0, nextViewportWidth);
        // Канвас (и его backing store) меняет размер только когда контейнер
        // реально изменил размер — обычный скролл (только `scrollTop`) не
        // должен дёргать WebGL-ресайз на каждый пиксель прокрутки.
        if (sizeChanged && attached) await applyCanvasSize();
        return render();
    }

    async function deleteMessage({ mesid } = {}) {
        await serviceOrThrow('stChat.deleteMessage', { mesid });
        return render();
    }

    async function swipe({ mesid, direction } = {}) {
        await serviceOrThrow('stChat.swipe', { mesid, direction });
        return render();
    }

    async function regenerate() {
        await serviceOrThrow('stChat.regenerate', {});
        return render();
    }

    async function editMessage({ mesid, text } = {}) {
        await serviceOrThrow('stChat.setText', { mesid, text });
        return render();
    }

    const unregisters = [
        host.own.register('chatViewport.attach', params => attach(params)),
        host.own.register('chatViewport.detach', () => detach()),
        host.own.register('chatViewport.setViewport', params => setViewport(params)),
        host.own.register('chatViewport.setEnabled', params => setEnabled(params)),
        host.own.register('chatViewport.deleteMessage', params => deleteMessage(params)),
        host.own.register('chatViewport.swipe', params => swipe(params)),
        host.own.register('chatViewport.regenerate', () => regenerate()),
        host.own.register('chatViewport.editMessage', params => editMessage(params)),
        host.own.register('chatViewport.visibleMesids', () => [...lastNeeded]),
    ];

    return {
        attach,
        detach,
        setViewport,
        setEnabled,
        deleteMessage,
        swipe,
        regenerate,
        editMessage,
        render,
        visibleMesids: () => [...lastNeeded],
        isAttached: () => attached,
        stop: () => { for (const unregister of unregisters) unregister(); },
    };
}
