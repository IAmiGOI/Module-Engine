import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { createDragHandlers, clampToViewport } from '../../libraries/shared/draggable.js';
import { FloatingPanel, EmptyState } from '../../libraries/shared/widgets.js';

// --- Чистые функции классификации drop-а (тестируются напрямую) -------------

/** http(s) URL — единственное, что вообще можно запросить через Сервис HTTP. */
export function isHttpUrl(url) {
    try { const parsed = new URL(url); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; }
    catch { return false; }
}

/**
 * Классификация того, что пользователь бросил в окно. Перетащенная ССЫЛКА из
 * браузера приходит текстом (dataTransfer `text/uri-list`, фолбэк `text/plain`);
 * файл с диска — File в `files`. Смешанный drop — берём файл (он первичен).
 * Не ссылка и не файл — честное «none»: ничего не показываем, не гадаем.
 */
export function classifyDrop({ files, text } = {}) {
    const file = files?.[0];
    if (file) return { kind: 'file', file };
    const url = (text ?? '').trim().split(/\s+/)[0] || '';
    if (url && isHttpUrl(url)) return { kind: 'url', url };
    return { kind: 'none' };
}

/**
 * Плавающее окно «Картинка» (решено с пользователем: «пусть кнопка открывает
 * расширяемую плавающую панель, как у музыки или трекера, только больше
 * размером — 3x4 прямоугольник»).
 *
 * Форма Ядра — точная копия `createMemoryGraphPanelCore`: отдельное
 * `official`-Ядро UI, свой floating-корень через `uiEngine.mount()`, НЕ секция
 * общей панели. Содержимого пока НЕТ (кнопка дока — тумблер видимости, окно
 * открывается пустым): каркас и проводка готовы, содержимое придёт позже —
 * «расширяемая» означает, что содержимое допишется внутрь того же дерева.
 *
 * Размер по умолчанию — ПРОПОРЦИЯ 3:4 (ширина:высота), не пиксели из головы:
 * 480×640 = 3:4, влезает в любой вьюпорт выше 700px. Пользователь может
 * растянуть окно родным `resize: both` — новое персистится через `onResize`,
 * как у графа.
 */
const MODULE_UI_NAMESPACE = 'core.ui.picture';
const WINDOW_KEY = 'window';
const DEFAULT_WIDTH = 480;   // 3 части пропорции 3:4
const DEFAULT_HEIGHT = 640;  // 4 части пропорции 3:4

