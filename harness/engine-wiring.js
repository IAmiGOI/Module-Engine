import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerDomService } from '../services/dom.js';
import { registerHtmlRasterizerService } from '../services/html-rasterizer.js';
import { registerWebglRendererService } from '../services/webgl-renderer.js';
import { registerRasterCacheService } from '../services/raster-cache.js';
import { registerTextPainterService } from '../services/text-painter.js';
import { registerGlAnimationService } from '../services/gl-animation.js';
import { registerStBackgroundsService } from '../services/st-backgrounds.js';
import { registerImageScaleService } from '../services/image-scale.js';
import { registerStUserDataService } from '../services/st-user-data.js';
import { registerSyncStateService } from '../services/sync-state.js';
import { registerSyncSignalService } from '../services/sync-signal.js';
import { registerSyncPeerService } from '../services/sync-peer.js';
import { createSyncCore } from '../cores/sync/index.js';
import { createStartupCore } from '../cores/startup/index.js';
import { createBackgroundsCore } from '../cores/backgrounds/index.js';
import { createMusicServerCore } from '../cores/music-server/index.js';
import { createGlAnimationsCore } from '../cores/ui/gl-animations.js';
import { registerHttpService } from '../services/http.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerStHomeService } from '../services/st-home.js';
import { registerEmbeddingService } from '../services/embedding.js';
import { registerAudioStoreService } from '../services/audio-store.js';
import { registerImageStoreService } from '../services/image-store.js';
import { registerGraphLibraryService } from '../services/graph-library.js';
import { registerPmPresetsService } from '../services/pm-presets.js';
import { registerStPromptDataService } from '../services/st-prompt-data.js';
import { registerStPmUiService } from '../services/st-pm-ui.js';
import { createPromptManagerPanelCore } from '../cores/ui/prompt-manager-panel.js';
import { createPromptManagerCore } from '../cores/prompt-manager/index.js';
import { registerAudioPlaybackService } from '../services/audio-playback.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerFileService } from '../services/file.js';
import { registerStMacrosService } from '../services/st-macros.js';
import { registerStLorebookService } from '../services/st-lorebook.js';
import { registerStCharacterService } from '../services/st-character.js';
import { registerStCharacterCardsService } from '../services/st-character-cards.js';
import { registerCharacterCardVersionsService } from '../services/character-card-versions.js';
import { registerStWebSearchService } from '../services/st-web-search.js';
import { registerStCharacterAvatarService } from '../services/st-character-avatar.js';
import { registerStEventsService } from '../services/st-events.js';
import { registerStToolsService } from '../services/st-tools.js';
import { registerStGenerationService } from '../services/st-generation.js';
import { registerStExtensionsService } from '../services/st-extensions.js';
import { registerStWorldInfoService } from '../services/st-worldinfo.js';
import { registerStPresetService } from '../services/st-preset.js';
import { registerStDrawerGuard } from '../services/st-drawer-guard.js';
import { createDrawerGuardCore } from '../cores/drawer-guard/index.js';
import { registerSessionService } from '../services/session.js';
import { createSelfUpdateCore } from '../cores/self-update/index.js';
import { createFirstLoadCore, FIRST_LAUNCH_EVENT } from '../cores/first-load/index.js';
import { createGuideCore } from '../cores/guide/index.js';
import { deriveExtensionName } from '../libraries/core/update-check.js';
import { createEventsCore } from '../cores/events/index.js';
import { createGenerationCore } from '../cores/generation/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { createDiffusionCore } from '../cores/models/diffusion.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createBackupCore, createChatMetadataBackupSource, createExtensionSettingsBackupSource, createGraphLibraryBackupSource, createPmPresetsBackupSource } from '../cores/backup/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createMacrosCore } from '../cores/macros/index.js';
import { createSpeakerCore } from '../cores/speaker/index.js';
import { createMapCore } from '../cores/map/index.js';
import { createMapNarrationCore } from '../cores/map-narration/index.js';
import { createLorebookCore } from '../cores/lorebook/index.js';
import { createCharacterCardsCore } from '../cores/character-cards/index.js';
import { createClassifierCore } from '../cores/classifier/index.js';
import { createBasicSummaryCore } from '../cores/summary/index.js';
import { createMemoryGraphCore } from '../cores/memory-graph/index.js';
import { createUiEngineCore } from '../cores/ui/ui-engine.js';
import { createEnginePanelCore } from '../cores/ui/engine-panel.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { createFinalUiAndroid, isMobileSurface } from '../cores/ui/final-ui-android.js';
import { createUiModulesCore } from '../cores/ui/ui-modules.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createSyncToastsCore } from '../cores/ui/sync-toasts.js';
import { createActivityLightCore } from '../cores/ui/activity-light.js';
import { createMessageFooterCore } from '../cores/ui/message-footer.js';
import { createChatViewportCore } from '../cores/ui/chat-viewport.js';
import { createInputBarCore } from '../cores/ui/input-bar/index.js';
import { createHomeCore } from '../cores/ui/home/index.js';
import { createHubCore } from '../cores/ui/hub/index.js';
import { createUpdateOverlayCore } from '../cores/ui/update-overlay.js';
import { createMemoryGraphPanelCore } from '../cores/ui/memory-graph-panel.js';
import { createPicturePanelCore } from '../cores/ui/picture-panel.js';
import { createRunnerCore, STME_PATHS } from '../cores/runner/index.js';
import { createModuleInstaller } from '../cores/runner/installer.js';

/**
 * Версия движка для проверки `engine:` в шапках Модулей (RUNTIME.md). Совпадает с версией в manifest.json (без хвоста «Beta»).
 */
export const ENGINE_VERSION = '0.2.1';

/**
 * Встроенные Модули — только ГДЕ они лежат. Всё остальное (id, название, права, зависимости) живёт в шапке самого файла и читается
 * Раннером ([cores/runner/index.js](../cores/runner/index.js)) как текст. Списка путей не избежать: у браузера нет «прочитать папку»,
 * а динамический `import()` нужен литералом, чтобы сборщик/ST его вообще нашёл.
 *
 * Права встроенных намеренно `community` с явным списком контрактов, а не `official`: Модуль, который едет вместе с движком, всё равно
 * обязан ходить тем же путём, что и чужой, — иначе Гейт на этом пути никогда бы не проверялся.
 */
