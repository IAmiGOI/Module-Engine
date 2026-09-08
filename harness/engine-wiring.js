import { createEngine } from '../libraries/shared/engine.js';
import { request } from '../libraries/shared/request.js';
import { registerDomService } from '../services/dom.js';
import { registerHttpService } from '../services/http.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerEmbeddingService } from '../services/embedding.js';
import { registerAudioStoreService } from '../services/audio-store.js';
import { registerAudioPlaybackService } from '../services/audio-playback.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerFileService } from '../services/file.js';
import { registerStMacrosService } from '../services/st-macros.js';
import { registerStLorebookService } from '../services/st-lorebook.js';
import { registerStCharacterService } from '../services/st-character.js';
import { registerStEventsService } from '../services/st-events.js';
import { registerStToolsService } from '../services/st-tools.js';
import { registerStGenerationService } from '../services/st-generation.js';
import { registerStExtensionsService } from '../services/st-extensions.js';
import { registerSessionService } from '../services/session.js';
import { createSelfUpdateCore } from '../cores/self-update/index.js';
import { deriveExtensionName } from '../libraries/core/update-check.js';
import { createEventsCore } from '../cores/events/index.js';
import { createGenerationCore } from '../cores/generation/index.js';
import { createPipelineCore } from '../cores/pipeline/index.js';
import { createInternalEngineModelsCore } from '../cores/models/internal-engine.js';
import { createChatMemoryCore } from '../cores/memory/index.js';
import { createChatHistoryCore } from '../cores/chat-history/index.js';
import { createSettingsCore } from '../cores/settings/index.js';
import { createBackupCore, createChatMetadataBackupSource, createExtensionSettingsBackupSource } from '../cores/backup/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createMacrosCore } from '../cores/macros/index.js';
import { createLorebookCore } from '../cores/lorebook/index.js';
import { createBasicSummaryCore } from '../cores/summary/index.js';
import { createMemoryGraphCore } from '../cores/memory-graph/index.js';
import { createUiEngineCore } from '../cores/ui/ui-engine.js';
import { createEnginePanelCore } from '../cores/ui/engine-panel.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { createFinalUiAndroid, isMobileSurface } from '../cores/ui/final-ui-android.js';
import { createUiModulesCore } from '../cores/ui/ui-modules.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createActivityLightCore } from '../cores/ui/activity-light.js';
import { createMessageFooterCore } from '../cores/ui/message-footer.js';
import { createUpdateOverlayCore } from '../cores/ui/update-overlay.js';
import { createMemoryGraphPanelCore } from '../cores/ui/memory-graph-panel.js';
import { createTrackerModule, MODULE_ID as TRACKER_MODULE_ID } from '../modules/tracker/index.js';
import { createTimeModule, MODULE_ID as TIME_MODULE_ID } from '../modules/time/index.js';
import { createNotebookModule, MODULE_ID as NOTEBOOK_MODULE_ID } from '../modules/notebook/index.js';
import { createPostprocessModule, MODULE_ID as POSTPROCESS_MODULE_ID } from '../modules/postprocess/index.js';
import { createMusicModule, MODULE_ID as MUSIC_MODULE_ID } from '../modules/music/index.js';

/**
 * Реестр Модулей — временная замена настоящему Раннеру (ARCHITECTURE.md,
 * ROADMAP шаг 6): тот будет грузить Модули с диска и проверять
 * совместимость по semver. Здесь список захардкожен, но ВСЁ остальное
 * настоящее: у Модуля своя личность на Шине модулей, свои объявленные права,
 * свой независимый Final UI, и до Ядер он дотягивается только через Гейт.
 *
 * Права намеренно `community` с явным списком контрактов, а не `official`:
 * Модуль, который едет вместе с движком, всё равно обязан ходить тем же
 * путём, что и чужой, — иначе Гейт на этом пути никогда бы не проверялся.
 */