export function createPicturePanelCore(host, { mount, requestTimeoutMs = 20000, blobToDataUrl } = {}) {
    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    // --- Содержимое окна: что показываем ------------------------------------
    // Ровно одно: картинка из последнего drop-а. showState — дискриминированное
    // объединение, а не стог флажков: честно различает «ничего» / «грузим» /
    // «ошибка» / «готово», не притворяется данными:
    //   { kind: 'idle' } | { kind: 'loading', source }
    // | { kind: 'error', message, source } | { kind: 'ready', objectUrl, source }
    const showState = signal({ kind: 'idle' });
    // Последний выданный blob-URL локального файла: отзывается при замене
    // новой картинкой и в stop() (выгрузка Ядра) — без этого каждый drop
    // файла оставлял бы жить blob до конца страницы.
    let lastObjectUrl = null;

    // --- Сеть — ТОЛЬКО по полному маршруту архитектуры ----------------------
    // Ядро → host.network (Шина сети через сетевой Гейт: проверка networkAccess
    // и на subscribe, и на каждой доставке) → Сервис HTTP (`http.request`,
    // responseType:'blob' — картинка бинарная, дефолтный text портит её UTF-8
    // декодированием). Прямого fetch() здесь НЕТ — тем же уроком, что у
    // самообновления: единственный путь Ядра к интернету.
    async function fetchImageBlob(url) {
        const result = await request(host.network, 'http.request', {
            params: { url, method: 'GET', headers: { Accept: 'image/*' }, responseType: 'blob' },
            timeoutMs: requestTimeoutMs,
        });
        if (!result.ok) throw new Error(result.error?.message || 'Network request failed.');
        const response = result.value;
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'} while fetching the image.`);
        const type = String(response.headers?.['content-type'] ?? '');
        if (type && !type.startsWith('image/')) throw new Error(`Not an image (content-type: ${type}).`);
        return { blob: response.blob, type };
    }

    // data:-URL из blob строкой — <img> показывает его без всяких
    // revokeObjectURL/утечек. Конвертация ВНЕДРЕНА (параметр blobToDataUrl):
    // FileReader существует только в браузере, node-тесты подменяют её на
    // счётчик — маршрут и состояния они проверяют без реальной картинки.
    const toDataUrl = blobToDataUrl ?? (blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the image data.'));
        reader.readAsDataURL(blob);
    }));

    /** Общий вход: показать URL (через сеть по архитектуре) или локальный File. */
    function showSource({ kind, url, file }) {
        showState.set({ kind: 'loading', source: url ?? file?.name ?? '' });
        (async () => {
            if (file) {
                // Локальный файл: сеть не нужна вообще — FileReader из браузера.
                const blob = file.type?.startsWith('image/') ? file : null;
                if (!blob) throw new Error(`Not an image: ${file.name || 'unnamed file'}.`);
                // Предыдущий blob-URL отзывается ПЕРЕД выдачей нового.
                if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
                const objectUrl = URL.createObjectURL(blob);
                lastObjectUrl = objectUrl;
                showState.set({ kind: 'ready', objectUrl, source: file.name });
                return;
            }
            // Ссылка — ПОЛНЫЙ МАРШРУТ до сервиса, никаких прямых fetch.
            const { blob } = await fetchImageBlob(url);
            showState.set({ kind: 'ready', objectUrl: await toDataUrl(blob), source: url });
        })().then(undefined, error => showState.set({
            kind: 'error',
            message: String(error?.message ?? error),
            source: url ?? file?.name ?? '',
        }));
    }

    /** Обработчик drop: классификация → показ. Не ссылка и не файл — молча ничего. */
    function handleDrop(dropEvent) {
        const event = dropEvent?.dataTransfer ? dropEvent : { dataTransfer: dropEvent };
        const files = [...(event.dataTransfer?.files ?? [])];
        let text = '';
        try {
            text = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
        } catch { /* некоторые браузеры запрещают чтение — считаем пустым */ }
        const classified = classifyDrop({ files, text });
        if (classified.kind === 'file') showSource({ kind: 'file', file: classified.file });
        else if (classified.kind === 'url') showSource({ kind: 'url', url: classified.url });
    }

    // --- Окно: позиция/размер/свёрнутость/видимость — тот же паттерн, что
    // у окна Memory Graph и HUD Трекера (saveWindowState()/loadWindowState()).
    const panelVisible = signal(false);
    const panelCollapsed = signal(false);
    const panelPosition = signal({});
    const panelSize = signal({});

    async function saveWindowState() {
        await call('storage.settings.set', {
            namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY,
            value: { visible: panelVisible.peek(), collapsed: panelCollapsed.peek(), position: panelPosition.peek(), size: panelSize.peek() },
        });
    }

    async function loadWindowState() {
        const result = await call('storage.settings.get', { namespace: MODULE_UI_NAMESPACE, key: WINDOW_KEY, fallback: {} });
        const saved = (result.ok ? result.value : null) ?? {};
        panelVisible.set(Boolean(saved.visible));
        panelCollapsed.set(Boolean(saved.collapsed));
        // Размер после первого сохранения — тот, что оставил пользователь;
        // до этого — дефолтная пропорция 3:4. Ширину/высоту валидируем: 0/битое
        // значение из старой записи вернуло бы схлопнутое окно.
        const savedSize = saved.size ?? {};
        panelSize.set({
            width: Number.isFinite(savedSize.width) && savedSize.width > 0 ? savedSize.width : DEFAULT_WIDTH,
            height: Number.isFinite(savedSize.height) && savedSize.height > 0 ? savedSize.height : DEFAULT_HEIGHT,
        });
        panelPosition.set(saved.position?.left === undefined ? {} : clampToViewport(saved.position, {
            width: panelSize.peek().width, height: panelSize.peek().height,
            viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080,
        }));
    }

    function tree() {
        // Корень — реальный узел (render() дерева требует узел, не сигнал):
        // видимость через computed-ребёнка, как у графа и HUD-модулей.
        return h('div', { class: 'stme-picture-panel-root' }, computed(() => (panelVisible() ? FloatingPanel(
            'Picture',
            {
                position: panelPosition, size: panelSize, collapsed: panelCollapsed,
                onToggle: value => { panelCollapsed.set(value); saveWindowState(); },
                // Крестик прячет окно, не выключает ничего — Ядро продолжает
                // жить; единственный путь обратно — кнопка дока (тумблер).
                onClose: () => { panelVisible.set(false); saveWindowState(); },
                drag: createDragHandlers(panelPosition, {
                    onDrop: dropped => {
                        panelPosition.set(clampToViewport(dropped, {
                            width: panelSize.peek().width ?? DEFAULT_WIDTH, height: panelSize.peek().height ?? DEFAULT_HEIGHT,
                            viewportWidth: globalThis.innerWidth ?? 1920, viewportHeight: globalThis.innerHeight ?? 1080,
                        }));
                        saveWindowState();
                    },
                }),
                onResize: next => { panelSize.set(next); saveWindowState(); },
            },
            // Содержимое: drop-зона/загрузка/ошибка/картинка — по showState.
            // Обёртка .stme-picture-dropzone — САМА зона приёма: слушает
            // dragover/drop прямо в дереве. Зона — всё тело окна, дропать
            // можно и ПОВЕРХ уже показанной картинки (зона не исчезает).
            h('div', {
                class: 'stme-picture-dropzone',
                // Подсветка зоны при перетаскивании НАД окном: класс вешается
                // на dragover, снимается на dragleave/drop. dragover обязан
                // preventDefault() — иначе браузер не даст drop-событие вовсе.
                'on:dragover': event => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                    event.currentTarget.classList.add('stme-picture-over');
                },
                'on:dragleave': event => { event.currentTarget.classList.remove('stme-picture-over'); },
                'on:drop': event => {
                    event.preventDefault();
                    event.currentTarget.classList.remove('stme-picture-over');
                    handleDrop(event);
                },
            }, content()),
        ) : null)));
    }

    /** Содержимое по состоянию: картинка / загрузка / ошибка / пусто. */
    function content() {
        return computed(() => {
            const state = showState();
            if (state.kind === 'ready') {
                return [
                    h('img', { class: 'stme-picture-image', src: state.objectUrl, alt: state.source ?? '' }),
                    h('div', { class: 'stme-picture-hint' }, 'Drop another image or link to replace'),
                ];
            }
            if (state.kind === 'loading') return [EmptyState(`Loading ${state.source || 'image'}…`)];
            if (state.kind === 'error') return [
                EmptyState(`Could not show: ${state.message}`),
                h('div', { class: 'stme-picture-hint' }, 'Drop an image file or link to try again'),
            ];
            return [EmptyState('Drop an image file or link here.')];
        });
    }

    /**
     * Строит и монтирует дерево (как у графа: `mount()` не крепит корень к
     * странице сам — это делает `harness/engine-wiring.js` через
     * `document.body.append(...)` ПОСЛЕ `settled()`).
     */
    async function open() {
        await loadWindowState();
        const finalUi = mount(tree());
        await finalUi.settled?.();
        return finalUi;
    }

    function show() {
        panelVisible.set(true);
        saveWindowState();
    }

    /** Спрятать окно — та же запись состояния, что у крестика: кнопка дока и крестик ведут себя одинаково. */
    function hide() {
        panelVisible.set(false);
        saveWindowState();
    }

    return {
        tree,
        open,
        show,
        hide,
        /** Тестам и харнессу: текущее состояние показа без чтения DOM. */
        showState,
        /** Ручной вход для тестов: тот же путь, что у handleDrop. */
        showSource,
        handleDrop,
        isVisible: () => panelVisible.peek(),
        // Выгрузка: отозвать последний blob-URL локального файла — иначе
        // он жил бы до конца жизни страницы (утечка на каждый drop файла).
        stop: () => { if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; } },
    };
}