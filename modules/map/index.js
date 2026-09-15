import { h } from '../../cores/ui/tree.js';
import { signal, computed, effect } from '../../cores/ui/reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createModuleHost } from '../../libraries/shared/module-kit.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { classifyDrop } from '../../libraries/shared/drop-classify.js';
import { FloatingPanel, DockButton, EdgeDrawer, Field, NumberInput, TextInput, TextArea, Toggle, Button, HoldButton, EmptyState, IconButton, ColorPicker } from '../../libraries/shared/widgets.js';
import { resolveNodePoint, findContainingNodeId, snapPointToNearbyVertex, ROOT_HOST } from '../../libraries/core/map-graph.js';
import { computeClampedScaleFactor, computeUpscaledImage, cropImagePixels } from '../../libraries/shared/image-upscale.js';
import { hexToRgba } from '../../libraries/shared/color-palette.js';
import {
    FULL_VIEWPORT_RECT, viewportZoomScale, computeZoomedViewportRect, computePannedViewportRect,
    computeQuadtreeLevel, listVisibleTiles, tileCacheKey, computeTileSourcePixelRect,
} from '../../libraries/shared/map-viewport.js';

/**
 * Модуль «Карта» — тонкая UI-обвязка поверх [Ядра карты локаций](../../cores/map/index.js)
 * (ROADMAP.md 5.42/5.43): вся логика (граф, pathfinding, дистанция/время,
 * персистентность) уже там, здесь только проводка виджетов к контрактам —
 * прямое требование владельца, см. [[feedback-engine-vs-module-depth]].
 *
 * **В карточке этого Модуля (главное меню) настроек НЕТ** (`tree()`
 * возвращает `null`) — владелец: "Модуль карты включается в основном меню.
 * Там настроек нет." Все настройки живут в правой выезжающей панели самого
 * окна карты (`EdgeDrawer`).
 *
 * **Кнопка дока — своя, не общий `.stme-launcher-dock` из `index.js`.**
 * Владелец явно попросил отдельную, перетаскиваемую круглую кнопку "на
 * экране в целом", а не ещё одну иконку в общей выезжающей по ховеру
 * пилюле. Технически это — `hud()`-дерево, тот же канал, что уже даёт
 * Модулям Music/Tracker/Time свои плавающие окна поверх страницы (см.
 * `harness/engine-wiring.js`'s `createModuleRegistry`), просто с двумя
 * узлами вместо одного: кнопка дока (всегда) + окно (по видимости).
 *
 * **Окно — `FloatingPanel` с `className: 'stme-floating-panel--map'`**
 * (CSS-вариант: ширина/высота = почти весь вьюпорт, пересчитывается САМИМ
 * браузером на любой resize окна) и `minWidth`/`minHeight` как пол на
 * совсем маленьких экранах. **Без `size`/`onResize`** (ROADMAP.md 5.49,
 * владелец: "Окно можно тянуть как угодно, а не нормально") —
 * FloatingPanel без `onResize` не даёт ручку `resize:both` вовсе, размер
 * окна больше не персистится и не может быть растянут пользователем в
 * произвольную форму; двигать (drag за шапку) по-прежнему можно.
 * **`EdgeDrawer` содержит ТОЛЬКО настройки (`map.settings.*`) и кнопку
 * удаления картинки** (ROADMAP.md 5.50, владелец: "я не говорил добавлять
 * все снизу - в боковой блок. Оно не нужно там. Только удаление
 * изображения.") — главное окно показывает только сам холст.
 *
 * **В Модуле НЕТ UI для pathfinding/текущей позиции/лога перемещений**
 * (ROADMAP.md 5.50, владелец, прямо и эмоционально: "я не прошу добавлять
 * вообще патфайндиг и лог сюда... Удали просто UI для них и все") — эта
 * функциональность существовала здесь недолго (ROADMAP.md 5.46) и была
 * снята целиком, а не перенесена. **Контракты Ядра карты
 * (`map.pathfind`/`map.position.*`/`map.movementLog.*` в
 * [cores/map/index.js](../../cores/map/index.js)) НЕ тронуты** — владелец
 * возражал против UI, не против самих контрактов; они по-прежнему
 * протестированы в `map-core.test.js` и доступны любому будущему
 * потребителю (в т.ч. этому же Модулю позже, если решение изменится).
 *
 * Загрузка картинки корневой карты (ROADMAP.md 5.44) — владелец: "для
 * загрузки есть офигенный механизм перетягивания уже". Тот же dropzone,
 * что у Ядра «Картинка» (cores/ui/picture-panel.js) — его `classifyDrop`/
 * `isHttpUrl` вынесены оттуда в Библиотеку drop-classify.js ровно ради
 * этого второго потребителя. Отличие: там показ ЭФЕМЕРНЫЙ (drop -> показать,
 * ничего не сохраняется), здесь байты реально ПЕРСИСТЯТСЯ через новый
 * Сервис image-store.js (тот же IndexedDB-рецепт, что у audio-store.js);
 * какой assetId сейчас актуален — знает Ядро карты
 * (map.rootImage.get/set/clear). Принимаем только ФАЙЛ с диска — ссылку не
 * принимаем: это означало бы Модулю самому лезть в сеть напрямую, а сетевой
 * путь во всём движке зарезервирован за Ядрами с networkAccess.
 *
 * **Апскейл картинки — тайловый, по зуму, не по кнопке (ROADMAP.md 5.52,
 * замена 5.51)** — владелец: "Почему по кнопке? Надо разбивать картинку на
 * сектора, апскейлить только их при зуме." Апскейл ВСЕЙ картинки целиком по
 * кнопке (5.51) не масштабируется на большую карту и апскейлит то, что
 * пользователь может никогда не увеличивать; вместо этого холст теперь
 * умеет zoom (колесо мыши, к курсору) и pan (drag, только в режиме `view`),
 * а видимая область квадродерева тайлов (`libraries/shared/map-viewport.js`)
 * определяет, КАКИЕ маленькие сектора исходной картинки вообще стоит
 * апскейлить — реально видимые, и не глубже, чем нужно текущему зуму.
 * Каждый сектор апскейлится своим вызовом того же `computeUpscaledImage()`
 * (`libraries/shared/image-upscale.js`) — библиотека для этого не менялась,
 * только получила `cropImagePixels()` (вырезать нужный сектор из уже
 * декодированных пикселей ДО апскейла, а не апскейлить всё целиком и
 * обрезать после). Результат каждого сектора кэшируется в том же Сервисе
 * `image.*`, что и сама картинка (ключ — `tileCacheKey()`, детерминированный
 * от assetId+уровень+col+row) — повторный заход на тот же сектор того же
 * зума ничего не пересчитывает. Уровень 0 (вся картинка целиком) — это САМА
 * базовая картинка, без апскейла, всегда видна как подложка; тайлы глубже
 * рисуются ПОВЕРХ неё только когда их апскейл реально готов, так что при
 * зуме никогда нет пустой/чёрной области, только временно менее чёткая (та
 * же базовая картинка, растянутая).
 *
 * Регионы/узлы (ROADMAP.md 5.45, владелец: "Регионы, узлы, патфайндинг";
 * pathfinding-часть UI позже снята, см. выше). **Показывает и редактирует
 * узлы ЛЮБОЙ глубины вложенности** (ROADMAP.md 5.50, владелец: "я не могу
 * добавить локации в регион, что за бред то?" — прежний фильтр только на
 * `parentId == null` был неверным v1-ограничением, не забытым случаем: пока
 * ни один узел не хостит свой `localMap` — редактора вложенных карт всё
 * ещё нет — КАЖДЫЙ узел независимо от вложенности делит одно и то же
 * корневое координатное пространство, см. `resolveLocalMapHost()` в
 * map-graph.js, поэтому все узлы безопасно рисовать на одном холсте).
 * **`parentId` — полностью автоматический, не UI-выбор** (ROADMAP.md 5.53,
 * замена того, что было в 5.50: владелец — "я всё ещё не могу добавить
 * локацию внутрь региона физически нажав на него... Убери фишку с parental
 * в меню, это должно быть автоматически"). `createNodeImmediately()` сама
 * проверяет точку нового маркера/центроид нового региона на попадание в
 * границы уже существующих регионов (`findContainingNodeId()` в
 * map-graph.js, ray-casting point-in-polygon + выбор самого маленького из
 * вложенных совпадений) — клик внутри нарисованного региона теперь реально
 * кладёт новую локацию ВНУТРЬ него, без дополнительного шага. Попап
 * редактирования узла больше НЕ содержит поля выбора родителя. SVG
 * (`viewBox="0 0 1 1"`) поверх картинки рисует полигоны/маркеры/рёбра
 * напрямую в тех же
 * нормализованных координатах, что уже хранит Ядро карты
 * (`libraries/core/map-graph.js`'s `resolveNodePoint()` — переиспользована
 * как есть, чистая геометрия годится и здесь, не только Ядру). Три режима
 * холста: `view` (клик по фигуре — выбрать/редактировать), `placeMarker`
 * (следующий клик по фону — новый маркер), `drawPolygon` (клики копят
 * точки черновика, "Finish" от 3 точек создаёт форму нового региона).
 *
 * **Авто-соединение узлов — не только по касанию границ полигонов**
 * (ROADMAP.md 5.50, владелец: "построение соединений требует границ... А
 * что если пользователь не хочет отмечать границы всего? Добавь
 * авто-дистанцию по расстоянию между границами."). Настройка
 * `Auto-connect distance (m)` (`settings.autoConnectDistanceUnits`, пусто =
 * выключено) живёт в `settingsDrawerContent()` — вся логика (второй
 * источник кандидатов на авто-ребро вдобавок к касанию границ,
 * `findNodesWithinDistance()`) — в Библиотеке/Ядре, этот Модуль просто
 * проводит значение поля к `map.settings.update`.
 */