const DEFINITIONS = [{
    id: TRACKER_MODULE_ID,
    title: 'Tracker',
    description: 'Keeps named values up to date by asking a model, and exposes them as macros.',
    rights: {
        tier: 'community',
        allowedContracts: [
            'tracking.trackers', 'tracking.configure', 'tracking.fields', 'tracking.poll', 'tracking.reset',
            'model.workers.get', 'model.presets.get', 'model.presets.set', 'storage.settings.get', 'storage.settings.set', 'ui.notify',
            // «Обновиться до ответа» регистрируется этапом пайплайна
            // `generation.prepare` — значит Модулю нужно право трогать его состав.
            'pipeline.stages', 'pipeline.stages.add', 'pipeline.stages.remove',
        ],
    },
    create: host => createTrackerModule(host),
}, {
    id: TIME_MODULE_ID,
    title: 'RP Time',
    description: 'Works out in-world time from the conversation and keeps it as a macro.',
    rights: {
        tier: 'community',
        allowedContracts: [
            'tracking.trackers', 'tracking.configure', 'tracking.poll', 'tracking.reset',
            'storage.settings.get', 'storage.settings.set',
            // Сообщения с их `mesid` и привязка отметок времени к КОНКРЕТНОМУ
            // сообщению — через общее Ядро истории чата, не напрямую в
            // `storage.chatMemory` (Модулю туда и нет прямого пути).
            'chatHistory.messages', 'chatHistory.annotate', 'chatHistory.annotations', 'chatHistory.clearAnnotations',
            'model.workers.get', 'model.presets.get', 'model.presets.set', 'ui.notify', 'ui.messageFooter.claim', 'ui.messageFooter.release',
            'ui.messageFooter.liveMesid',
        ],
    },
    create: host => createTimeModule(host),
}, {
    id: NOTEBOOK_MODULE_ID,
    title: 'Notebook',
    description: 'A private notebook the AI can write to and read back — working memory for plans, secrets and goals.',
    rights: {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'storage.chatMemory.get', 'storage.chatMemory.set',
            'generation.registerTool', 'generation.unregisterTool',
            // Этап на `generation.beforeSend` исполняется под ЕГО правами
            // (см. cores/pipeline/index.js про `resolveAs`), но регистрирует
            // и снимает этап сам Модуль, отсюда — эти два права.
            'pipeline.stages.add', 'pipeline.stages.remove',
            'ui.notify',
        ],
    },
    create: host => createNotebookModule(host),
}, {
    id: POSTPROCESS_MODULE_ID,
    title: 'Post-Turn Processor',
    description: 'Rewrites each fresh reply through a chain of independent model passes and replaces it with the final result.',
    rights: {
        tier: 'community',
        allowedContracts: [
            'chatHistory.messages', 'chatHistory.replaceText', 'chatHistory.annotate', 'chatHistory.annotations',
            'model.generate',
            'model.workers.get', 'model.presets.get', 'model.presets.set', 'storage.settings.get', 'storage.settings.set', 'ui.notify',
            'ui.messageFooter.claim', 'ui.messageFooter.release', 'ui.messageFooter.liveMesid', 'ui.messageFooter.attach',
        ],
    },
    create: host => createPostprocessModule(host),
}, {
    id: MUSIC_MODULE_ID,
    title: 'Music',
    description: 'Plays background music that matches the scene — chosen locally by embedding meaning, with no model calls.',
    rights: {
        tier: 'community',
        allowedContracts: [
            'storage.settings.get', 'storage.settings.set', 'ui.notify',
            // Текст сцены — через общее Ядро истории чата, не напрямую в ST.
            'chatHistory.messages',
            // Аудио-байты — только через Сервис хранилища (indexedDB).
            'audio.put', 'audio.get', 'audio.delete',
            // Звук — только через Сервис воспроизведения (единственный владелец <audio>).
            'audio.playback.play', 'audio.playback.pause', 'audio.playback.state', 'audio.playback.volume',
            // Вектор сцены и вектора треков — локальный эмбединг.
            'embedding.compute', 'embedding.similarity',
        ],
    },
    create: host => createMusicModule(host),
}];

/** Где реестр помнит, что было включено. Неймспейс Раннера, а не Модуля: это состояние ЗАПУСКА, а не настройка кого-то из них. */
const RUNNER_NAMESPACE = 'core.runner';
const ENABLED_KEY = 'enabledModules';