export const BUILTIN_MODULES = [
    { origin: 'builtin', path: 'modules/tracker/index.js', load: () => import('../modules/tracker/index.js') },
    { origin: 'builtin', path: 'modules/time/index.js', load: () => import('../modules/time/index.js') },
    { origin: 'builtin', path: 'modules/tools/notebook.js', load: () => import('../modules/tools/notebook.js') },
    { origin: 'builtin', path: 'modules/tools/secrets.js', load: () => import('../modules/tools/secrets.js') },
    { origin: 'builtin', path: 'modules/postprocess/index.js', load: () => import('../modules/postprocess/index.js') },
    { origin: 'builtin', path: 'modules/music/index.js', load: () => import('../modules/music/index.js') },
    { origin: 'builtin', path: 'modules/scene-painter/index.js', load: () => import('../modules/scene-painter/index.js') },
    { origin: 'builtin', path: 'modules/speaker-colors/index.js', load: () => import('../modules/speaker-colors/index.js') },
    { origin: 'builtin', path: 'modules/map/index.js', load: () => import('../modules/map/index.js') },
];

/** Текст встроенного Модуля — ради шапки. В браузере это fetch того же файла; в Node (тесты) — файловая система. */
async function readBuiltinSource(path) {
    const url = new URL(`../${path}`, import.meta.url);
    if (url.protocol === 'file:') return (await import('node:fs/promises')).readFile(url, 'utf8');
    const response = await globalThis.fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return response.text();
}

/** Раннер со встроенными Модулями; `ready` — когда определения готовы (реестр ждёт его в `restore()`). */
export function createBuiltinRunner({ engine, entries = BUILTIN_MODULES } = {}) {
    const runner = createRunnerCore({
        engineVersion: ENGINE_VERSION,
        readSource: readBuiltinSource,
        resolveStme: path => (STME_PATHS[path] ? new URL(`../${STME_PATHS[path]}`, import.meta.url).href : null),
        isQuarantined: id => Boolean(engine?.rights?.isQuarantined?.(id)),
    });
    const ready = runner.discover(entries);
    return { runner, ready };
}

const RUNNER_NAMESPACE_KEY = 'core.runner';
/** Резерв на случай, если вызвали до первой сборки: id встроенных известны заранее. */
const BUILTIN_IDS_FALLBACK = ['module.tracker', 'module.time', 'module.notebook', 'module.secrets', 'module.postprocess', 'module.music', 'module.scenePainter', 'module.speakerColors', 'module.map'];

/**
 * Полный рантайм: Раннер + установщик внешних Модулей. Список установленных и карантин лежат в `storage.settings` под неймспейсом
 * Раннера; сеть для скачивания идёт через сетевую Шину от ОТДЕЛЬНОГО Ядра с `networkAccess` — самим Модулям сеть для этого не нужна.
 * Нарушение прав внешним Модулем (карантин) сохраняется сразу и действует и после перезапуска.
 */
export function createModuleRuntime({ engine, storageHost, entries = BUILTIN_MODULES, importBlob } = {}) {
    const networkHost = engine.registerCaller('core.runner.installer', 'cores', { tier: 'official', networkAccess: true });
    const store = {
        read: async (key, fallback) => {
            const result = await request(storageHost.own, 'storage.settings.get', { params: { namespace: RUNNER_NAMESPACE_KEY, key, fallback } });
            return result.ok ? result.value ?? fallback : fallback;
        },
        write: (key, value) => request(storageHost.own, 'storage.settings.set', { params: { namespace: RUNNER_NAMESPACE_KEY, key, value } }),
    };

    const fetchText = async url => {
        const result = await request(networkHost.network, 'http.request', { params: { url, method: 'GET' }, timeoutMs: 20000 });
        return result.ok ? { ok: Boolean(result.value?.ok), status: result.value?.status, text: result.value?.text ?? '' } : { ok: false, status: 0, text: '' };
    };

    let runner = null;
    const resolveStme = path => (STME_PATHS[path] ? new URL(`../${STME_PATHS[path]}`, import.meta.url).href : null);
    const installer = createModuleInstaller({
        fetchText, store, resolveStme,
        reservedIds: () => (runner?.definitions ?? []).filter(item => item.origin === 'builtin').map(item => item.id).concat(BUILTIN_IDS_FALLBACK),
    });
    runner = createRunnerCore({
        engineVersion: ENGINE_VERSION,
        readSource: readBuiltinSource,
        ...(importBlob ? { importBlob } : {}),
        resolveStme: path => (STME_PATHS[path] ? new URL(`../${STME_PATHS[path]}`, import.meta.url).href : null),
        isQuarantined: id => installer.isQuarantined(id) || Boolean(engine.rights.isQuarantined(id)),
    });
    engine.rights.onViolation(violation => { void installer.recordQuarantine(violation); });

    const rediscover = () => runner.discover([...entries, ...installer.sources()]);
    const ready = installer.load().then(rediscover);
    return { runner, installer, ready, rediscover };
}

/** Где реестр помнит, что было включено. Неймспейс Раннера, а не Модуля: это состояние ЗАПУСКА, а не настройка кого-то из них. */
const RUNNER_NAMESPACE = 'core.runner';
const ENABLED_KEY = 'enabledModules';

