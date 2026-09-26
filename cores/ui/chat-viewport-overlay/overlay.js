import { signal } from '../reactive.js';
import { PHONE_SIDE_MARGIN, resolveMargins, marginsWidth, minSideMargin, INPUT_PANEL_GAP, SIDE_BAR_INSET, SIDE_TOP_INSET } from '../../../libraries/shared/chat-viewport-overlay-math.js';
import { buildChatViewportBodyCss } from '../../../libraries/shared/chat-viewport-body-css.js';
import { buildOverlayLayers } from './layers.js';
import { startScrollSync } from './scroll-sync.js';
import { startMarginSync } from './margin-sync.js';
import { startGeometrySync } from './geometry-sync.js';
import { startHoverSync } from './hover-sync.js';
import { TOOLS_RIGHT_SPACE } from '../../../libraries/shared/message-tools-model.js';

const STYLE_KEY = 'chat-viewport';

/**
 * Оверлей Chat Viewport поверх родного `#chat` — то, что раньше жило внутри `enableChatViewport()` панели движка.
 * Панель теперь только просит `enable()`/`disable()` и показывает исход; вся работа с DOM — здесь и в соседних файлах
 * (`layers` — сборка, `scroll-sync`, `margin-sync`, `geometry-sync`), каждый вызов идёт через Гейт (`dom.*`).
 *
 * `enable()` → `{ ok: true }` либо `{ ok: false, reason: 'webgl-unavailable' }` (оверлей при этом убран, родной чат остаётся).
 * Любой другой сбой — исключение, но уже ПОСЛЕ отката: раньше при сбое посреди включения обёртка оставалась в документе,
 * а подписки — висеть.
 *
 * Геометрия оверлея снимается с `#chat` РОВНО ОДИН РАЗ, пока он ещё виден: `getBoundingClientRect()` скрытого (`display:none`)
 * элемента навсегда возвращает нули, а родитель `#chat` даёт свой размер, не его. Дальше размер ведёт `geometry-sync`.
 */