function createModuleRegistry({ engine, uiModules, panelSettled, panelRoot, storageHost, onChanged = () => {} }) {
    const live = new Map(); // id -> { instance, finalUi }

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
        const result = await request(storageHost.own, 'storage.settings.get', {
            params: { namespace: RUNNER_NAMESPACE, key: ENABLED_KEY, fallback: [] },
        });
        const wanted = (result.ok ? result.value ?? [] : []).filter(id => DEFINITIONS.some(item => item.id === id));
        for (const id of wanted) {
            try { await enable(id, { remember: false }); }
            catch (error) { console.warn(`[ST Module Engine (Beta)] Could not bring back module "${id}":`, error); }
        }
        return wanted;
    }

    async function enable(id, { remember: shouldRemember = true } = {}) {
        if (live.has(id)) return true;
        const definition = DEFINITIONS.find(item => item.id === id);
        if (!definition) throw new Error(`module "${id}" is not installed.`);

        const moduleHost = engine.registerCaller(definition.id, 'modules', definition.rights);
        const instance = definition.create(moduleHost);
        await instance.load();
        const finalUi = uiModules.enable(definition.id, instance.tree());
        await finalUi.settled();
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
     */
    function requestHud(id) {
        const entry = live.get(id);
        if (!entry) return false;
        const instance = entry.instance;
        if (typeof instance?.setHudVisible !== 'function') return false;
        instance.setHudVisible(true);
        return true;
    }

    return {
        list: () => DEFINITIONS.map(({ id, title, description }) => ({ id, title, description })),
        enabled: () => [...live.keys()],
        instance: id => live.get(id)?.instance,
        requestHud,
        enable,
        disable,
        restore,
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
    // Локальный эмбединг — не сетевой вызов через `http.request` (см.
    // doc-comment services/embedding.js за честной оговоркой: сама закачка
    // весов модели идёт мимо нашего Гейта сети, это делает сторонняя
    // библиотека изнутри себя).
    registerEmbeddingService(engine.buses.services);
    registerAudioStoreService(engine.buses.services);
    registerAudioPlaybackService(engine.buses.services);
    registerExtensionSettingsService(engine.buses.services, { getContext });
    registerFileService(engine.buses.services);
    registerStMacrosService(engine.buses.services, { getContext });
    registerStLorebookService(engine.buses.services, { getContext });
    registerStCharacterService(engine.buses.services, { getContext });
    registerStEventsService(engine.buses.services, { getContext });
    registerStToolsService(engine.buses.services, { getContext });
    // Сервис перехвата: сюда встанут обе точки, которыми движок забирает
    // отправку себе. `interceptTarget` — «глобальный объект», на который
    // ставится именованная функция перехватчика и чей `fetch` подменяется;
    // в реальном ST это window, в харнессе — его собственный поддельный ST.
    registerStGenerationService(engine.buses.services, { target: interceptTarget });
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

    // Ядро событий строится раньше всех, кто публикует события: они получают
    // его `publish` при сборке, чтобы защиты и реестр видели ВСЮ поверхность,
    // а не только мост ST.
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));

    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost, {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.models.internal' }),
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
    const lorebookCore = createLorebookCore(engine.registerCaller('core.lorebook', 'cores', { tier: 'official' }), {
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.lorebook' }),
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
    const activityLight = createActivityLightCore(
        engine.registerCaller('core.ui.activityLight', 'cores', { tier: 'official' }),
    );
    activityLight.load();

    // Полоса под последним сообщением: три независимых виджета, во всю ширину
    // чата. Модель её не видит вовсе — она живёт только в DOM.
    const messageFooterHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    const messageFooter = createMessageFooterCore(messageFooterHost, {
        createFinalUi: () => createFinalUiPc(messageFooterHost),
        publish: (event, payload) => eventsCore.publish(event, payload, { source: 'core.ui.messageFooter' }),
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
    const modules = createModuleRegistry({
        engine,
        uiModules,
        panelSettled: () => panelUi?.settled() ?? Promise.resolve(),
        panelRoot: () => panelUi?.getRoot() ?? null,
        // Своя личность на Шине ядер: состав помнится через то же Ядро
        // сохранения, что и всё остальное, а не отдельным ходом в обход.
        storageHost: engine.registerCaller('core.runner', 'cores', { tier: 'official' }),
        onChanged: () => enginePanelRef?.refreshModules(),
    });

    // Экран движка — тоже Ядро (движок без интерфейса не работает, и
    // пользователь его не подключает). К моделям он ходит контрактами, а не
    // по JS-ссылке: править эндпоинты и ключи в обход Шины было бы ровно тем,
    // от чего Гейты и защищают.
    const enginePanel = createEnginePanelCore(engine.registerCaller('core.ui.panel', 'cores', { tier: 'official' }), {
        mount: node => uiEngine.mount('settings', node),
        listContracts: () => [
            ...engine.buses.cores.contracts(),
            ...engine.buses.services.contracts(),
            ...engine.buses.network.contracts(),
        ],
        modules,
        openMemoryGraphPanel: () => memoryGraphPanel.show(),
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
    await Promise.all([modelsCore.restoreWorkers(), modelsCore.restorePresets(), trackingCore.restoreTrackers(), macrosCore.restorePrograms(), lorebookCore.scan(), summaryCore.load()]);
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

    // Слух движка включается ПОСЛЕ восстановления конфигурации: иначе
    // событие ST могло бы прилететь трекеру, которого ещё нет.
    await eventsCore.bridge();

    // И только теперь движок забирает себе саму отправку. Строго последним:
    // с этого момента генерация ST физически идёт через нас, и делать это до
    // того, как вкладчики восстановлены, значило бы держать первую генерацию
    // ради ещё не собранного пайплайна.
    await generationCore.install();

    return { engine, modelsCore, trackingCore, macrosCore, lorebookCore, summaryCore, memoryGraphCore, memoryGraphPanel, eventsCore, generationCore, pipelineCore, uiEngine, uiModules, notifications, activityLight, messageFooter, selfUpdate, updateOverlay, modules, enginePanel, panelUi };
}