export function createModuleRegistry({ engine, uiModules, panelSettled, panelRoot, storageHost, onChanged = () => {}, definitions, ready = Promise.resolve(), problems = () => [], installer = null, rediscover = async () => {} }) {
    const live = new Map(); // id -> { instance, finalUi }
    const lastErrors = new Map(); // id -> текст последней неудачной попытки включить
    // Локальная ссылка на состав: тестам (и только им) можно подсунуть свой
    // список лёгких Модулей вместо настоящих определений Раннера — реестру нужен
    // интерфейс Модуля (`create`/`load`/`tree`), не его начинка.
    const DEFS = definitions ?? [];

    /**
     * Кладёт корни включённых Модулей в выделенные им слоты. Отдельным шагом и
     * идемпотентно, потому что слот появляется только ПОСЛЕ того, как панель
     * перерисовалась, а перерисовывается она от смены состава — то есть от
     * того же вызова, что сюда и привёл. Пытаться угадать порядок хуже, чем
     * один раз честно дождаться и доложить корни на место.
     */
    async function attach() {
        await panelSettled();
        // Ищем ВНУТРИ корня панели, а не по всему документу. Корень попадает
        // на страницу позже — его вешает тот, кто собрал движок, — и поиск по
        // `document` во время восстановления состава не находил ничего:
        // Модули включались, слоты рисовались, а деревья оставались снаружи.
        const root = panelRoot?.() ?? document;
        for (const [id, entry] of live) {
            const slot = root.querySelector(`.stme-module-slot[data-module="${id}"]`);
            if (slot && !slot.contains(entry.finalUi.getRoot())) slot.append(entry.finalUi.getRoot());
        }
    }

    /**
     * Список включённых — в Ядро сохранения, тем же способом, что и всё
     * остальное персистентное (см. persisted-list.js). Отдельного «Ядра
     * состояния» для этого не нужно: `storage.settings` и есть Ядро
     * сохранения, ему просто никто не рассказывал про состав Модулей.
     *
     * Пишем СПИСОК ЦЕЛИКОМ после каждой смены, а не по одному ключу на Модуль:
     * иначе удалённый из сборки Модуль оставлял бы за собой вечный `false`.
     */
    function remember() {
        return request(storageHost.own, 'storage.settings.set', {
            params: { namespace: RUNNER_NAMESPACE, key: ENABLED_KEY, value: [...live.keys()] },
        });
    }

    /**
     * Восстановление состава при запуске. Зовётся ОДИН раз и явно — тем, кто
     * собирает движок, и строго после панели: Модулю нужен слот, а слот
     * появляется только когда панель отрисована.
     *
     * Незнакомый id молча пропускается: сборка могла измениться между
     * запусками, и падать из-за Модуля, которого больше нет, — худшее из
     * возможных поведений при старте.
     */
    async function restore() {
        // Состав Модулей приходит от Раннера асинхронно (шапки читаются как текст) — без этого `DEFS` ещё пуст.
        await ready;
        const result = await request(storageHost.own, 'storage.settings.get', {
            params: { namespace: RUNNER_NAMESPACE, key: ENABLED_KEY, fallback: [] },
        });
        const wanted = (result.ok ? result.value ?? [] : []).filter(id => DEFS.some(item => item.id === id));
        for (const id of wanted) {
            try { await enable(id, { remember: false }); }
            catch (error) { console.warn(`[ST Module Engine (Beta)] Could not bring back module "${id}":`, error); }
        }
        return wanted;
    }

    async function enable(id, { remember: shouldRemember = true } = {}) {
        if (live.has(id)) return true;
        const definition = DEFS.find(item => item.id === id);
        if (!definition) throw new Error(`module "${id}" is not installed.`);

        // Карантин (нарушил права) действует и на включение: «не включится обратно в рамках установки».
        if (engine.rights?.isQuarantined?.(definition.id)) throw new Error(`module "${id}" is quarantined.`);

        const moduleHost = engine.registerCaller(definition.id, 'modules', definition.rights);
        let instance = null;
        let finalUi = null;
        try {
            instance = await definition.create(moduleHost);
            await instance.load();
            finalUi = uiModules.enable(definition.id, instance.tree());
            await finalUi.settled();
        } catch (error) {
            // Сбой при включении не оставляет половину Модуля: подписки и дерево снимаются, остальные Модули не затронуты.
            try { instance?.stop?.(); } catch { /* уже сломан — важнее доложить исходную ошибку */ }
            if (finalUi) uiModules.disable(definition.id);
            lastErrors.set(id, error?.message ?? String(error));
            throw error;
        }
        lastErrors.delete(id);
        live.set(id, { instance, finalUi });

        // Модуль вправе иметь ВТОРОЕ дерево — плавающее окно поверх страницы
        // (у трекера это состояние из шины). Оно не в панели, поэтому и
        // монтируется своим Final UI прямо в body.
        if (typeof instance.hud === 'function') {
            const hudUi = uiModules.enable(`${definition.id}:hud`, instance.hud());
            await hudUi.settled();
            document.body.append(hudUi.getRoot());
            live.get(id).hudUi = hudUi;
        }

        onChanged();   // панель узнаёт о новом составе и рисует слот
        await attach(); // и только теперь в этот слот кладётся дерево Модуля
        // Восстановление состава НЕ перезаписывает то, что само же читает.
        if (shouldRemember) await remember();
        return true;
    }

    async function disable(id) {
        const entry = live.get(id);
        if (!entry) return false;
        entry.instance.stop?.();
        entry.hudUi?.getRoot()?.remove();
        uiModules.disable(`${id}:hud`);
        uiModules.disable(id);
        live.delete(id);
        onChanged();
        await remember();
        return true;
    }

    /**
     * Попросить Модуль показать/спрятать его HUD-окно. GENERIC-канал для
     * точек входа мимо панели (например, кнопки в лаунчере-доке): вызывающий
     * знает только id Модуля и НЕ знает, есть ли у того hud-дерево вообще —
     * вернётся false, и кнопка не сделает вид, что что-то открыла. Никакого
     * хардкода «открыть именно Music» ни в доке, ни здесь.
     *
     * ТУМБЛЕР (решено с пользователем: «с музыкой и графом сделай также,
     * чтобы закрывались»): если HUD уже виден — прячем, а не переоткрываем.
     * Модуль отчитывается о видимости сам (`hudVisible`-сигнал или
     * `isHudVisible()` — у Модулей нет единого канонического вида), поэтому
     * здесь два защитных способа спросить; нет ни того, ни другого —
     * считаем скрытым и просто показываем.
     */
    function requestHud(id) {
        const entry = live.get(id);
        if (!entry) return false;
        const instance = entry.instance;
        if (typeof instance?.setHudVisible !== 'function') return false;
        const visibleNow = typeof instance.isHudVisible === 'function'
            ? Boolean(instance.isHudVisible())
            : Boolean(instance.hudVisible?.peek?.());
        instance.setHudVisible(!visibleNow);
        return true;
    }

    /**
     * Подвести живой состав к ЖЕЛАЕМОМУ списку — включить недостающих,
     * выключить лишних, одним вызовом. Потребитель — импорт пресета
     * (карточка Preset панели движка): снапшот бэкапа восстанавливает
     * `core.runner.enabledModules` внутри extensionSettings, но это лишь
     * ЗАПИСЬ — живые экземпляры она сама не строит и не снимает. Ровно
     * тот же разрез, что у `restore()` при старте: настройка — данные,
     * состав — работа реестра.
     *
     * Незнакомые id из целевого списка молча пропускаются (сборка могла
     * измениться — та же дисциплина, что в `restore()`); восстанавливать
     * смысл не имеет: сохранение ИСТИННОГО состава делает сам
     * enable/disable через remember(), и он совпадёт с целевым минус
     * пропущенные.
     */
    async function reconcile(wantedIds = []) {
        const wanted = (wantedIds ?? []).filter(id => DEFS.some(item => item.id === id));
        const currentlyEnabled = [...live.keys()];
        for (const id of wanted) {
            if (!live.has(id)) {
                try { await enable(id); }
                catch (error) { console.warn(`[ST Module Engine (Beta)] Could not bring in module "${id}" during preset import:`, error); }
            }
        }
        for (const id of currentlyEnabled) {
            if (!wanted.includes(id)) await disable(id);
        }
        return { enabled: [...live.keys()] };
    }

    /**
     * Установить Модуль, показанный `installer.preview()`: сохранить, пересобрать состав и (если он уже был включён) подменить живой
     * экземпляр на новую версию. Само ВКЛЮЧЕНИЕ остаётся отдельным решением пользователя.
     */
    async function installModule(previewResult) {
        if (!installer) throw new Error('no installer is wired.');
        const record = await installer.install(previewResult);
        const wasLive = live.has(record.id);
        if (wasLive) await disable(record.id);
        await rediscover();
        onChanged();
        if (wasLive && DEFS.some(item => item.id === record.id)) await enable(record.id);
        return record;
    }

    async function uninstallModule(id) {
        if (!installer) throw new Error('no installer is wired.');
        if (live.has(id)) await disable(id);
        const removed = await installer.uninstall(id);
        await rediscover();
        onChanged();
        return removed;
    }

    /** Снять карантин — только явным решением пользователя; потом состав пересобирается, и Модуль снова можно включить. */
    async function releaseQuarantine(id) {
        if (!installer) throw new Error('no installer is wired.');
        const released = await installer.releaseQuarantine(id);
        if (released) { engine.rights.unquarantine(id); await rediscover(); onChanged(); }
        return released;
    }

    return {
        installModule, uninstallModule, releaseQuarantine,
        installer,
        list: () => DEFS.map(({ id, title, description, folder, version, origin, tier }) => ({ id, title, description, folder, version, origin, tier, error: lastErrors.get(id) ?? null })),
        /** Источники, которые Раннер не смог превратить в Модуль, — с причиной (плохая шапка, отказ скана, нет зависимости). */
        problems,
        enabled: () => [...live.keys()],
        instance: id => live.get(id)?.instance,
        /** Настройки, которые Модуль разрешил менять гиду (`guideSettings()` → `{ specs, save }`); `null` — Модуль выключен или ничего не объявил. */
        guideSettings: id => live.get(id)?.instance?.guideSettings?.() ?? null,
        /** Инструменты, которые Модуль дал гиду сверх настроек (`guideTools()`: чтение состояния для промпта и операции над его данными); `null` — выключен или не объявил. */
        guideTools: id => live.get(id)?.instance?.guideTools?.() ?? null,
        requestHud,
        enable,
        disable,
        restore,
        reconcile,
    };
}