export function createChatViewportOverlay({ host, chatViewport, callService, callServiceOrThrow, margins, onMarginCommit, win = globalThis }) {
    let active = null;

    async function teardown(resources) {
        const attempt = async step => { try { await step(); } catch (error) { console.warn('[Chat Viewport] teardown step failed:', error); } };
        resources.scroll?.stop();
        resources.margin?.stop();
        resources.geometry?.stop();
        resources.hover?.stop();
        if (resources.attached) await attempt(() => chatViewport.detach());
        if (resources.wrapper) await attempt(() => callService('dom.remove', { node: resources.wrapper }));
        if (resources.styleRules) await attempt(() => callService('dom.restoreStyleRules', { key: STYLE_KEY }));
        if (resources.rootStyles) await attempt(() => callService('dom.restoreRootStyles', { key: STYLE_KEY }));
    }

    async function readBodyCss(mirror) {
        const [bodyColor, quoteColor, emColor, fontFamily] = await Promise.all([
            callServiceOrThrow('dom.readCssVariable', { name: '--SmartThemeBodyColor' }),
            callServiceOrThrow('dom.readCssVariable', { name: '--SmartThemeQuoteColor' }),
            callServiceOrThrow('dom.readCssVariable', { name: '--SmartThemeEmColor' }),
            callServiceOrThrow('dom.readCssVariable', { name: 'font-family', el: mirror }),
        ]);
        // Зеркало и текстура должны стоять на ОДНОМ шрифте: растр не видит веб-шрифтов страницы (libraries/shared/raster-font.js) — берём только то, что он нарисует.
        const resolved = await callService('htmlRasterizer.resolveFontFamily', { family: fontFamily });
        const family = resolved.ok && resolved.value ? resolved.value : fontFamily;
        await callService('dom.setProp', { el: mirror, key: 'style', value: { fontFamily: family } });
        return buildChatViewportBodyCss({ bodyColor, quoteColor, emColor, fontFamily: family });
    }

    async function enable() {
        if (active) return { ok: true };
        const resources = {};
        try {
            const container = await callServiceOrThrow('stChat.container');
            if (!container) throw new Error('SillyTavern chat container (#chat) was not found.');
            const body = await callServiceOrThrow('dom.body');
            const rect = await callServiceOrThrow('dom.measureRect', { el: container });
            // Ширина СТРАНИЦЫ, не #chat (owner: «во всю ширину страницы»): у ST своя `chat_width` (обычно 50vw) — оверлей её
            // игнорирует и мерит `body`. Вертикаль: оверлей на всё окно, а `top` (низ верхней панели ST) снят с `#chat` ОДИН раз, пока он виден.
            const pageSize = await callServiceOrThrow('dom.clientSize', { el: body });
            // Родитель — `#sheld` (оверлей ложится под панель ввода), запасной — `body`.
            const sheld = await callService('dom.parentElement', { el: container });
            const parent = sheld.ok && sheld.value ? sheld.value : body;
            // Своя панель набора уже включена (карточка панели включает её ДО оверлея) → верхняя полоса ST стала боковой панелью слева
            // (styles/chrome/side-bar.css): оверлей начинается правее неё, а сверху — небольшой отступ вместо полосы.
            const ownPill = await callService('dom.querySelector', { el: body, selector: '.stme-input-bar' });
            const sideBar = await callService('dom.querySelector', { el: body, selector: ':root.stme-side-bar-active #top-settings-holder' });
            const sideShell = Boolean(sideBar.ok && sideBar.value);
            const ownPanel = Boolean(ownPill.ok && ownPill.value);
            const layout = {
                top: Math.max(0, Math.round(rect.top)) + (sideShell ? SIDE_TOP_INSET : 0), bottom: 0, left: sideShell ? SIDE_BAR_INSET : 0, behindInput: parent !== body,
                // Справа от колонки — место под панель действий сообщения (выезжает по наведению; на телефоне наведения нет — места не занимаем).
                rightSpace: sideShell ? TOOLS_RIGHT_SPACE : 0,
                minMargin: 0,
            };
            // Своя панель набора → есть левый док, выезжающий вправо: колонка не должна под него наезжать.
            // На тач-экране левый док — узкая полоска у края, а не выезжающая пилюля: места под неё колонка не резервирует (иначе на телефоне оставалась половина ширины).
            const touchDock = await callService('dom.querySelector', { el: body, selector: '.stme-left-dock-touch' });
            const onTouch = Boolean(touchDock.ok && touchDock.value);
            if (ownPanel && !onTouch) layout.minMargin = minSideMargin(layout.left);
            // Связанный (по умолчанию) отступ мог быть подобран на широком экране и на телефоне съел бы половину ширины — там он небольшой. Отступы, которые владелец
            // растянул сам (`linked: false`), уважаются везде.
            const columnMargins = onTouch
                ? Object.assign(() => { const m = margins(); return m.linked ? { ...m, left: Math.min(m.left, PHONE_SIDE_MARGIN), right: Math.min(m.right, PHONE_SIDE_MARGIN) } : m; }, { set: value => margins.set(value) })
                : margins;

            const refs = await buildOverlayLayers(callServiceOrThrow, { parent, pageSize, layout });
            resources.wrapper = refs.wrapper;
            const css = await readBodyCss(refs.mirror);

            // `clientWidth/Height`, НЕ `rect.width/height` (найдено живьём): у обёртки `overflow-y:auto` свой скроллбар отъедает
            // ширину, а по спецификации второй `overflow` тогда тоже `auto` — канвас на внешнюю ширину получал горизонтальный скролл.
            const fullSize = await callServiceOrThrow('dom.clientSize', { el: refs.wrapper });
            // Нижний отступ — от верха панели ввода до низа окна (панели ввода нет — 0). Дальше его ведёт `geometry-sync`.
            const form = ownPanel ? ownPill : await callService('dom.querySelector', { el: body, selector: '#form_sheld' });
            if (form.ok && form.value) {
                const formRect = await callService('dom.measureRect', { el: form.value });
                if (formRect.ok) layout.bottom = Math.max(0, Math.round(fullSize.height - formRect.value.top + (ownPanel ? INPUT_PANEL_GAP : 0)));
            }
            await callServiceOrThrow('dom.setProp', { el: refs.wrapper, key: 'style', value: { paddingBottom: `${layout.bottom}px` } });
            const clientSize = { width: fullSize.width, height: Math.max(120, fullSize.height - layout.top - layout.bottom) };
            // Ширина страницы меняется на лету (окно, панель Chrome, боковая панель) — сигнал, а не константа.
            const pageWidth = signal(clientSize.width);
            const initialMargins = resolveMargins(columnMargins(), pageWidth.peek(), layout.minMargin);
            const ok = await chatViewport.attach({
                canvas: refs.canvas, lastCanvas: refs.lastCanvas, mirrorContainer: refs.mirror, chromeContainer: refs.chrome,
                width: Math.max(1, marginsWidth(clientSize.width, initialMargins) - layout.rightSpace), height: clientSize.height, css,
            });
            // Слой держит окно предрендера: `overflow: clip` + `overflow-clip-margin` — содержимое за краем видно (подкатка при скролле),
            // но не растягивает scrollHeight. Отрицательный marginBottom гасит собственную высоту слоя — иначе под последним
            // сообщением появлялся лишний экран пустоты.
            await callServiceOrThrow('dom.setProp', {
                el: refs.stickyLayer, key: 'style',
                value: { height: `${clientSize.height}px`, marginBottom: `${-clientSize.height}px`, overflow: 'clip', overflowClipMargin: `${chatViewport.canvasPad()}px` },
            });
            if (!ok) {
                await teardown(resources);
                return { ok: false, reason: 'webgl-unavailable' };
            }
            resources.attached = true;

            resources.scroll = await startScrollSync({ host, callService, callOrThrow: callServiceOrThrow, chatViewport, refs, layout, win });
            resources.margin = await startMarginSync({ callService, callOrThrow: callServiceOrThrow, chatViewport, refs, pageWidth, margins: columnMargins, layout, onCommit: onMarginCommit, publish: (event, payload) => host.events.emit?.(event, payload), win });
            resources.hover = await startHoverSync({ callOrThrow: callServiceOrThrow, chatViewport, refs, layout, margins: columnMargins, pageWidth, win });

            // Правила ST `:has(... [style*="..."])` пересчитывают стили сотен элементов на любое изменение style —
            // пока Chat Viewport включён, они убраны (возвращаются при выключении).
            await callService('dom.suppressStyleRules', { key: STYLE_KEY, selectorPattern: String.raw`:has\([^)]*\[style\*=` });
            resources.styleRules = true;
            // ST держит весь документ одним слоем хаком на `<html>` — из-за него любое изменение перерисовывает страницу целиком.
            await callService('dom.overrideRootStyles', { key: STYLE_KEY, styles: { transform: 'none', 'backface-visibility': 'visible', perspective: 'none' } });
            resources.rootStyles = true;

            resources.geometry = await startGeometrySync({
                host, callService, chatViewport, refs, body, layout, pageWidth, scrollState: resources.scroll.state, win,
                initial: { height: clientSize.height, pageWidth: pageSize.width },
            });
            resources.geometry.syncNow();
            active = resources;
            await callServiceOrThrow('dom.setProp', { el: refs.spacer, key: 'style', value: { height: `${chatViewport.totalHeight()}px` } });
            return { ok: true };
        } catch (error) {
            await teardown(resources);
            throw error;
        }
    }

    async function disable() {
        if (!active) return;
        const resources = active;
        active = null;
        await teardown(resources);
    }

    return { enable, disable, isActive: () => active !== null };
}
