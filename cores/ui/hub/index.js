import { request } from '../../../libraries/shared/request.js';
import { homeCss } from '../../../libraries/shared/home-html.js';
import { tileBodyHtml } from '../../../libraries/shared/hub-html.js';
import { HUB_TILES, tilesForGroup, tileById, tileForCard, tileStatus, layoutGrid, resolveView } from '../../../libraries/shared/hub-model.js';
import { createSurfaceScene } from '../surface/scene.js';

/**
 * Ядро ХАБА — обзор основной панели Module Engine (и экрана настроек): сетка блоков «как глифы» с живым статусом вместо длинного списка форм. Тело блока
 * (название и две строки статуса) рисует WebGL на общей поверхности (cores/ui/surface/), плита, точка статуса и стрелка — DOM. Клик по блоку открывает
 * ФОРМУ — нынешнюю DOM-карточку панели, оставшуюся без переделок (поля ввода, IME, доступность), с кнопкой «Back».
 *
 * Панель остаётся основной и неотключаемой: если WebGL нет, обзор рисуется обычным DOM (то же содержимое), а формы те же. Хаб не трогает ничего вне корня панели:
 * ни `#chat`, ни верхнюю полосу ST, ни `html` — поэтому не мешает другим UI-расширениям.
 *
 * Одно Ядро — несколько «привязок» (`mount`): основная панель и экран настроек показывают разные группы блоков, но статус собирается один раз.
 * Браузерное (`document`, `ResizeObserver`, растр) — инъекцией; данные — контракты Шины (`model.workers.get`) и реестр модулей, который даёт сборщик движка.
 */