/**
 * Wires one real `createEngine()` with every Core/Service built so far —
 * shared verbatim between the standalone browser harness
 * ([harness/main.js](main.js), fake ST context) and the real SillyTavern
 * entry point ([../index.js](../index.js), real ST context) so the two can
 * never drift apart. NOT the real Раннер from ARCHITECTURE.md/ROADMAP.md —
 * that still needs generic Module loading and a real semver/compatibility
 * gate; this is deliberately just enough hardcoded wiring to prove the
 * built Ядра/Сервисы actually run, in a browser and inside real ST.
 *
 * `getContext`/`fetch` are the only two things that differ between the
 * harness and real ST — everything else is identical.
 *
 * Async — `restoreWorkers()`/`restoreTrackers()`/`restorePrograms()` each
 * do a real `storage.settings.get` round trip so configuration genuinely
 * survives a reload (see [persisted-list.js](../libraries/core/persisted-list.js))
 * instead of resetting to empty every boot, which is what all three did
 * before Ядро сохранения existed.
 */
/**
 * Репозиторий, из которого движок обновляет сам себя. Захардкожен намеренно, а
 * не берётся из `remoteUrl`, который отдаёт ST: тот — правда о том, что
 * настроено у git локально, а нам нужна правда о том, откуда проект ДОЛЖЕН
 * приезжать. Сбитый локальный remote не должен превращать сверку в проверку
 * самого себя.
 */
export const CORE_REPO = Object.freeze({ owner: 'IAmiGOI', repo: 'Module-Engine' });
/** Музыкальный сервер владельца (tools/music-server): адрес и ключ чтения. Пустой адрес — функция выключена, в Music ничего не появляется. */
const MUSIC_SERVER = { url: 'https://45-38-19-165.sslip.io:24817', key: '63F3JcY2lDtXIroj' };

/** Репозиторий с фонами: любой файл-картинка/видео, положенный туда, сам появляется в списке фонов ST (cores/backgrounds). */
export const BACKGROUNDS_REPO = Object.freeze({ owner: 'IAmiGOI', repo: 'Module-Engine-Backgrounds' });