export const MODULE_ID = 'module.map';
const SETTINGS_NAMESPACE = MODULE_ID;
const CHROME_KEY = 'chrome';
const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 480;

/** Real dimensions via `createImageBitmap` (a platform capability, not "the DOM" — same reasoning `cores/ui/picture-panel.js` already relies on for `FileReader`) — injectable so Node tests can stub it. */
async function defaultResolveImageDimensions(blob) {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return dimensions;
}

/**
 * Blob -> raw RGBA pixels, via an off-screen canvas — same "platform
 * capability, not a DOM violation" reasoning as `defaultResolveImageDimensions`
 * above. Injectable so Node tests can feed `computeUpscaledImage()` (the
 * REAL algorithm, from libraries/shared/image-upscale.js) synthetic pixel
 * buffers directly, without needing a real canvas.
 */
async function defaultDecodeImageToPixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: imageData.data, width: canvas.width, height: canvas.height };
}

/** The inverse of `defaultDecodeImageToPixels` — raw RGBA pixels back into a real PNG Blob, ready for `image.put`. */
async function defaultEncodePixelsToBlob({ data, width, height }) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
}

function generateImageAssetId() {
    return `mapRootImage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Real inline SVG icons for the tool palette — NOT emoji (owner: "который
 * знаешь, скругленная капля, только используй нормальный" — a real pin
 * glyph, not 📍, which renders inconsistently/childishly across platforms).
 * `locationPinIcon()` is the standard rounded map-pin-with-a-hole shape
 * (the well-known "place" glyph); `territoryIcon()` is a simple filled
 * pentagon standing in for a drawn region/area, kept visually distinct
 * (solid shape vs. pin) rather than borrowing the pin's own silhouette.
 */
function locationPinIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z' }),
    );
}

function territoryIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M12 2.5l7.5 5.5-2 11h-11l-2-11z' }),
    );
}

/** Two dots joined by a dashed line — the show/hide toggle for adjacency edges (ROADMAP.md 5.64), kept visually distinct from both other glyphs (neither a pin nor a solid shape). */
function routeIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('line', { x1: 6, y1: 18, x2: 18, y2: 6, stroke: 'currentColor', 'stroke-width': 2, 'stroke-dasharray': '3 2.5' }),
        h('circle', { cx: 6, cy: 18, r: 3 }),
        h('circle', { cx: 18, cy: 6, r: 3 }),
    );
}

export function createMapModule(host, {
    resolveImageDimensions = defaultResolveImageDimensions,
    decodeImageToPixels = defaultDecodeImageToPixels,
    encodePixelsToBlob = defaultEncodePixelsToBlob,
} = {}) {
    const { call, notify } = createModuleHost(host);

    // --- Окно/кнопка дока: позиция/свёрнутость/видимость/шторка ------------
    // НЕТ собственного размера (ROADMAP.md 5.49, владелец: "Окно можно
    // тянуть как угодно, а не нормально") — окно карты сознательно НЕ
    // resizable (FloatingPanel без `onResize` не даёт ручку `resize:both`
    // вовсе), размер всегда идёт от CSS-варианта `.stme-floating-panel--map`
    // (почти весь вьюпорт, с отступом), который сам собой пересчитывается
    // при любом изменении окна браузера — persist-размер и вся связанная с
    // ним подгонка под вьюпорт больше не нужны в принципе.
    const dockPosition = signal({});
    const windowVisible = signal(false);
    const windowPosition = signal({});
    const windowCollapsed = signal(false);
    const drawerOpen = signal(false);

    async function saveChrome() {
        await call('storage.settings.set', {
            namespace: SETTINGS_NAMESPACE, key: CHROME_KEY,
            value: {
                dockPosition: dockPosition.peek(), visible: windowVisible.peek(), collapsed: windowCollapsed.peek(),
                position: windowPosition.peek(), drawerOpen: drawerOpen.peek(),
            },
        });
    }

    async function loadChrome() {
        const result = await call('storage.settings.get', { namespace: SETTINGS_NAMESPACE, key: CHROME_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        dockPosition.set(saved.dockPosition?.left === undefined ? {} : saved.dockPosition);
        windowVisible.set(Boolean(saved.visible));
        windowCollapsed.set(Boolean(saved.collapsed));
        drawerOpen.set(Boolean(saved.drawerOpen));
        windowPosition.set(saved.position?.left === undefined ? {} : clampToViewport(saved.position, {
            width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT,
            viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080,
        }));
    }

    // --- Настройки карты (map.settings.*) — реальные, полные, живут в шторке -
    const settingsForm = signal(null); // null пока не загружено — форма ничего не рисует раньше времени
    const settingsSaving = signal(false);

    async function loadMapSettings() {
        const result = await call('map.settings.get', {});
        if (result.ok) settingsForm.set({ ...result.value });
    }

    async function saveMapSettings() {
        const current = settingsForm.peek();
        if (!current) return;
        settingsSaving.set(true);
        const result = await call('map.settings.update', current);
        settingsSaving.set(false);
        if (result.ok) {
            settingsForm.set({ ...result.value });
            await notify.ok('Map settings saved.');
        } else {
            await notify.error(result.error?.message ?? 'Could not save map settings.');
        }
    }

    function patchSettingsForm(patch) {
        settingsForm.set({ ...settingsForm.peek(), ...patch });
    }

    /**
     * A signal-shaped VIEW onto one field of `settingsForm` — `computed()`
     * only builds read-only derivations (see reactive.js), so a two-way
     * widget binding needs its own tiny read+write function instead;
     * `isSignal = true` is what makes diff.js (see `isSignalValue()`)
     * actually treat it as reactive rather than a static value read once.
     */
    function formField(key) {
        const read = () => settingsForm()?.[key] ?? null;
        read.set = value => patchSettingsForm({ [key]: value });
        read.isSignal = true;
        return read;
    }

    /** `null` reads back as "no ceiling" (settings.minTraversableRank) — the field shows blank, not 0. */
    function numberField(key, { min, max, step } = {}) {
        return NumberInput(formField(key), { min, max, step });
    }

    function boolFormField(key) {
        const read = () => Boolean(settingsForm()?.[key]);
        read.set = value => patchSettingsForm({ [key]: value });
        read.isSignal = true;
        return read;
    }

    function settingsDrawerContent() {
        return computed(() => {
            const form = settingsForm();
            if (!form) return [EmptyState('Loading map settings…')];
            return [
                Field('Map width (m)', numberField('mapWidthUnits', { min: 1 })),
                Field('Map height (m)', numberField('mapHeightUnits', { min: 1 })),
                Field('Nested-level scale coefficient', numberField('levelScaleCoefficient', { min: 1 }), {
                    hint: 'Each level of nesting without its own explicit size is this many times smaller than its parent.',
                }),
                Field('Walking speed (m/min)', numberField('walkSpeedMetersPerMinute', { min: 1 })),
                Field('Minimum traversable rank', numberField('minTraversableRank'), {
                    hint: 'Ranks below this are excluded from movement entirely (blank = no ceiling).',
                }),
                Field('Auto-connect distance (m)', numberField('autoConnectDistanceUnits', { min: 0 }), {
                    hint: 'Any two locations within this real-world distance auto-connect even without touching borders (blank = off).',
                }),
                Toggle('Auto-calculate travel time', boolFormField('timeDistanceEnabled')),
                Button(computed(() => (settingsSaving() ? 'Saving…' : 'Save settings')), () => saveMapSettings(), { disabled: settingsSaving() }),
            ];
        });
    }

    // --- Картинка корневой карты (map.rootImage.* + image.* Сервис) ---------
    // Байты живут в Сервисе `image.*` (вызывается НАПРЯМУЮ через
    // `host.services`, тем же путём, что Music владеет своим `audio.*`,
    // module-kit.js's `call()` ходит только к Ядрам) — Ядро карты знает
    // только assetId/размеры, не байты (см. doc-comment `map.rootImage.set`
    // в cores/map/index.js).
    // `{kind}`: 'idle' | 'loading' | 'error'{message} | 'ready'{objectUrl,assetId,width,height}
    const rootImageState = signal({ kind: 'idle' });
    let rootImageLoaded = false; // guards against re-fetching the blob every time the window is merely re-opened
    let lastObjectUrl = null;

    function showBlob(blob, meta) {
        if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
        const objectUrl = URL.createObjectURL(blob);
        lastObjectUrl = objectUrl;
        rootImageState.set({ kind: 'ready', objectUrl, assetId: meta.assetId, width: meta.width, height: meta.height });
        resetTileState(); // a different image (or the same one re-shown) invalidates every cached tile and any leftover zoom/pan.
    }

    async function loadRootImage() {
        if (rootImageLoaded) return;
        rootImageLoaded = true;
        const metaResult = await call('map.rootImage.get', {});
        const meta = metaResult.ok ? metaResult.value : null;
        if (!meta) { rootImageState.set({ kind: 'idle' }); return; }
        rootImageState.set({ kind: 'loading' });
        const blobResult = await request(host.services, 'image.get', { params: { id: meta.assetId } });
        if (!blobResult.ok || !blobResult.value) {
            rootImageState.set({ kind: 'error', message: 'Could not load the saved map image — it may have been cleared from this browser\'s storage.' });
            return;
        }
        showBlob(blobResult.value, meta);
    }

    /**
     * Every existing node is meaningless once the root image it was placed
     * against is replaced by a DIFFERENT picture — same normalized 0..1
     * coordinates, totally different real content underneath them (owner:
     * "при пере-загрузке картинки - остаются старые районы", ROADMAP.md
     * 5.58). Removing only TOP-LEVEL nodes is enough — `map.nodes.remove`
     * (cores/map/index.js) already cascades to every descendant AND every
     * edge touching any of them, so a region's children/edges go with it.
     * A no-op when the map was empty already (first-ever upload).
     */
    async function clearAllMapContent() {
        const listResult = await call('map.nodes.list', {});
        if (!listResult.ok) return;
        for (const node of listResult.value.filter(existing => !existing.parentId)) {
            await call('map.nodes.remove', { id: node.id });
        }
    }

    async function uploadRootImage(file) {
        if (!file?.type?.startsWith?.('image/')) {
            await notify.error(`Not an image: ${file?.name || 'unnamed file'}.`);
            return;
        }
        rootImageState.set({ kind: 'loading' });
        try {
            const { width, height } = await resolveImageDimensions(file);
            const assetId = generateImageAssetId();
            const putResult = await request(host.services, 'image.put', { params: { id: assetId, blob: file } });
            if (!putResult.ok) throw new Error(putResult.error?.message ?? 'Could not store the image.');
            const setResult = await call('map.rootImage.set', { assetId, width, height });
            if (!setResult.ok) throw new Error(setResult.error?.message ?? 'Could not save the map image reference.');
            await clearAllMapContent();
            await loadMapContent(); // refreshes nodes/edges signals to the now-empty graph — otherwise the old shapes keep rendering until the next unrelated reload
            showBlob(file, { assetId, width, height });
            rootImageLoaded = true; // already fresh — a later loadRootImage() (e.g. re-opening the window) must not re-fetch what we just uploaded
            await notify.ok('Map image uploaded — previous locations were cleared (they belonged to the old picture).');
        } catch (error) {
            const message = String(error?.message ?? error);
            rootImageState.set({ kind: 'error', message });
            await notify.error(message);
        }
    }

    /** Only shown once an image actually exists — lives in the settings drawer now (ROADMAP.md 5.49), not the main canvas view. */
    function removeImageButton() {
        return computed(() => (rootImageState().kind === 'ready'
            ? HoldButton('Remove map image', () => removeRootImage(), { variant: 'danger' })
            : null));
    }

    /** Confirmed via `HoldButton` (irreversible-ish — wipes the map's visual base) — clears BOTH the Ядро's reference and the actual bytes, not just one. */
    async function removeRootImage() {
        const current = rootImageState.peek();
        await call('map.rootImage.clear', {});
        if (current.kind === 'ready') {
            await request(host.services, 'image.delete', { params: { id: current.assetId } }).catch(() => {});
            if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
        }
        rootImageState.set({ kind: 'idle' });
        resetTileState();
    }

    // --- Zoom/pan + тайловый апскейл по зуму (ROADMAP.md 5.52) ---------------
    // См. файловый doc-comment. `viewportRect` — единственный источник
    // истины для того, что сейчас видно; `visibleTiles` — производный от
    // него список секторов, которые СТОИТ иметь апскейленными ПРЯМО СЕЙЧАС.
    const TILE_MAX_LEVEL = 4; // 16x16 сетка на максимальном зуме — щедрый потолок для ручного зума колесом
    const TILE_RENDER_SIZE = 1024; // px — целевое разрешение апскейленного сектора (не самого исходника)
    const TILE_PAD_SOURCE_PX = 3; // запас в ИСХОДНЫХ пикселях с каждой стороны при кропе — шире support radius ядра Catmull-Rom (±2), убирает шов на границе тайлов
    // Персистентный кэш тайлов (`image.*`) не имеет ни истечения, ни списка/сборщика мусора —
    // без версии в ключе (ROADMAP.md 5.57) тайл, посчитанный СТАРЫМ, багованным
    // алгоритмом, отдавался бы вечно, даже после исправления самого алгоритма
    // (владелец прислал скриншот, доказавший это буквально: шов был "исправлен"
    // в 5.56, но пользователь продолжал видеть старые закэшированные секторы).
    // Увеличивать при КАЖДОМ изменении того, ЧТО именно попадает в байты тайла
    // (crop/upscale/paddding-математика) — старые ключи просто перестают
    // запрашиваться, ничего активно не удаляется (то же самое отсутствие GC,
    // что и у остального `image.*`, локальное хранилище одного браузера).
    const TILE_ALGORITHM_VERSION = 2;
    const MAX_ZOOM = 2 ** TILE_MAX_LEVEL;
    const ZOOM_WHEEL_FACTOR = 1.2;
    const PAN_DRAG_THRESHOLD_PX = 3; // ниже этого — это клик, не панорамирование (тот же приём, что draggable.js's clickThresholdPx)

    const viewportRect = signal(FULL_VIEWPORT_RECT);
    /** `{ [tileCacheKey]: objectUrl }` — заменяется ЦЕЛИКОМ на каждое готовое тайл (не мутируется), чтобы signal.set() увидел реальное изменение. */
    const tileImageUrls = signal({});
    const tileObjectUrls = new Map(); // тот же набор ключей, что и в tileImageUrls — здесь только ради отзыва URL при сбросе, не реактивный.
    const pendingTileKeys = new Set();
    let fullPixelsCache = null; // { assetId, data, width, height } — декодируется ОДИН РАЗ на картинку, переиспользуется для всех секторов

    function resetTileState() {
        for (const url of tileObjectUrls.values()) URL.revokeObjectURL(url);
        tileObjectUrls.clear();
        pendingTileKeys.clear();
        fullPixelsCache = null;
        tileImageUrls.set({});
        viewportRect.set(FULL_VIEWPORT_RECT);
    }

    const currentZoomScale = computed(() => viewportZoomScale(viewportRect()));
    const currentTileLevel = computed(() => computeQuadtreeLevel(currentZoomScale(), TILE_MAX_LEVEL));
    const visibleTiles = computed(() => {
        if (rootImageState().kind !== 'ready') return [];
        return listVisibleTiles(viewportRect(), currentTileLevel());
    });

    /** Decodes the root image's pixels ONCE per assetId — every tile crop reads from this same buffer instead of re-decoding the Blob per tile. */
    async function ensureFullPixels(assetId) {
        if (fullPixelsCache?.assetId === assetId) return fullPixelsCache;
        const blobResult = await request(host.services, 'image.get', { params: { id: assetId } });
        if (!blobResult.ok || !blobResult.value) throw new Error('Could not read the map image to build tiles from.');
        const pixels = await decodeImageToPixels(blobResult.value);
        fullPixelsCache = { assetId, ...pixels };
        return fullPixelsCache;
    }

    function registerTileUrl(key, blob) {
        const url = URL.createObjectURL(blob);
        tileObjectUrls.set(key, url);
        tileImageUrls.set({ ...tileImageUrls.peek(), [key]: url });
    }

    /** Persisted cache first (same `image.*` Сервис/store the root image itself uses, just a tile-namespaced key — see `tileCacheKey()`); only computed for real on a genuine cache miss. */
    /**
     * Cropping and upscaling each tile in complete isolation seams visibly
     * at the border between two tiles (owner: "При очень сильном
     * приближении - видны границы тайлов") — Catmull-Rom's edge-clamping
     * (see image-upscale.js) repeats each tile's OWN edge pixel rather than
     * sampling the real neighboring pixels just past its border, which
     * ARE available (they're just in the next tile's slice of the same
     * source image) but never consulted. Fixed by cropping a few extra
     * source pixels of "apron" on every side (`TILE_PAD_SOURCE_PX` — wider
     * than the kernel's own ±2-pixel support radius, so every sample the
     * resampler takes for a border pixel has real context), upscaling the
     * padded crop, then trimming the result back down to exactly the
     * tile's own rect (`cropImagePixels()` again, now in upscaled-space).
     * At an image edge the apron is naturally clamped by `cropImagePixels`
     * itself to less than `TILE_PAD_SOURCE_PX` — `padLeft`/`padTop` track
     * exactly how much was actually applied on each side, so the final trim
     * stays pixel-accurate regardless.
     *
     * **Every source-pixel coordinate here comes from
     * `computeTileSourcePixelRect()`** (map-viewport.js) — rounded
     * BOUNDARIES, not an independently-rounded width, so two neighboring
     * tiles always land on the IDENTICAL integer source pixel at their
     * shared edge (owner, live screenshot: the seam wasn't just a color
     * mismatch, the drawn line itself was visibly offset between tiles —
     * computing `padLeft`/`padTop` from unrounded tile-boundary values used
     * to silently disagree with where `cropImagePixels()`'s OWN internal
     * rounding actually landed the crop, by a fraction of a source pixel —
     * multiplied by the upscale factor, that became several REAL pixels of
     * misalignment).
     */
    async function loadOrComputeTile(assetId, tile, key) {
        const cachedResult = await request(host.services, 'image.get', { params: { id: key } });
        if (cachedResult.ok && cachedResult.value) {
            registerTileUrl(key, cachedResult.value);
            return;
        }
        const full = await ensureFullPixels(assetId);
        const { x: rawX, y: rawY, width: rawWidth, height: rawHeight } = computeTileSourcePixelRect(tile.rect, full.width, full.height);

        const paddedX = Math.max(0, rawX - TILE_PAD_SOURCE_PX);
        const paddedY = Math.max(0, rawY - TILE_PAD_SOURCE_PX);
        const paddedRight = Math.min(full.width, rawX + rawWidth + TILE_PAD_SOURCE_PX);
        const paddedBottom = Math.min(full.height, rawY + rawHeight + TILE_PAD_SOURCE_PX);
        const padLeft = rawX - paddedX;
        const padTop = rawY - paddedY;

        const paddedCrop = cropImagePixels(full, { x: paddedX, y: paddedY, width: paddedRight - paddedX, height: paddedBottom - paddedY });
        const factor = computeClampedScaleFactor(rawWidth, rawHeight, TILE_RENDER_SIZE / Math.max(1, rawWidth));
        const upscaledPadded = computeUpscaledImage(paddedCrop, factor);
        const upscaled = cropImagePixels(upscaledPadded, {
            x: padLeft * factor, y: padTop * factor, width: rawWidth * factor, height: rawHeight * factor,
        });
        const blob = await encodePixelsToBlob(upscaled);
        await request(host.services, 'image.put', { params: { id: key, blob } });
        registerTileUrl(key, blob);
    }

    /**
     * Reacts to `visibleTiles` changing (pan/zoom, or a brand-new image) —
     * kicks off (fire-and-forget) upscale+cache for any tile that's newly
     * visible and not already cached/in-flight. Level 0 is skipped entirely:
     * it IS the base image, already shown at native resolution with no
     * upscale needed (see the base `<image>` layer in `mapContentTree()`).
     * Same undisposed-for-the-module's-lifetime pattern as
     * `modules/music/index.js`'s own volume-sync `effect()`.
     */
    effect(() => {
        const tiles = visibleTiles();
        const state = rootImageState.peek();
        if (state.kind !== 'ready') return;
        for (const tile of tiles) {
            if (tile.level === 0) continue;
            const key = tileCacheKey(state.assetId, tile.level, tile.col, tile.row, TILE_ALGORITHM_VERSION);
            if (tileObjectUrls.has(key) || pendingTileKeys.has(key)) continue;
            pendingTileKeys.add(key);
            void loadOrComputeTile(state.assetId, tile, key)
                .catch(() => {}) // a failed tile just stays un-upscaled (base layer still shows through) — not worth a notify per sector
                .finally(() => pendingTileKeys.delete(key));
        }
    });

    /** Wheel = zoom toward the cursor — available in every canvas mode (doesn't compete with placeMarker/drawPolygon's own click handling). */
    function handleCanvasWheel(event) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const viewport = viewportRect.peek();
        const pivot = {
            x: viewport.minX + ((event.clientX - rect.left) / rect.width) * (viewport.maxX - viewport.minX),
            y: viewport.minY + ((event.clientY - rect.top) / rect.height) * (viewport.maxY - viewport.minY),
        };
        const factor = event.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
        viewportRect.set(computeZoomedViewportRect(viewport, factor, pivot, { minZoom: 1, maxZoom: MAX_ZOOM }));
    }

    // Panning (drag) is a plain pointer gesture, only in 'view' mode (placeMarker/
    // drawPolygon already interpret every click themselves) — module-level,
    // not per-render, closure state (mirrors createDragHandlers()'s own shape).
    let panPointerId = null;
    let panOrigin = null; // { clientX, clientY, viewport, rectWidth, rectHeight }
    let panMoved = false;
    let suppressNextClick = false;

    function handleCanvasPointerDown(event) {
        if (canvasMode.peek() !== 'view' || event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        panPointerId = event.pointerId;
        panOrigin = { clientX: event.clientX, clientY: event.clientY, viewport: viewportRect.peek(), rectWidth: rect.width, rectHeight: rect.height };
        panMoved = false;
        // NOT captured here — see the doc-comment above `handleCanvasPointerMove` for why.
    }

    /**
     * `setPointerCapture()` must NOT happen at `pointerdown` — owner: "любые
     * клики на регион не работают, помимо создания" (any clicks on a
     * region stopped working, except creating one). Capturing the pointer
     * at pointerdown, before it's known whether this is a plain click or a
     * real drag, redirects the browser's own synthetic `'click'` event
     * (fired right after `pointerup`) to the CAPTURING element (the `<svg>`
     * background) instead of whatever shape is actually under the cursor —
     * so clicking an existing region to select/edit it silently landed on
     * `handleCanvasBackgroundClick()` instead of that shape's own
     * `selectNode()`, which does nothing in `view` mode. Capture is now
     * only acquired the moment a drag is CONFIRMED (past the threshold,
     * right here) — a plain click never captures anything, so its `click`
     * event keeps targeting the real shape underneath it, same as before
     * pan/zoom existed at all.
     */
    function handleCanvasPointerMove(event) {
        if (panOrigin == null || event.pointerId !== panPointerId) return;
        const dxPx = event.clientX - panOrigin.clientX;
        const dyPx = event.clientY - panOrigin.clientY;
        if (!panMoved && Math.hypot(dxPx, dyPx) < PAN_DRAG_THRESHOLD_PX) return;
        // Best-effort: setPointerCapture() can throw (e.g. NotFoundError —
        // "no active pointer with the given id", seen with synthetic
        // PointerEvents in tests, and plausible on a real browser too under
        // some edge case) — an uncaught throw here would abort this whole
        // function BEFORE the actual pan below ever runs. The capture is a
        // nice-to-have (keeps the drag tracking even if the cursor leaves
        // the element mid-drag), not load-bearing for the pan itself.
        if (!panMoved) { try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch { /* not fatal */ } }
        panMoved = true;
        const { viewport, rectWidth, rectHeight } = panOrigin;
        const width = viewport.maxX - viewport.minX;
        const height = viewport.maxY - viewport.minY;
        viewportRect.set(computePannedViewportRect(viewport, -(dxPx / rectWidth) * width, -(dyPx / rectHeight) * height));
    }

    function handleCanvasPointerUp(event) {
        if (event.pointerId !== panPointerId) return;
        panPointerId = null;
        if (panMoved) {
            // The browser still fires a plain 'click' right after this pointerup —
            // suppress just that one so a drag-to-pan never also places a marker.
            suppressNextClick = true;
            setTimeout(() => { suppressNextClick = false; }, 0);
        }
        panOrigin = null;
        panMoved = false;
    }

    function resetViewport() {
        viewportRect.set(FULL_VIEWPORT_RECT);
    }

    /** Same classification as `cores/ui/picture-panel.js`'s dropzone — only `kind: 'file'` is acted on here, see file doc-comment for why URL drops are declined. */
    function handleImageDrop(dropEvent) {
        const event = dropEvent?.dataTransfer ? dropEvent : { dataTransfer: dropEvent };
        const files = [...(event.dataTransfer?.files ?? [])];
        let text = '';
        try {
            text = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
        } catch { /* some browsers disallow reading — treat as empty */ }
        const classified = classifyDrop({ files, text });
        if (classified.kind === 'file') void uploadRootImage(classified.file);
        else if (classified.kind === 'url') void notify.error('A pasted link isn\'t supported for the map yet — drop an image file instead.');
    }

    // --- Регионы/узлы карты (map.nodes.*/map.edges.*) ------------------------
    // Узлы ЛЮБОЙ глубины вложенности (ROADMAP.md 5.50) — см. `loadMapContent()`
    // ниже и `nodeFormPanel()`'s "Parent location" для деталей.
    const nodes = signal([]);
    const edges = signal([]);

    /**
     * Extra quadtree levels of zoom REQUIRED beyond a region's own depth
     * before its sub-regions take over as the FILLED layer (ROADMAP.md
     * 5.62, owner: "Переход слишком ранний от региона к под-регионам при
     * зуме") — with no margin, sub-regions took over the very first tile
     * level in (a single 2x zoom step), which read as an almost-instant
     * flip rather than a deliberate "zoom in further to drill down." One
     * extra level roughly doubles how far past a region's own depth the
     * owner has to zoom before its children actually take the wheel.
     */
    const SUBREGION_REVEAL_LEVEL_MARGIN = 1;

    /** `{depths, hasChildren}` shared by `visibleNodeIds`/`outlineNodeIds` below — same tree walk, just consumed twice. */
    const nodeDepthInfo = computed(() => {
        const all = nodes();
        const byId = new Map(all.map(node => [node.id, node]));
        const hasChildren = new Set();
        for (const node of all) if (node.parentId) hasChildren.add(node.parentId);
        const depths = new Map();
        for (const node of all) {
            const seen = new Set();
            let depth = 0;
            let current = node;
            while (current?.parentId && !seen.has(current.id)) {
                seen.add(current.id);
                current = byId.get(current.parentId);
                depth += 1;
            }
            depths.set(node.id, depth);
        }
        return { depths, hasChildren };
    });

    /**
     * The zoom level at which a node at `depth` first appears AT ALL —
     * `depth * (1 + SUBREGION_REVEAL_LEVEL_MARGIN)`, not just `depth`
     * itself. This is what keeps a child from popping in a whole zoom step
     * BEFORE its own parent has actually handed off to it: a parent at
     * depth D only switches to an outline once `level >= admissionLevel(D +
     * 1)` (see `outlineNodeIds()`) — using the SAME formula for a child's
     * own admission threshold guarantees the two events happen at EXACTLY
     * the same zoom step, never one before the other. (An earlier version
     * of this rule used plain `depth <= level` for admission, independent
     * of the margin — that let a depth-1 child appear a full zoom step
     * before its depth-0 parent actually let go, both rendered fully
     * opaque on top of each other for one zoom step.)
     */
    function admissionLevel(depth) {
        return depth * (1 + SUBREGION_REVEAL_LEVEL_MARGIN);
    }

    /**
     * Zoom-gated visibility for arbitrarily-deep nesting (ROADMAP.md 5.61,
     * owner: "Под-регионы отображаются при достаточном приближении, иначе -
     * отображается основной регион. Бесконечное количество вложений") — a
     * node at depth D (root-level = 0) is shown once `currentTileLevel() >=
     * admissionLevel(D)`. Depth alone decides being ON SCREEN at all;
     * whether it's drawn FILLED or as an empty outline is
     * `outlineNodeIds()`'s separate call — see ROADMAP.md 5.62 (owner: "Не
     * нужно полностью скрывать регионы при зуме, просто убирать заливку")
     * for why a region is never hidden outright just because its own
     * children became the active layer.
     */
    const visibleNodeIds = computed(() => {
        const level = currentTileLevel();
        const { depths } = nodeDepthInfo();
        const ids = new Set();
        for (const node of nodes()) if (admissionLevel(depths.get(node.id)) <= level) ids.add(node.id);
        return ids;
    });

    /**
     * The subset of `visibleNodeIds()` that should render as an OUTLINE
     * only (no fill) because their own children have become the active,
     * filled layer at the current zoom (ROADMAP.md 5.62, owner: "Не нужно
     * полностью скрывать регионы при зуме, просто убирать заливку" — the
     * region itself stays on screen as a border, it just stops competing
     * visually with its own now-filled children). Only a region with
     * children can ever be in this set — a childless leaf (or a marker,
     * which never has children) is always filled.
     */
    const outlineNodeIds = computed(() => {
        const level = currentTileLevel();
        const { depths, hasChildren } = nodeDepthInfo();
        const ids = new Set();
        for (const node of nodes()) {
            if (!hasChildren.has(node.id)) continue;
            if (admissionLevel(depths.get(node.id) + 1) <= level) ids.add(node.id);
        }
        return ids;
    });

    const visibleEdges = computed(() => {
        const visible = visibleNodeIds();
        return edges().filter(edge => visible.has(edge.fromId) && visible.has(edge.toId));
    });

    const canvasMode = signal('view'); // 'view' | 'placeMarker' | 'drawPolygon'
    const draftPoints = signal([]);
    /** `null` = no form shown; a plain object (with or without `id`) = create-draft or edit-copy of an existing node. */
    const nodeForm = signal(null);
    const nodeFormSaving = signal(false);
    /** `null`, or `{node}` for the region the right-click action menu was opened on (ROADMAP.md 5.61). */
    const regionContextMenu = signal(null);
    /** Whether adjacency edges ("routes") are currently drawn on the canvas at all (ROADMAP.md 5.64, owner: "Маршруты должны визуально отключаться") — purely a display preference, not persisted; a busy map's routes can be toggled off entirely, not just made less busy. */
    const edgesVisible = signal(true);

    function nodeById(id) {
        return nodes().find(node => node.id === id);
    }

    /**
     * ALL nodes, not just top-level ones (owner: "я не могу добавить локации
     * в регион, что за бред то?" — the earlier `parentId == null` filter was
     * a v1 scope cut that turned out wrong). No node currently has its own
     * `localMap` (that editor doesn't exist yet), so every node — regardless
     * of nesting depth — still shares the ROOT coordinate space
     * (`resolveLocalMapHost()` only climbs off the root once a `localMap` is
     * actually set) — safe to render them all on the one root canvas as-is.
     */
    async function loadMapContent() {
        const [nodesResult, edgesResult] = await Promise.all([call('map.nodes.list', {}), call('map.edges.list', {})]);
        if (nodesResult.ok) nodes.set(nodesResult.value);
        if (edgesResult.ok) edges.set(edgesResult.value);
    }

    /** Draft field VIEW onto `nodeForm` — same read+write-function shape as `formField()` above, targeting the node draft instead of the settings form. */
    function nodeDraftField(key, fallback = '') {
        const read = () => nodeForm()?.[key] ?? fallback;
        read.set = value => nodeForm.set({ ...nodeForm.peek(), [key]: value });
        read.isSignal = true;
        return read;
    }

    const DEFAULT_NEW_NODE_NAME = 'New location';

    /**
     * `stopPropagation()` ONLY when actually selecting (owner: "Я все еще
     * не могу поставить локацию внутрь региона потому-что это кликабельная
     * область" — a click on top of an existing region's polygon shape used
     * to call `stopPropagation()` UNCONDITIONALLY, before even checking the
     * canvas mode, which swallowed the click before it could ever reach the
     * SVG background's `handleCanvasBackgroundClick()` — so clicking a
     * marker/region directly ONTO a drawn region in `placeMarker`/
     * `drawPolygon` mode silently did nothing at all, no matter what
     * `findContainingNodeId()` would have decided). Now a non-`view` click
     * returns immediately WITHOUT stopping propagation, so it bubbles up to
     * the background handler exactly like a click on empty canvas would.
     */
    function selectNode(node, event) {
        if (canvasMode.peek() !== 'view') return; // mid-draw — let the click fall through to place/draw on the background instead
        event?.stopPropagation?.();
        if (suppressNextClick) return; // a drag-to-pan that happened to end on top of a shape must not also open its edit popup
        regionContextMenu.set(null);
        nodeForm.set({ ...node });
    }

    /**
     * Creates the node FOR REAL right away (owner: "Локация появляется
     * визуально на карте после заполнения инфы а не до. Сделай так, чтобы
     * локация появлялась сразу...") — no more "unsaved draft" concept;
     * the popup that follows only ever EDITS an already-persisted node.
     *
     * **`parentId` is now ALWAYS automatic, never a UI choice** (ROADMAP.md
     * 5.53, owner: "я все ещё не могу добавить локацию внутрь региона
     * физически нажав на него... Убери фишку с parental в меню, это должно
     * быть автоматически"). `findContainingNodeId()` (map-graph.js) checks
     * the new shape's own point (the click position for a marker, the
     * polygon's own centroid for a region) against every existing
     * polygon-region in the same root space and picks the smallest one that
     * actually contains it — clicking inside a drawn region really does nest
     * the new location inside it now, with no extra step.
     */
    async function createNodeImmediately(shapeParams) {
        const containmentPoint = shapeParams.position ?? (shapeParams.polygon ? resolveNodePoint({ polygon: shapeParams.polygon }) : null);
        const nodesById = Object.fromEntries(nodes.peek().map(existing => [existing.id, existing]));
        const parentId = containmentPoint ? findContainingNodeId(nodesById, containmentPoint, ROOT_HOST) : null;
        const result = await call('map.nodes.create', { name: DEFAULT_NEW_NODE_NAME, description: '', rank: null, parentId, ...shapeParams });
        if (!result.ok) {
            await notify.error(result.error?.message ?? 'Could not create the location.');
            return;
        }
        await loadMapContent();
        nodeForm.set({ ...result.value });
    }

    /**
     * Background (not a node shape) click on the canvas — behavior depends
     * on the current drawing mode; a plain "view" click does nothing. Maps
     * the click's rect-relative fraction through the CURRENT `viewportRect`
     * (ROADMAP.md 5.52) — at the default full-image viewport this reduces
     * to the exact same plain fraction math as before zoom/pan existed; a
     * zoomed-in click correctly lands inside the smaller visible region,
     * not the whole 0..1 image.
     */
    function handleCanvasBackgroundClick(event) {
        if (suppressNextClick) return; // the tail end of a drag-to-pan gesture, not a real click
        if (regionContextMenu.peek()) { regionContextMenu.set(null); return; } // a click anywhere else just dismisses the open action menu, same as a native context menu would
        const mode = canvasMode.peek();
        if (mode === 'view') return;
        const rect = event.currentTarget.getBoundingClientRect();
        const viewport = viewportRect.peek();
        const x = viewport.minX + ((event.clientX - rect.left) / rect.width) * (viewport.maxX - viewport.minX);
        const y = viewport.minY + ((event.clientY - rect.top) / rect.height) * (viewport.maxY - viewport.minY);
        if (mode === 'placeMarker') {
            canvasMode.set('view');
            void createNodeImmediately({ position: { x, y } });
        } else if (mode === 'drawPolygon') {
            // Snapped to a nearby existing vertex (ROADMAP.md 5.60, owner:
            // "если регионы очень близко друг к другу... нужно их
            // подтягивать для формирования границ") — a border drawn a few
            // pixels off a neighboring region's corner would otherwise
            // silently miss the Ядро's own border-touch auto-adjacency
            // detection (findAdjacentNodeIds()'s tolerance), even though it
            // LOOKS like it touches.
            const nodesById = Object.fromEntries(nodes.peek().map(existing => [existing.id, existing]));
            const snapped = snapPointToNearbyVertex({ x, y }, nodesById, ROOT_HOST);
            draftPoints.set([...draftPoints.peek(), snapped]);
        }
    }

    function finishPolygon() {
        const points = draftPoints.peek();
        if (points.length < 3) return;
        canvasMode.set('view');
        draftPoints.set([]);
        void createNodeImmediately({ polygon: points });
    }

    function cancelDraw() {
        canvasMode.set('view');
        draftPoints.set([]);
    }

    /**
     * Right-click action menu on a region (ROADMAP.md 5.61, owner: "не в
     * попап. При нажатии пкм - пусть вылезает рамка... где будут разные
     * функции региона. Пусть первая кнопка - создает под-регион, тем же
     * рисованием") — replaces the earlier plan of stuffing a "split into
     * sub-regions" action into the edit popup; a region gets its own small
     * action strip instead, opened by a right-click, with the browser's own
     * context menu suppressed. Markers don't get one — none of the actions
     * envisioned here (starting with "add a sub-region") make sense for a
     * single point.
     */
    function openRegionContextMenu(node, event) {
        event.preventDefault();
        if (canvasMode.peek() !== 'view') return; // mid-draw — a stray right-click shouldn't interrupt drawing
        event.stopPropagation();
        nodeForm.set(null);
        regionContextMenu.set({ node });
    }

    function closeRegionContextMenu() {
        regionContextMenu.set(null);
    }

    /**
     * First action, first (only, for now) button — just switches into the
     * SAME `drawPolygon` tool an ordinary region already uses (owner:
     * "Пусть первая кнопка - создает под-регион, тем же рисованием"). No
     * parent is recorded here on purpose: `createNodeImmediately()`'s
     * existing `findContainingNodeId()` already nests any new shape inside
     * whichever existing region's polygon its own centroid falls in —
     * drawing inside this region's own borders is enough to nest under it,
     * at any depth, with zero extra state to track or get out of sync.
     */
    function startSubRegionDraw() {
        regionContextMenu.set(null);
        canvasMode.set('drawPolygon');
        draftPoints.set([]);
    }

    async function saveNodeForm() {
        const draft = nodeForm.peek();
        if (!draft?.id) return;
        if (!draft.name?.trim()) { await notify.error('A name is required.'); return; }
        nodeFormSaving.set(true);
        const result = await call('map.nodes.update', {
            id: draft.id, name: draft.name, description: draft.description ?? '', rank: draft.rank ?? null,
            parentId: draft.parentId || null, color: draft.color || null, radius: draft.radius ?? null,
        });
        nodeFormSaving.set(false);
        if (result.ok) {
            nodeForm.set(null);
            await loadMapContent();
            await notify.ok('Location updated.');
        } else {
            await notify.error(result.error?.message ?? 'Could not save the location.');
        }
    }

    function cancelNodeForm() {
        nodeForm.set(null);
    }

    async function deleteNodeForm() {
        const draft = nodeForm.peek();
        if (!draft?.id) return;
        const result = await call('map.nodes.remove', { id: draft.id });
        if (result.ok) {
            nodeForm.set(null);
            await loadMapContent();
            await notify.ok('Location removed.');
        } else {
            await notify.error(result.error?.message ?? 'Could not remove the location.');
        }
    }

    /**
     * Coordinates stay in the Ядро's own normalized 0..1 space (`viewBox="0
     * 0 1 1"`, `preserveAspectRatio="none"`) — safe to stretch non-uniformly
     * ONLY because the canvas's INNER box (`.stme-map-canvas-inner`, see
     * `mapContentTree()`) is itself locked to the image's real aspect ratio
     * via an inline `aspect-ratio` style. Deformation (ROADMAP.md 5.49,
     * owner: "Карта деформируется при растягивании экрана") happened when
     * the OUTER flexible window box was stretched directly — now that
     * always-correctly-shaped inner box is what gets stretched onto,
     * which is lossless by construction, not a distortion.
     */
    /** Default marker radius when a node has no `radius` override of its own (ROADMAP.md 5.60). */
    const DEFAULT_MARKER_RADIUS = 0.012;
    /** Same fraction the old shared `.stme-map-node` CSS rule used for a region's default (no-custom-color) fill — kept as one named constant so the inline custom-color path stays visually consistent with it, not a second, drifting magic number. */
    const REGION_FILL_ALPHA = 0.28;
    /** Border widths at the DEFAULT (unzoomed, scale 1x) view — same numbers the old fixed CSS `stroke-width` used to hardcode. Actual width is always these divided by the CURRENT zoom (see `nodeShapes()`). */
    const DEFAULT_STROKE_WIDTH = 0.003;
    const SELECTED_STROKE_WIDTH = 0.005;
    /**
     * Edge ("route") line styling at 1x zoom (ROADMAP.md 5.64, owner:
     * "Маршруты должны... быть более отличимыми") — noticeably THICKER than
     * a region border (`DEFAULT_STROKE_WIDTH`) and dashed, so a route reads
     * as a distinct kind of line rather than "a border that goes nowhere,"
     * on top of already using its own `--stme-ok` color (panel.css) instead
     * of the border's accent color. Divided by zoom just like border widths
     * (ROADMAP.md 5.62) — same reasoning, a fixed fraction of the 0..1 space
     * would otherwise get visibly thicker/dash-longer the more zoomed in.
     */
    const EDGE_STROKE_WIDTH = 0.005;
    const EDGE_DASH_ON = 0.014;
    const EDGE_DASH_OFF = 0.008;
    /** Draft-polygon-while-drawing styling (ROADMAP.md 5.64, owner: "При создании региона - границы не совсем интуитивны так еще и все-еще толстые") — same zoom-division as everything else now; vertex dots make each already-placed click visible, not just the connecting lines. */
    const DRAFT_STROKE_WIDTH = 0.003;
    const DRAFT_VERTEX_RADIUS = 0.006;

    /**
     * Borders were visibly getting THICKER the further in you zoomed
     * (ROADMAP.md 5.62, owner: "Границы под-регионов слишком толстые") —
     * not a rendering bug, just an overlooked consequence of zoom already
     * being real: `stroke-width` lives in the SAME normalized 0..1 space as
     * everything else, so a fixed width is a fixed FRACTION OF THE WHOLE
     * IMAGE, not of whatever's currently on screen. `viewportRect` shrinking
     * as you zoom in (ROADMAP.md 5.52) means that same fixed fraction covers
     * a bigger and bigger share of the now-smaller visible area — sub-regions
     * only ever show up once already zoomed in a fair way (ROADMAP.md 5.61),
     * so their borders were the first place this became obvious. Dividing by
     * `currentZoomScale()` keeps the ON-SCREEN width constant at every zoom
     * level, exactly matching how it already looked before zoom/pan existed.
     */
    function nodeShapes() {
        return computed(() => {
            const visible = visibleNodeIds();
            const outline = outlineNodeIds();
            const zoom = currentZoomScale();
            return nodes().filter(node => visible.has(node.id)).map(node => {
                const selected = nodeForm()?.id === node.id;
                const strokeWidth = (selected ? SELECTED_STROKE_WIDTH : DEFAULT_STROKE_WIDTH) / zoom;
                if (node.polygon) {
                    const isOutline = outline.has(node.id);
                    // Only set inline fill/stroke COLOR when a CUSTOM color was
                    // actually picked (ROADMAP.md 5.60) — otherwise the CSS
                    // class's own theme-accent default keeps applying exactly
                    // as before. `fill: 'none'` for the outline-only state
                    // (ROADMAP.md 5.62, owner: "Не нужно полностью скрывать
                    // регионы при зуме, просто убирать заливку") always wins
                    // regardless of a custom color — the region stays on
                    // screen as a border, it just stops competing visually
                    // with its now-filled children.
                    const style = { strokeWidth };
                    if (node.color) style.stroke = node.color;
                    if (isOutline) {
                        style.fill = 'none';
                        // `fill: none` means the shape's INTERIOR is no longer
                        // "painted" — the browser's default `pointer-events:
                        // visiblePainted` then only reacts to clicks ON the
                        // stroke line itself, letting anything underneath
                        // (the base map image, ROADMAP.md 5.62 owner: "при
                        // отсутствии заливки - ПКМ кликается по фото а не по
                        // региону") receive the click/right-click instead.
                        // Forcing `pointer-events: all` keeps the WHOLE
                        // polygon area clickable regardless of whether it's
                        // actually painted.
                        style.pointerEvents = 'all';
                    } else if (node.color) style.fill = hexToRgba(node.color, REGION_FILL_ALPHA);
                    const cls = `stme-map-node-region${selected ? ' stme-map-node-selected' : ''}${isOutline ? ' stme-map-node-region-outline' : ''}`;
                    return h('polygon', {
                        class: cls, style, points: node.polygon.map(point => `${point.x},${point.y}`).join(' '),
                        'on:click': event => selectNode(node, event),
                        'on:contextmenu': event => openRegionContextMenu(node, event),
                    });
                }
                const style = { strokeWidth };
                if (node.color) { style.stroke = node.color; style.fill = node.color; }
                const cls = `stme-map-node-marker${selected ? ' stme-map-node-selected' : ''}`;
                const point = resolveNodePoint(node) ?? { x: 0.5, y: 0.5 };
                return h('circle', { class: cls, style, cx: point.x, cy: point.y, r: node.radius ?? DEFAULT_MARKER_RADIUS, 'on:click': event => selectNode(node, event) });
            });
        });
    }

    function edgeLines() {
        return computed(() => {
            if (!edgesVisible()) return [];
            const zoom = currentZoomScale();
            const style = { strokeWidth: EDGE_STROKE_WIDTH / zoom, strokeDasharray: `${EDGE_DASH_ON / zoom} ${EDGE_DASH_OFF / zoom}` };
            return visibleEdges().map(edge => {
                const fromPoint = resolveNodePoint(nodeById(edge.fromId));
                const toPoint = resolveNodePoint(nodeById(edge.toId));
                if (!fromPoint || !toPoint) return null;
                return h('line', {
                    class: 'stme-map-edge', style,
                    x1: fromPoint.x, y1: fromPoint.y, x2: toPoint.x, y2: toPoint.y,
                });
            });
        });
    }

    /**
     * Shows every already-placed click as a real vertex dot, plus a preview
     * of the CLOSING segment back to the first point once there are enough
     * points to actually finish (ROADMAP.md 5.64, owner: "границы не совсем
     * интуитивны") — before this, only the open connecting polyline was
     * drawn, so it never quite looked like the region it was about to
     * become, and it was hard to tell exactly where a click had registered
     * (especially right after a vertex-snap, ROADMAP.md 5.60). Stroke width
     * is now zoom-divided too, same as every other border in the canvas
     * (ROADMAP.md 5.62) — this one was missed the first time around.
     */
    function draftPolygonPreview() {
        return computed(() => {
            const points = draftPoints();
            if (canvasMode() !== 'drawPolygon' || points.length === 0) return null;
            const zoom = currentZoomScale();
            const lineStyle = { strokeWidth: DRAFT_STROKE_WIDTH / zoom };
            const shapes = [
                h('polyline', { class: 'stme-map-draft', style: lineStyle, points: points.map(point => `${point.x},${point.y}`).join(' ') }),
            ];
            if (points.length >= 3) {
                const first = points[0];
                const last = points[points.length - 1];
                shapes.push(h('line', {
                    class: 'stme-map-draft-closing', style: lineStyle,
                    x1: last.x, y1: last.y, x2: first.x, y2: first.y,
                }));
            }
            for (const point of points) {
                shapes.push(h('circle', { class: 'stme-map-draft-vertex', style: lineStyle, cx: point.x, cy: point.y, r: DRAFT_VERTEX_RADIUS / zoom }));
            }
            return shapes;
        });
    }

    /**
     * Upscaled sector crops, drawn as native SVG `<image>` elements sharing
     * the SAME viewBox transform as everything else in the canvas — so they
     * pan/zoom for free, no separate positioning math. Level-0 tiles are
     * skipped (the base `<image>` layer in `mapContentTree()` already shows
     * the whole image at native resolution); a tile with no cached URL yet
     * is simply omitted, letting the base layer show through underneath
     * until `loadOrComputeTile()` finishes.
     */
    /**
     * `class: 'stme-map-tile-image'` (ROADMAP.md 5.58) is what actually
     * kills the seam now — `image-rendering: pixelated` in panel.css. The
     * real cause was never the tile CONTENT (that was fixed for real in
     * 5.56/5.57) — it's the BROWSER's own smoothing of each independently
     * rasterized `<image>` as it scales it onto the canvas, blurring each
     * tile's edge in isolation with no shared context across the boundary.
     * Tiles are placed at their EXACT nominal rect, no display overlap —
     * the overlap hack from 5.55 was a guess at a DIFFERENT (SVG anti-
     * aliasing) cause; with `pixelated` actually addressing the real
     * cause, the overlap's own geometric stretch (slightly distorting each
     * tile to be marginally larger than its real content) is both
     * unnecessary and itself a source of distortion, so it's removed.
     */
    function tileLayers() {
        return computed(() => {
            const state = rootImageState();
            if (state.kind !== 'ready') return null;
            const urls = tileImageUrls();
            return visibleTiles().map(tile => {
                if (tile.level === 0) return null;
                const key = tileCacheKey(state.assetId, tile.level, tile.col, tile.row, TILE_ALGORITHM_VERSION);
                const url = urls[key];
                if (!url) return null;
                return h('image', {
                    class: 'stme-map-tile-image',
                    href: url, x: tile.rect.minX, y: tile.rect.minY,
                    width: tile.rect.maxX - tile.rect.minX, height: tile.rect.maxY - tile.rect.minY,
                    preserveAspectRatio: 'none',
                });
            });
        });
    }

    /**
     * Floating icon strip on the LEFT edge of the canvas (owner: "Сделай их
     * значками в левой части карты") — a `DockButton`-style tool palette,
     * not the text-labelled top toolbar this replaces. Pin = new marker,
     * territory glyph = new region; while drawing, the active tool stays
     * highlighted and Cancel/Finish join it as their own icon buttons.
     */
    function canvasTools() {
        return computed(() => {
            const mode = canvasMode();
            let tools;
            if (mode === 'placeMarker') {
                tools = [
                    IconButton(locationPinIcon(), () => {}, { active: true, title: 'Click the map to place a marker' }),
                    IconButton('✕', cancelDraw, { title: 'Cancel' }),
                ];
            } else if (mode === 'drawPolygon') {
                const count = draftPoints().length;
                tools = [
                    IconButton(territoryIcon(), () => {}, { active: true, title: `Click to add points (${count}) — at least 3 needed` }),
                    IconButton('✓', finishPolygon, { disabled: count < 3, title: 'Finish region' }),
                    IconButton('✕', cancelDraw, { title: 'Cancel' }),
                ];
            } else {
                tools = [
                    IconButton(locationPinIcon(), () => { regionContextMenu.set(null); canvasMode.set('placeMarker'); }, { title: 'Add marker' }),
                    IconButton(territoryIcon(), () => { regionContextMenu.set(null); canvasMode.set('drawPolygon'); draftPoints.set([]); }, { title: 'Add region' }),
                ];
                // Only worth showing once actually zoomed/panned away from the default view — no clutter at the normal resting state.
                if (currentZoomScale() > 1) tools.push(IconButton('↺', resetViewport, { title: 'Reset zoom/pan' }));
            }
            // Available in EVERY mode, not just 'view' (ROADMAP.md 5.64, owner:
            // "Маршруты должны визуально отключаться") — a busy map's routes
            // can get in the way of drawing too, not just of looking at it.
            tools.push(IconButton(routeIcon(), () => edgesVisible.set(!edgesVisible.peek()), {
                active: edgesVisible(), title: edgesVisible() ? 'Hide routes' : 'Show routes',
            }));
            return tools;
        });
    }

    /**
     * A small card ANCHORED to the node's own position on the canvas — not
     * a block at the bottom of the window (owner: "Очень тупая идея с
     * заполнением инфы внизу в окне... Локация появляется визуально на
     * карте после заполнения инфы а не до. Сделай так, чтобы локация
     * появлялась сразу, затем чтобы возле неё всплывало окно для записи
     * инфы" — ROADMAP.md 5.48). The node this edits already exists for
     * real by the time this ever shows (see `createNodeImmediately()`) —
     * there is no more "unsaved draft" state, so `Cancel` only closes the
     * popup, it never deletes anything. **No `parentId` field here** —
     * containment is decided automatically at CREATION time
     * (`createNodeImmediately()`'s `findContainingNodeId()`), not editable
     * afterward (ROADMAP.md 5.53, owner: "Убери фишку с parental в меню,
     * это должно быть автоматически").
     */
    /**
     * A small card ANCHORED to the node's own position — direction (above/
     * below) and `max-height` are now both derived from the ACTUAL room
     * available between the anchor and the relevant canvas edge (as a
     * percentage of the CURRENT `viewportRect`, ROADMAP.md 5.52 — before
     * zoom/pan existed this was just the whole 0..1 image, now the node's
     * SCREEN position also depends on the current pan/zoom), not a fixed
     * magic-number threshold (owner: "Локации вверху карты - худ
     * редактирования обрезается" — the old `point.y < 0.2` flip still
     * clipped whenever the popup was taller than 20% of the canvas, which a
     * multi-field form regularly is). Whichever direction has MORE room is
     * picked, and `max-height` is capped to exactly that room so the popup
     * can never extend past the canvas edge — if content still doesn't fit,
     * its own `overflow-y: auto` (panel.css) scrolls internally instead of
     * clipping invisibly. Horizontal position is `clamp()`ed between fixed
     * pixel margins (not just `left: X%` + `translateX(-50%)`) so a node
     * near the left/right edge doesn't push the card half off-canvas either.
     */
    /**
     * Shared anchor-to-node math, now used by both this popup and
     * `regionContextMenuPanel()` (ROADMAP.md 5.61 — the SECOND real
     * consumer of this exact positioning logic, per
     * [[feedback-hermes-beta-workflow]]'s "extract on the second consumer"
     * rule) — screen-space percent position of a node's own point, plus
     * which side (above/below) has more room, so either popup can flip
     * direction and clamp horizontally without ever running off-canvas.
     */
    function anchorForPoint(point) {
        const viewport = viewportRect();
        const screenX = (point.x - viewport.minX) / (viewport.maxX - viewport.minX);
        const screenY = (point.y - viewport.minY) / (viewport.maxY - viewport.minY);
        const below = screenY < 0.5;
        const verticalRoomPercent = (below ? (1 - screenY) : screenY) * 100;
        return { screenX, screenY, below, verticalRoomPercent };
    }

    function nodeFormPanel() {
        return computed(() => {
            const draft = nodeForm();
            if (!draft) return null;
            const point = resolveNodePoint(draft) ?? { x: 0.5, y: 0.5 };
            const { screenX, screenY, below, verticalRoomPercent } = anchorForPoint(point);
            return h('div', {
                class: `stme-map-node-form${below ? ' stme-map-node-form-below' : ''}`,
                style: {
                    left: `clamp(120px, ${(screenX * 100).toFixed(3)}%, calc(100% - 120px))`,
                    top: `${(screenY * 100).toFixed(3)}%`,
                    maxHeight: `calc(${verticalRoomPercent.toFixed(3)}% - 20px)`,
                },
            },
                h('strong', {}, 'Edit location'),
                Field('Name', TextInput(nodeDraftField('name'))),
                Field('Description', TextArea(nodeDraftField('description'))),
                Field('Rank', NumberInput(nodeDraftField('rank', null)), { hint: 'Free-form abstraction level — lower is more abstract (blank = unranked).' }),
                Field('Color', ColorPicker(nodeDraftField('color', '')), { hint: 'Blank = the default theme color.' }),
                !draft.polygon
                    ? Field('Marker size', NumberInput(nodeDraftField('radius', null), { min: 0.001, max: 0.1, step: 0.001 }), { hint: 'Blank = default size. Meaningless for a drawn region.' })
                    : null,
                Button(nodeFormSaving() ? 'Saving…' : 'Save', () => saveNodeForm(), { disabled: nodeFormSaving() }),
                Button('Close', cancelNodeForm),
                HoldButton('Delete location', () => deleteNodeForm(), { variant: 'danger' }),
            );
        });
    }

    /**
     * The region action strip (ROADMAP.md 5.61) — same anchor math as
     * `nodeFormPanel()` (`anchorForPoint()`), but a plain horizontal row of
     * labelled buttons instead of a form card, matching the reference the
     * owner shared (a small row of tabs/buttons, not a popup with fields).
     * Only ONE action exists so far — "+ Sub-region", `startSubRegionDraw()`
     * — more can be appended to this same row later without touching the
     * anchoring.
     */
    function regionContextMenuPanel() {
        return computed(() => {
            const target = regionContextMenu();
            if (!target) return null;
            const point = resolveNodePoint(target.node) ?? { x: 0.5, y: 0.5 };
            const { screenX, screenY, below } = anchorForPoint(point);
            return h('div', {
                class: `stme-map-context-menu${below ? ' stme-map-context-menu-below' : ''}`,
                style: { left: `clamp(80px, ${(screenX * 100).toFixed(3)}%, calc(100% - 80px))`, top: `${(screenY * 100).toFixed(3)}%` },
            },
                Button('+ Sub-region', startSubRegionDraw),
                Button('✕', closeRegionContextMenu),
            );
        });
    }

    /**
     * ONLY the canvas/dropzone — owner: "кнопки внизу остались (удалить
     * карту, маршрут и так далее), хотя этой части вообще быть не должно"
     * (ROADMAP.md 5.49). Position/pathfinding/movement-log/remove-image
     * moved into the settings drawer (see `windowTree()`'s `EdgeDrawer`
     * call) — the main window is the map and nothing else.
     */
    function mapContentTree() {
        return h('div', {
            class: 'stme-map-dropzone',
            'on:dragover': event => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                event.currentTarget.classList.add('stme-map-dropzone-over');
            },
            'on:dragleave': event => { event.currentTarget.classList.remove('stme-map-dropzone-over'); },
            'on:drop': event => {
                event.preventDefault();
                event.currentTarget.classList.remove('stme-map-dropzone-over');
                handleImageDrop(event);
            },
        },
        computed(() => {
            const state = rootImageState();
            if (state.kind === 'ready') {
                return [
                    // Outer box (flex:1, whatever room is left) just CENTERS
                    // the inner one; the inner box is locked to the image's
                    // real aspect ratio (`aspect-ratio` inline style) so it
                    // is ALWAYS exactly the image's own visible area, never
                    // letterboxed itself — that's what keeps the 0..1
                    // normalized coordinates below correct with a plain
                    // linear stretch, no letterbox math needed anywhere.
                    h('div', { class: 'stme-map-canvas' },
                        h('div', { class: 'stme-map-canvas-inner', style: { aspectRatio: `${state.width || 1} / ${state.height || 1}` } },
                            h('svg', {
                                class: 'stme-map-svg',
                                // Reactive — pan/zoom (ROADMAP.md 5.52) just
                                // changes WHICH part of the same 0..1 space
                                // is visible; every shape/tile below keeps
                                // its own plain normalized coordinates, the
                                // viewBox alone does the transform.
                                viewBox: computed(() => { const v = viewportRect(); return `${v.minX} ${v.minY} ${v.maxX - v.minX} ${v.maxY - v.minY}`; }),
                                preserveAspectRatio: 'none',
                                'on:click': handleCanvasBackgroundClick,
                                'on:wheel': handleCanvasWheel,
                                'on:pointerdown': handleCanvasPointerDown,
                                'on:pointermove': handleCanvasPointerMove,
                                'on:pointerup': handleCanvasPointerUp,
                                'on:pointercancel': handleCanvasPointerUp,
                            },
                                // Base layer — the whole image at native
                                // resolution, always shown (no upscale, no
                                // load delay); upscaled tiles (tileLayers())
                                // draw on TOP of it only once each is ready,
                                // so a zoom never shows a blank/black gap.
                                h('image', { href: state.objectUrl, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none' }),
                                h('g', {}, tileLayers()),
                                h('g', {}, edgeLines()),
                                h('g', {}, nodeShapes()),
                                draftPolygonPreview(),
                            ),
                            h('div', { class: 'stme-map-tools' }, canvasTools()),
                            nodeFormPanel(),
                            regionContextMenuPanel(),
                        ),
                    ),
                ];
            }
            if (state.kind === 'loading') return [h('div', { class: 'stme-map-dropzone-empty' }, EmptyState('Loading map image…'))];
            if (state.kind === 'error') return [h('div', { class: 'stme-map-dropzone-empty' }, EmptyState(`Could not show: ${state.message}`), h('div', { class: 'stme-map-dropzone-hint' }, 'Drop an image file to try again.'))];
            return [h('div', { class: 'stme-map-dropzone-empty' }, EmptyState('Drop a map image here.'))];
        }),
        );
    }

    // --- Дерево окна/дока -----------------------------------------------------
    function windowTree() {
        return computed(() => (windowVisible() ? FloatingPanel(
            'Map',
            {
                className: 'stme-floating-panel--map',
                minWidth: MIN_WINDOW_WIDTH,
                minHeight: MIN_WINDOW_HEIGHT,
                position: windowPosition, collapsed: windowCollapsed,
                // No `size`/`onResize` — see the chrome-state doc-comment
                // above: the map window is deliberately not resizable,
                // sized purely by CSS.
                onToggle: value => { windowCollapsed.set(value); saveChrome(); },
                onClose: () => { windowVisible.set(false); saveChrome(); },
                drag: createDragHandlers(windowPosition, {
                    onDrop: dropped => {
                        windowPosition.set(clampToViewport(dropped, {
                            width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT,
                            viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080,
                        }));
                        saveChrome();
                    },
                }),
            },
            mapContentTree(),
            EdgeDrawer(drawerOpen, {
                title: 'Map settings',
                onToggle: value => {
                    drawerOpen.set(value);
                    if (value && !settingsForm.peek()) void loadMapSettings();
                    saveChrome();
                },
            },
            // Each a SEPARATE top-level argument, never bundled into one
            // array — see the nested-computed-in-array warning elsewhere in
            // this file (ROADMAP.md 5.45/5.49). ONLY settings + remove-image
            // live here (owner: "я не говорил добавлять все снизу - в
            // боковой блок. Оно не нужно там. Только удаление изображения." —
            // ROADMAP.md 5.50) — position/pathfinding/movement-log UI was
            // removed from the Module entirely, not relocated here. Upscale
            // is no longer a manual sidebar action at all (ROADMAP.md 5.52) —
            // it's automatic, per-tile, driven by zoom (see canvasTools()'s
            // "↺ Reset zoom/pan" and the wheel/drag handlers on the canvas).
            settingsDrawerContent(),
            removeImageButton()),
        ) : null));
    }

    function hud() {
        return h('div', { class: 'stme-map-hud-root' },
            DockButton('🗺', {
                position: dockPosition,
                title: 'Open Map',
                drag: createDragHandlers(dockPosition, {
                    onDrop: dropped => { dockPosition.set(dropped); saveChrome(); },
                    onClick: () => setHudVisible(!windowVisible.peek()),
                }),
            }),
            windowTree(),
        );
    }

    function setHudVisible(value) {
        windowVisible.set(value);
        saveChrome();
        if (value && !settingsForm.peek() && drawerOpen.peek()) void loadMapSettings();
        if (value) { void loadRootImage(); void loadMapContent(); }
    }

    return {
        async load() {
            await loadChrome();
            if (drawerOpen.peek()) await loadMapSettings();
            if (windowVisible.peek()) { await loadRootImage(); await loadMapContent(); }
        },
        /** No settings card in the Modules list — see file doc-comment. Still a real (empty) node: the Ядро UI модулей mounts `tree()` directly at the root of its own Final UI, which cannot mount a bare `null`. */
        tree: () => h('div', { class: 'stme-module-body' },
            h('small', { class: 'stme-module-hint' }, 'Open the 🗺 button on screen for the map window and its settings.')),
        hud,
        hudVisible: windowVisible,
        setHudVisible,
        isHudVisible: () => windowVisible.peek(),
        // Отзыв ВСЕХ blob-URL (сама картинка + каждый закэшированный тайл) —
        // иначе они жили бы до конца страницы (та же утечка, что чинил
        // `stop()` у Ядра «Картинка»).
        stop: () => {
            if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
            for (const url of tileObjectUrls.values()) URL.revokeObjectURL(url);
            tileObjectUrls.clear();
        },
        // Тестам: прямой доступ без чтения/клика по дереву — тот же приём,
        // что и у Модуля «Music» (`importFiles` вместо симуляции drop'а).
        settingsForm,
        drawerOpen,
        loadMapSettings,
        saveMapSettings,
        patchMapSettings: patchSettingsForm,
        dockPosition,
        windowPosition,
        rootImageState,
        loadRootImage,
        uploadRootImage,
        removeRootImage,
        handleImageDrop,
        // Zoom/pan + тайлы (ROADMAP.md 5.52) — тот же приём прямого доступа.
        viewportRect,
        tileImageUrls,
        currentZoomScale,
        currentTileLevel,
        visibleTiles,
        handleCanvasWheel,
        handleCanvasPointerDown,
        handleCanvasPointerMove,
        handleCanvasPointerUp,
        resetViewport,
        canvasTools,
        // Регионы/узлы/pathfinding — тестам, тот же приём "прямой доступ без
        // клика по дереву", что и у всего остального в этом Модуле.
        nodes,
        edges,
        visibleNodeIds,
        outlineNodeIds,
        nodeShapes,
        edgeLines,
        draftPolygonPreview,
        edgesVisible,
        canvasMode,
        draftPoints,
        nodeForm,
        regionContextMenu,
        loadMapContent,
        createNodeImmediately,
        handleCanvasBackgroundClick,
        finishPolygon,
        cancelDraw,
        selectNode,
        saveNodeForm,
        cancelNodeForm,
        deleteNodeForm,
        openRegionContextMenu,
        closeRegionContextMenu,
        startSubRegionDraw,
    };
}