export function createHubCore(host, {
    document: doc = globalThis.document, win = globalThis, getDevicePixelRatio, ResizeObserverCtor = globalThis.ResizeObserver,
    modules = null, tiles = HUB_TILES,
} = {}) {
    const call = (contract, params) => request(host.services, contract, { params });
    const mounts = new Set();
    let snapshot = {};
    const unsubscribers = [];

    /** Снимок состояния для статусов: подключения к моделям и включённые модули. Чего нет — `null` (плитка покажет описание, а не «0»). */
    async function gatherSnapshot() {
        const next = {};
        const workers = await request(host.own, 'model.workers.get', {});
        next.workerNames = workers.ok && Array.isArray(workers.value) ? workers.value.map(worker => worker.id).filter(Boolean) : null;
        if (modules) {
            const defs = modules.list?.() ?? [];
            const on = new Set(modules.enabled?.() ?? []);
            next.modules = { enabled: defs.filter(def => on.has(def.id)).map(def => def.title), total: defs.length };
        }
        return next;
    }

    /**
     * Привязывает хаб к панели: `container` — тело оверлея, `panelRoot` — корень дерева карточек, `group` — какие блоки показывать. Возвращает управление:
     * `open(tileId)`, `openCard(title)`, `back()`, `view()`, `dispose()`.
     */
    function mount({ container, panelRoot, group }) {
        const groupTiles = tilesForGroup(group, tiles);
        const root = doc.createElement('div');
        root.className = 'stme-hub';
        const bar = doc.createElement('div');
        bar.className = 'stme-hub-bar';
        bar.hidden = true;
        const back = doc.createElement('button');
        back.setAttribute('type', 'button');
        back.className = 'menu_button stme-hub-back';
        back.innerHTML = '<i class="fa-solid fa-arrow-left fa-fw"></i> Back';
        const barTitle = doc.createElement('strong');
        bar.append(back, barTitle);
        const overview = doc.createElement('div');
        overview.className = 'stme-hub-overview';
        root.append(bar, overview);
        container.insertBefore(root, panelRoot);

        let scene = null;
        let sceneReady = null;
        let current = null;                      // id открытого блока или null (обзор)
        const tileEls = new Map();               // id -> DOM плитки
        let rendering = null;
        let again = false;

        const summaryOf = tile => tileStatus(tile, snapshot);

        function buildTile(tile, placement) {
            let el = tileEls.get(tile.id);
            if (!el) {
                el = doc.createElement('button');
                el.setAttribute('type', 'button');
                el.className = 'stme-hub-tile';
                el.dataset.tile = tile.id;
                el.setAttribute('aria-label', `${tile.title}: open`);
                const dot = doc.createElement('span');
                dot.className = 'stme-hub-dot';
                const arrow = doc.createElement('i');
                arrow.className = 'fa-solid fa-chevron-right stme-hub-arrow';
                el.append(dot, arrow);
                el.addEventListener('click', () => open(tile.id));
                tileEls.set(tile.id, el);
            }
            const summary = summaryOf(tile);
            el.dataset.status = summary.status;
            el.setAttribute('title', summary.lines.filter(Boolean).join(' — '));
            Object.assign(el.style, { width: `${placement.w}px`, height: `${placement.h}px`, transform: `translate(${placement.x}px, ${placement.y}px)` });
            return el;
        }

        /** Раскладывает плитки по ширине контейнера, обновляет тела в WebGL. Проходы не перекрываются (тот же приём, что у рабочего стола). */
        function render() {
            if (rendering) { again = true; return rendering; }
            rendering = (async () => {
                do { again = false; try { await renderOnce(); } catch (error) { console.warn('[hub] render failed:', error?.message ?? error); } } while (again);
            })().finally(() => { rendering = null; });
            return rendering;
        }

        async function renderOnce() {
            const width = overview.clientWidth;
            if (!width || current) return;       // панель скрыта (ширина 0) или открыта форма — рисовать нечего
            const grid = layoutGrid({ width, ids: groupTiles.map(tile => tile.id) });
            overview.style.height = `${grid.height}px`;
            const css = homeCss(cssTokens());
            if (scene) {
                await scene.setRect({ left: 0, top: 0, width, height: Math.max(1, grid.height) });
            }
            for (const placement of grid.tiles) {
                const tile = tileById(placement.id, tiles);
                const el = buildTile(tile, placement);
                if (!el.isConnected) (scene?.blocksLayer ?? overview).append(el);
                if (scene) await scene.setBody(tile.id, { html: tileBodyHtml(tile, summaryOf(tile)), width: placement.w, height: placement.h, css });
            }
            await scene?.draw(grid.tiles.map(placement => ({ ...placement, id: placement.id })));
            if (!scene) for (const placement of grid.tiles) fallbackText(tileEls.get(placement.id), tileById(placement.id, tiles));
        }

        /** Без WebGL (или пока он не поднялся) плитка показывает тот же текст обычным DOM — панель остаётся рабочей всегда. */
        function fallbackText(el, tile) {
            let text = el.querySelector('.stme-hub-text');
            if (!text) { text = doc.createElement('div'); text.className = 'stme-hub-text'; el.prepend(text); }
            const summary = summaryOf(tile);
            text.replaceChildren();
            for (const [index, value] of [tile.title, ...summary.lines.filter(Boolean)].entries()) {
                const line = doc.createElement(index === 0 ? 'strong' : 'span');
                line.textContent = value;
                text.append(line);
            }
        }

        /** Цвета растра (`foreignObject` не видит переменных страницы): разрешает браузер на пробном узле, как у рабочего стола. */
        function cssTokens() {
            const probe = doc.createElement('span');
            probe.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden';
            doc.body.append(probe);
            const resolve = (value, fallback) => { probe.style.color = ''; probe.style.color = value; return win.getComputedStyle(probe).color || fallback; };
            const tokens = {
                text: resolve('var(--stme-text)', '#e8e6df'),
                muted: resolve('color-mix(in srgb, var(--stme-text) 62%, transparent)', 'rgba(232,230,223,.62)'),
                accent: resolve('var(--stme-accent)', '#f5c518'),
                font: win.getComputedStyle(doc.body).fontFamily || 'system-ui, sans-serif',
            };
            probe.remove();
            return tokens;
        }

        function applyView() {
            const tile = current ? tileById(current, tiles) : null;
            overview.hidden = Boolean(tile);
            bar.hidden = !tile;
            barTitle.textContent = tile ? tile.title : '';
            panelRoot.style.display = tile ? '' : 'none';
            panelRoot.classList.toggle('stme-hub-single', Boolean(tile));
            for (const card of panelRoot.querySelectorAll('.stme-card')) {
                const title = card.querySelector('.stme-card-title strong')?.textContent.trim();
                card.style.display = !tile || title === tile.card ? '' : 'none';
                if (tile && title === tile.card) card.open = true;
            }
            container.scrollTop = 0;             // форма открывается с верха, кнопка «Back» на виду
            if (!tile) void render();
        }

        function open(tileId) {
            current = resolveView(tileId, tiles);
            if (current && !groupTiles.some(tile => tile.id === current)) current = null;
            applyView();
            return current !== null;
        }

        back.addEventListener('click', () => open(null));

        let observer = null;
        if (ResizeObserverCtor) { observer = new ResizeObserverCtor(() => { void render(); }); observer.observe(overview); }
        else win.addEventListener?.('resize', render);

        // WebGL — по возможности: не поднялся, остаётся DOM-текст (`fallbackText`).
        sceneReady = (async () => {
            const candidate = createSurfaceScene({ document: doc, call, getDevicePixelRatio, className: 'stme-hub-scene' });
            candidate.root.style.display = 'none';
            if (await candidate.mount(overview)) { candidate.root.style.display = ''; scene = candidate; for (const el of tileEls.values()) el.querySelector('.stme-hub-text')?.remove(); }
            else candidate.root.remove();
            await render();
        })();

        applyView();
        const handle = {
            open, back: () => open(null), view: () => current,
            /** Открывает форму по заголовку карточки (шаг чек-листа рабочего стола). `false` — такой карточки нет в этой группе. */
            openCard: title => { const tile = tileForCard(title, tiles); return tile ? open(tile.id) : false; },
            groupHas: title => groupTiles.some(tile => tile.card === title),
            refresh: () => render(),
            ready: () => sceneReady,
            dispose() { observer?.disconnect(); win.removeEventListener?.('resize', render); scene?.dispose(); root.remove(); mounts.delete(handle); panelRoot.style.display = ''; },
        };
        mounts.add(handle);
        void gatherAndRender();
        return handle;
    }

    async function gatherAndRender() {
        snapshot = await gatherSnapshot();
        for (const handle of mounts) void handle.refresh();
    }

    unsubscribers.push(host.events.subscribe?.('model.workers.changed', () => { void gatherAndRender(); }));
    return { mount, refresh: gatherAndRender, dispose() { for (const handle of [...mounts]) handle.dispose(); for (const off of unsubscribers) off?.(); } };
}