// `fetch` по умолчанию ПРИВЯЗАН к глобальному объекту: браузерный `fetch`
// требует, чтобы `this` был окном, и вызов «голой» ссылки отвечает «Illegal
// invocation».
export async function wireEngine({ getContext, fetch = globalThis.fetch?.bind(globalThis), interceptTarget = globalThis, scriptUrl = import.meta.url }) {
    const engine = createEngine();

    registerDomService(engine.buses.services);
    registerHttpService(engine.buses.network, { fetch });
    registerChatMetadataService(engine.buses.services, { getContext });
    // Сами сообщения чата — отдельно от метаданных: без них трекер опрашивал бы
    // модель по переписке, которой она не видела.
    registerStChatService(engine.buses.services, { getContext });
    // Родной стартовый экран ST (данные недавних чатов и нажатия его кнопок) — для нашего главного экрана из блоков.
    registerStHomeService(engine.buses.services, { getContext });
    // Растеризация HTML в текстуру и композитинг WebGL для Chat Viewport
    // (план `chat-viewport`) — обе на настоящих браузерных возможностях,
    // никакого фейка/инъекции здесь не нужно вне тестов.
    registerHtmlRasterizerService(engine.buses.services);
    registerWebglRendererService(engine.buses.services);
    registerRasterCacheService(engine.buses.services);
    registerTextPainterService(engine.buses.services);
    registerGlAnimationService(engine.buses.services);
    registerStBackgroundsService(engine.buses.services, { getContext });
    registerImageScaleService(engine.buses.services);
    registerStUserDataService(engine.buses.services, { getContext });
    registerSyncStateService(engine.buses.services);
    // Сеть синхронизации — на сетевой Шине (как `http.request`): проходит сетевой Гейт, доступна только Ядрам с `networkAccess`.
    registerSyncSignalService(engine.buses.network);
    registerSyncPeerService(engine.buses.network);
    // Локальный эмбединг — не сетевой вызов через `http.request` (см.
    // doc-comment services/embedding.js за честной оговоркой: сама закачка
    // весов модели идёт мимо нашего Гейта сети, это делает сторонняя
    // библиотека изнутри себя).
    registerEmbeddingService(engine.buses.services);
    registerAudioStoreService(engine.buses.services);
    registerImageStoreService(engine.buses.services);
    registerGraphLibraryService(engine.buses.services);
    registerPmPresetsService(engine.buses.services);
    registerStPromptDataService(engine.buses.services, { getContext });
    registerStPmUiService(engine.buses.services);
    registerAudioPlaybackService(engine.buses.services, { crossfadeMs: 2500 });   // смена трека плавная, как в кино
    registerExtensionSettingsService(engine.buses.services, { getContext });
    registerFileService(engine.buses.services);
    registerStMacrosService(engine.buses.services, { getContext });
    registerStLorebookService(engine.buses.services, { getContext });
    registerStCharacterService(engine.buses.services, { getContext });
    registerStCharacterCardsService(engine.buses.services, { getContext, fetch });
    registerCharacterCardVersionsService(engine.buses.services);
    registerStWebSearchService(engine.buses.services, { getContext, fetch });
    registerStCharacterAvatarService(engine.buses.services, { getContext, fetch });
    registerStEventsService(engine.buses.services, { getContext });
    registerStToolsService(engine.buses.services, { getContext });
    // Только для чтения — гид анализирует их, править остаётся за родными экранами ST (см. doc-comment обоих Сервисов).
    registerStWorldInfoService(engine.buses.services);
    registerStPresetService(engine.buses.services, { getContext });
    registerStDrawerGuard(engine.buses.services);
    // Сервис перехвата: сюда встанут обе точки, которыми движок забирает
    // отправку себе. `interceptTarget` — «глобальный объект», на который
    // ставится именованная функция перехватчика и чей `fetch` подменяется;
    // в реальном ST это window, в харнессе — его собственный поддельный ST.
    registerStGenerationService(engine.buses.services, { target: interceptTarget, getContext });
    // Git-эндпоинты ST и сессия страницы — всё, что нужно самообновлению.
    // `fetch` передаётся ЯВНО. Значение по умолчанию (`globalThis.fetch`)
    // вызывалось бы без получателя, а браузерный `fetch` требует, чтобы `this`
    // был окном, и отвечает на такой вызов «Illegal invocation». Проверка
    // обновления падала на первом же запросе и молча превращалась в «проверить
    // нечего» — то есть самообновление не работало вовсе, ни разу и без следа.
    registerStExtensionsService(engine.buses.services, { getContext, fetch });
    registerSessionService(engine.buses.services);

    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    // Общая инфраструктура для «привязать что-то к КОНКРЕТНОМУ сообщению» —
    // сообщения с их `mesid` (Модулям Сервисы не видны напрямую) и хранилище
    // аннотаций поверх Ядра памяти чата. Строится сразу после него — оба его
    // контракта (`chatHistory.messages`/`annotate`/`annotations`) зависят от
    // `stChat.messages` и `storage.chatMemory`, уже зарегистрированных выше.
    createChatHistoryCore(engine.registerCaller('core.chatHistory', 'cores', { tier: 'official' }));
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const backupHost = engine.registerCaller('core.backup', 'cores', { tier: 'official' });
    const backupCore = createBackupCore(backupHost);
    backupCore.registerSource('chatMemory', createChatMetadataBackupSource(backupHost));
    backupCore.registerSource('settings', createExtensionSettingsBackupSource(backupHost));
    backupCore.registerSource('graphLibrary', createGraphLibraryBackupSource(backupHost)); // сохранённые графы памяти — и в бэкап, и в пресет
    backupCore.registerSource('pmPresets', createPmPresetsBackupSource(backupHost)); // пресеты Prompt Manager

    // Ядро событий строится раньше всех, кто публикует события: они получают
    // его `publish` при сборке, чтобы защиты и реестр видели ВСЮ поверхность,
    // а не только мост ST.
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));

    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost, {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.models.internal' }),
    });
    // Ядро diffusion — генерация картинок: сеть (бэкенды) и байты (хранилище картинок) только у него, не у Модулей.
    const diffusionHost = engine.registerCaller('core.models.diffusion', 'cores', { tier: 'official', networkAccess: true });
    const diffusionCore = createDiffusionCore(diffusionHost, {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.models.diffusion' }),
    });

    // Исполнитель объявленных этапов. `resolveAs` — привилегированная
    // возможность из сборки движка: этап обязан идти под правами СВОЕГО
    // владельца, иначе пайплайн стал бы обходным путём вокруг Гейтов.
    const pipelineCore = createPipelineCore(engine.registerCaller('core.pipeline', 'cores', { tier: 'official' }), {
        resolveAs: engine.resolveAs,
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.pipeline' }),
    });

    // Читает уже мостированные `st.generation*` и превращает их в именованные
    // моменты PIPELINE.md; инструменты регистрируются через него, поэтому их
    // вызовы объявляются сами, поштучно и вместе с упавшими (пакетные
    // TOOL_CALLS_* самого ST этого не дают). Оркестрацию вкладов
    // на своих точках оно НЕ пишет само — отдаёт Ядру пайплайнов.
    const generationCore = createGenerationCore(engine.registerCaller('core.generation', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.generation' }),
        pipelines: pipelineCore,
    });
    // Prompt Manager (PROMPT_MANAGER_PLAN.md): своя сборка промпта на `generation.payload`; без активного пресета ничего не меняет.
    const promptManagerCore = createPromptManagerCore(engine.registerCaller('core.promptManager', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.promptManager' }),
    });
    // ST's own drawers (API Connections, World Info, Preset…) close on any click that isn't on them; a click in the engine's own UI
    // (the panel, the guide's chat) counts as "elsewhere" too — see services/st-drawer-guard.js. Always on, no user-facing toggle.
    // `install()` MUST actually be awaited here — creating the Core alone does nothing (found live: the guard never engaged at all,
    // drawers kept closing, because this call was missing entirely on the first pass).
    const drawerGuardCore = createDrawerGuardCore(engine.registerCaller('core.drawerGuard', 'cores', { tier: 'official' }));
    await drawerGuardCore.install();

    // macrosCore built before trackingCore — its hook needs a real
    // reference to call into (see cores/tracking/index.js's own doc comment
    // on this exact deferred-integration point, now wired for real).
    const macrosCore = createMacrosCore(engine.registerCaller('core.macros', 'cores', { tier: 'official' }));
    const trackingCore = createTrackingCore(engine.registerCaller('core.tracking', 'cores', { tier: 'official' }), {
        onUserFieldRegistered: ({ trackerId, fieldName, value }) => macrosCore.setValueMacro(`${trackerId}_${fieldName}`, value),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.tracking' }),
    });
    // Реагирует на реальные `st.worldinfoUpdated`/`st.worldinfoSettingsUpdated`/
    // `st.chatChanged` (уже смощённые Ядром событий выше — без единой
    // строчки моста с нашей стороны) и публикует записи через Ядро macros —
    // строится после обоих.
    // Реестр говорящих (CORES.md) — та же переиспользуемая-инфраструктура
    // трактовка, что уже принята для Ядра трекинга: сейчас единственный
    // потребитель — Модуль «Speaker Colors», но контракт публичный, не
    // спрятанный внутри одного Модуля.
    const speakerCore = createSpeakerCore(engine.registerCaller('core.speaker', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.speaker' }),
    });

    // Ядро карты локаций (CORES.md, MAP.md) — backend-only так далеко (пока
    // нет ни одного Модуля-потребителя, эта строка регистрирует его контракты
    // на Шине ядер уже сейчас, чтобы дальнейшая работа над UI-редактором не
    // требовала ничего менять здесь).
    const mapCore = createMapCore(engine.registerCaller('core.map', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.map' }),
    });

    // Ядро «Навигация по упоминаниям» (ROADMAP.md, владелец: "добавь
    // отдельное ядро парсинга сообщений") — намеренно ОТДЕЛЬНОЕ от Ядра
    // карты, регистрирует свой собственный этап `generation.beforeSend`
    // (та же живая мутация `chat`, что уже делают Notebook/Secrets/Summary),
    // поэтому строится здесь же, рядом с остальными вкладчиками пайплайна.
    const mapNarrationCore = createMapNarrationCore(engine.registerCaller('core.mapNarration', 'cores', { tier: 'official' }));

    const lorebookCore = createLorebookCore(engine.registerCaller('core.lorebook', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.lorebook' }),
    });

    // Классификатор (Jev): ответы на вопросы-утверждения для условий блоков Prompt Manager; ходит в сеть, поэтому `networkAccess`.
    const classifierCore = createClassifierCore(engine.registerCaller('core.classifier', 'cores', { tier: 'official', networkAccess: true }));

    // Карточки персонажей ST: чтение, создание и правка всех полей (гид и любые Модули — через контракты `characterCards.*`).
    const characterCardsCore = createCharacterCardsCore(engine.registerCaller('core.characterCard', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.characterCard' }),
    });

    // Свёртка старой истории в иерархию саммари — регистрирует свои же этапы
    // на `generation.prepare` (порог + фолд) и `generation.beforeSend`
    // (инъекция активных саммари в `chat`), поэтому строится ПОСЛЕ Ядра
    // пайплайнов/генерации выше, как и остальные вкладчики.
    const summaryCore = createBasicSummaryCore(engine.registerCaller('core.summary', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.summary' }),
    });

    // Граф памяти (MEMORY_GRAPH.md, Phase 1) — "TopTier" долгосрочная память,
    // параллельная BasicSummary ("LowTier"). Tier-переключатель между ними —
    // Phase 3, здесь оба Ядра активны безусловно одновременно.
    const memoryGraphCore = createMemoryGraphCore(engine.registerCaller('core.memoryGraph', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.memoryGraph' }),
    });

    const uiHost = engine.registerCaller('core.ui.engine', 'cores', { tier: 'official' });
    // Один и тот же поток патчей — разные финальные рендереры по платформе
    // (CORES.md): на мобильной поверхности работает Android-ядро, чей корень
    // несёт `stme-android` и на которую CSS отвечает компактной вёрсткой.
    const createFinalUi = isMobileSurface() ? () => createFinalUiAndroid(uiHost) : () => createFinalUiPc(uiHost);
    const uiEngine = createUiEngineCore(createFinalUi);

    // Визуальный редактор графа памяти — своё `official`-Ядро, свой
    // floating-корень через `uiEngine.mount()`, тем же способом, что
    // notifications/updateOverlay ниже (решено с пользователем: большое
    // окно, не секция общей панели настроек). `core.memoryGraph` и
    // `core.ui.memoryGraph` оба в домене `cores` — Ядро↔Ядро остаётся на
    // ОДНОЙ Шине, контракты `memoryGraph.*` достижимы через `host.own`
    // самого Ядра UI без Гейта.
    const memoryGraphPanel = createMemoryGraphPanelCore(
        engine.registerCaller('core.ui.memoryGraph', 'cores', { tier: 'official' }),
        { mount: node => uiEngine.mount('memoryGraph', node) },
    );

    // Prompt Manager: своё плавающее окно, открывается иконкой ST «AI Response Configuration», перехваченной
    // сервисом (services/st-pm-ui.js) — родная панель ST под ней не открывается вообще (ROADMAP.md 5.141).
    const promptManagerPanel = createPromptManagerPanelCore(
        engine.registerCaller('core.ui.promptManager', 'cores', { tier: 'official' }),
        { mount: node => uiEngine.mount('promptManager', node) },
    );

    // Плавающее окно «Картинка» — та же форма официального UI-Ядра, что у
    // окна графа выше (решено с пользователем: кнопка дока с видом картинки
    // получает РАСШИРЯЕМУЮ плавающую панель, как у музыки/трекера, только
    // крупнее — дефолт 3:4). Показывает перетащенный файл или картинку по
    // ссылке; ссылка идёт ПОЛНЫМ МАРШРУТОМ: сетевой Гейт → Сервис HTTP —
    // поэтому `networkAccess: true` (не подразумевается уровнем доверия).
    const picturePanel = createPicturePanelCore(
        engine.registerCaller('core.ui.picture', 'cores', { tier: 'official', networkAccess: true }),
        { mount: node => uiEngine.mount('picture', node) },
    );
    // У Модулей СВОЙ реестр UI, отдельный от слотов движка: у каждого
    // включённого Модуля свой независимый Final UI, иначе пути их деревьев
    // столкнулись бы в одной карте (см. ui-mount-registry.js).
    const uiModulesHost = engine.registerCaller('core.ui.modules', 'cores', { tier: 'official' });
    const uiModules = createUiModulesCore(() => createFinalUiPc(uiModulesHost));

    // Уведомления — отдельное UI-Ядро: у поверхности есть свой жизненный цикл
    // (очередь, автоснятие), а значит это не слот. Своя цель монтирования,
    // потому что стек висит в углу ЭКРАНА, а не внутри панели.
    const notifications = createNotificationsCore(
        engine.registerCaller('core.ui.notifications', 'cores', { tier: 'official' }),
        // Логика (очередь, автоснятие) — в самом Ядре; МЕСТО ему даёт обычный
        // именованный слот Ядра UI для Engine, как и панели. Своего механизма
        // монтирования заводить незачем.
        { mount: node => uiEngine.mount('notifications', node) },
    );

    // Светофор активности: слушает события начала/конца работы ВСЕХ Ядер
    // (генерация, трекинг, саммари, самообновление) и уведомлений, сводит их
    // в одно состояние — а полоску пилюли-дока красит по нему index.js
    // (пилюля живёт мимо движка, поэтому ей отдаётся сам сигнал).
    // Ядро WebGL-анимаций: общий цикл кадров и реестр маленьких эффектов (см. cores/ui/gl-animations.js).
    const glAnimations = createGlAnimationsCore(engine.registerCaller('core.ui.glAnimations', 'cores', { tier: 'official' }));
    // Фоны из отдельного репозитория: единственное ещё Ядро с правом выхода в сеть (как самообновление).
    const backgrounds = createBackgroundsCore(
        engine.registerCaller('core.backgrounds', 'cores', { tier: 'official', networkAccess: true }),
        { ...BACKGROUNDS_REPO, publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.backgrounds' }) },
    );
    // Разделы и векторы треков с музыкального сервера владельца: единственное, что Music берёт из сети (аудио потом тянет плеер по прямой ссылке).
    const musicServer = createMusicServerCore(engine.registerCaller('core.musicServer', 'cores', { tier: 'official', networkAccess: true }), { server: MUSIC_SERVER });
    // Синхронизация файлов между устройствами (напрямую по WebRTC) и с репозиторием GitHub. Запускается из index.js вместе с фонами.
    const syncCore = createSyncCore(
        engine.registerCaller('core.sync', 'cores', { tier: 'official', networkAccess: true }),
        { publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.sync' }) },
    );
    // Порядок запуска (самообновление → фоны → синхронизация → экран загрузки) — контрактами, не ссылками; вызывается из index.js.
    const startup = createStartupCore(
        engine.registerCaller('core.startup', 'cores', { tier: 'official' }),
        { screen: globalThis.__stmeBoot },
    );
    const activityLight = createActivityLightCore(
        engine.registerCaller('core.ui.activityLight', 'cores', { tier: 'official' }),
    );
    activityLight.load();

    // First Load — счётчик запусков движка. Само Ядро НЕ вызывает свой
    // `load()` на конструкции: инкремент выполняется ниже, СТРОГО после
    // восстановления конфигурации (см. comment у `Promise.all`), иначе
    // «первый запуск» объявился бы раньше, чем на диске вообще что-то есть.
    // Событие `firstLoad.firstLaunch` — подписка index.js'а на начало
    // онбординга; само Ядро про UI не знает.
    const firstLoad = createFirstLoadCore(
        engine.registerCaller('core.firstLoad', 'cores', { tier: 'official' }),
        { publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.firstLoad' }) },
    );
    void FIRST_LAUNCH_EVENT; // экспортируется наружу для подписчиков (см. return)

    // Полоса под последним сообщением: три независимых виджета, во всю ширину
    // чата. Модель её не видит вовсе — она живёт только в DOM.
    const messageFooterHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    const messageFooter = createMessageFooterCore(messageFooterHost, {
        createFinalUi: () => createFinalUiPc(messageFooterHost),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.messageFooter' }),
    });

    // Chat Viewport — гибридный WebGL/DOM рендер истории чата (план
    // `chat-viewport`): тело сообщения растеризуется в текстуру, действия
    // (delete/swipe/regenerate/edit) идут через `services/st-chat.js`'ы
    // обёртки над экспортированными функциями самой ST. Ядро строится, но
    // `attach()` не зовётся здесь — только по кнопке в харнессе (main.js),
    // чтобы можно было сравнить с нативным `#chat` рядом, а не подавлять его
    // безусловно на загрузке страницы.
    const chatViewportHost = engine.registerCaller('core.ui.chatViewport', 'cores', { tier: 'official' });
    const chatViewport = createChatViewportCore(chatViewportHost, {
        prerenderFactor: 4,
        textureBudgetBytes: 256 * 1024 * 1024, prefetchScreens: 3, prefetchConcurrency: 10, persistentCache: true,
        createFinalUi: () => createFinalUiPc(chatViewportHost),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.chatViewport' }),
    });

    // Собственная панель набора текста и левый док: включаются вместе с оверлеем Chat Viewport (карточка панели зовёт enable/disable).
    const inputBarHost = engine.registerCaller('core.ui.inputBar', 'cores', { tier: 'official' });
    const inputBar = createInputBarCore(inputBarHost, {
        touch: isMobileSurface(),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.inputBar' }),
    });

    // Главный экран из блоков вместо стартового экрана ST: включается вместе с Chat Viewport (карточка панели зовёт enable/disable).
    const home = createHomeCore(engine.registerCaller('core.ui.home', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.home' }),
        // Виджет рабочего стола получает СВОЮ личность на Шине модулей с правами из его описания — Гейт проверяет его, как любой Модуль.
        touch: isMobileSurface(),
        registerWidgetCaller: (widgetId, allowedContracts) => engine.registerCaller(`widget.${widgetId}`, 'modules', { tier: 'community', allowedContracts }),
    });

    let panelUi = null;
    // Самообновление: единственное Ядро, которому выдано право выходить в сеть
    // помимо моделей — оно сверяет наш код с GitHub напрямую.
    const selfUpdate = createSelfUpdateCore(
        engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official', networkAccess: true }),
        {
            extensionName: deriveExtensionName(scriptUrl),
            ...CORE_REPO,
            publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.selfUpdate' }),
        },
    );

    // Экран обновления: перекрытие страницы и полоса с «Retry». Про git не
    // знает ничего — только слушает объявления самообновления.
    const updateOverlay = createUpdateOverlayCore(
        engine.registerCaller('core.ui.updateOverlay', 'cores', { tier: 'official' }),
        { mount: node => uiEngine.mount('updateOverlay', node) },
    );

    let enginePanelRef = null;
    let hubRef = null;
    const moduleStorageHost = engine.registerCaller('core.runner', 'cores', { tier: 'official' });
    const { runner: moduleRunner, installer: moduleInstaller, ready: moduleRunnerReady, rediscover: rediscoverModules } = createModuleRuntime({ engine, storageHost: moduleStorageHost });
    void moduleRunnerReady.then(() => { enginePanelRef?.refreshModules(); void hubRef?.refresh(); });
    const modules = createModuleRegistry({
        engine,
        uiModules,
        definitions: moduleRunner.definitions,
        ready: moduleRunnerReady,
        problems: moduleRunner.problems,
        installer: moduleInstaller,
        rediscover: rediscoverModules,
        panelSettled: () => panelUi?.settled() ?? Promise.resolve(),
        panelRoot: () => panelUi?.getRoot() ?? null,
        // Своя личность на Шине ядер: состав помнится через то же Ядро
        // сохранения, что и всё остальное, а не отдельным ходом в обход.
        storageHost: moduleStorageHost,
        onChanged: () => { enginePanelRef?.refreshModules(); void hubRef?.refresh(); },
    });

    // Гид — маскот движка и его отдельный чат (не чат ST): знакомство, объяснения, ссылки на блоки, действия. Файлы сценария и знаний —
    // в папке `guide/` расширения; Модули — через реестр (действия «включить/выключить»).
    const guide = createGuideCore(engine.registerCaller('core.guide', 'cores', { tier: 'official', networkAccess: true }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.guide' }),
        mount: node => uiEngine.mount('guide', node),
        loadText: async path => { const response = await globalThis.fetch(new URL(`../guide/${path}`, import.meta.url), { cache: 'no-cache' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); },
        modules,
    });

    // Хаб — обзор панели из блоков «как глифы» с живым статусом; формы блоков остаются DOM-карточками панели (cores/ui/hub/). Привязывается к панелям в index.js.
    const hub = createHubCore(engine.registerCaller('core.ui.hub', 'cores', { tier: 'official' }), { modules });
    hubRef = hub;

    // Экран движка — тоже Ядро (движок без интерфейса не работает, и
    // пользователь его не подключает). К моделям он ходит контрактами, а не
    // по JS-ссылке: править эндпоинты и ключи в обход Шины было бы ровно тем,
    // от чего Гейты и защищают.
    const enginePanel = createEnginePanelCore(engine.registerCaller('core.ui.panel', 'cores', { tier: 'official' }), {
        mount: node => uiEngine.mount('settings', node),
        // Второе дерево Ядра — экран настроек (пресеты + апдейты, решено с
        // пользователем) — монтируется СВОИМ ключом, иначе деревья
        // столкнулись бы в одной карте реестра монтирований.
        mountSettings: node => uiEngine.mount('settingsScreen', node),
        listContracts: () => [
            ...engine.buses.cores.contracts(),
            ...engine.buses.services.contracts(),
            ...engine.buses.network.contracts(),
        ],
        modules,
        openMemoryGraphPanel: () => memoryGraphPanel.show(),
        chatViewport,
        inputBar,
        home,
    });
    enginePanelRef = enginePanel;

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
    panelUi = await enginePanel.open();
    await panelUi.settled();

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

    return { engine, musicServer, promptManagerCore, promptManagerPanel, modelsCore, trackingCore, macrosCore, lorebookCore, characterCardsCore, classifierCore, summaryCore, memoryGraphCore, memoryGraphPanel, picturePanel, eventsCore, generationCore, pipelineCore, uiEngine, uiModules, notifications, activityLight, glAnimations, backgrounds, syncCore, startup, messageFooter, chatViewport, inputBar, home, hub, selfUpdate, updateOverlay, modules, enginePanel, panelUi, firstLoad, firstLoadResult, FIRST_LAUNCH_EVENT, guide };
}
