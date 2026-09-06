import { createEngine } from '../libraries/shared/engine.js';
import { registerDomService } from '../services/dom.js';
import { registerHttpService } from '../services/http.js';
import { registerChatMetadataService } from '../services/chat-metadata.js';
import { registerStChatService } from '../services/st-chat.js';
import { registerExtensionSettingsService } from '../services/extension-settings.js';
import { registerFileService } from '../services/file.js';
import { registerStMacrosService } from '../services/st-macros.js';
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
import { createSettingsCore } from '../cores/settings/index.js';
import { createBackupCore, createChatMetadataBackupSource, createExtensionSettingsBackupSource } from '../cores/backup/index.js';
import { createTrackingCore } from '../cores/tracking/index.js';
import { createMacrosCore } from '../cores/macros/index.js';
import { createUiEngineCore } from '../cores/ui/ui-engine.js';
import { createEnginePanelCore } from '../cores/ui/engine-panel.js';
import { createFinalUiPc } from '../cores/ui/final-ui-pc.js';
import { createUiModulesCore } from '../cores/ui/ui-modules.js';
import { createNotificationsCore } from '../cores/ui/notifications.js';
import { createMessageFooterCore } from '../cores/ui/message-footer.js';
import { createTrackerModule, MODULE_ID as TRACKER_MODULE_ID } from '../modules/tracker/index.js';
import { createTimeModule, MODULE_ID as TIME_MODULE_ID } from '../modules/time/index.js';

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
            'model.workers.get', 'storage.settings.get', 'storage.settings.set', 'ui.notify',
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
            'storage.settings.get', 'storage.settings.set', 'storage.chatMemory.get', 'storage.chatMemory.set',
            'model.workers.get', 'ui.notify', 'ui.messageFooter.claim', 'ui.messageFooter.release',
        ],
    },
    create: host => createTimeModule(host),
}];

function createModuleRegistry({ engine, uiModules, panelSettled, onChanged = () => {} }) {
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
        for (const [id, entry] of live) {
            const slot = document.querySelector(`.stme-module-slot[data-module="${id}"]`);
            if (slot && !slot.contains(entry.finalUi.getRoot())) slot.append(entry.finalUi.getRoot());
        }
    }

    async function enable(id) {
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
        return true;
    }

    return {
        list: () => DEFINITIONS.map(({ id, title, description }) => ({ id, title, description })),
        enabled: () => [...live.keys()],
        instance: id => live.get(id)?.instance,
        enable,
        disable,
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
    registerExtensionSettingsService(engine.buses.services, { getContext });
    registerFileService(engine.buses.services);
    registerStMacrosService(engine.buses.services, { getContext });
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

    const modelsHost = engine.registerCaller('core.models.internal', 'cores', { tier: 'official', networkAccess: true });
    const modelsCore = createInternalEngineModelsCore(modelsHost);

    createChatMemoryCore(engine.registerCaller('core.memory.chat', 'cores', { tier: 'official' }));
    createSettingsCore(engine.registerCaller('core.settings', 'cores', { tier: 'official' }));

    const backupHost = engine.registerCaller('core.backup', 'cores', { tier: 'official' });
    const backupCore = createBackupCore(backupHost);
    backupCore.registerSource('chatMemory', createChatMetadataBackupSource(backupHost));
    backupCore.registerSource('settings', createExtensionSettingsBackupSource(backupHost));

    // Ядро событий строится раньше всех, кто публикует события: они получают
    // его `publish` при сборке, чтобы защиты и реестр видели ВСЮ поверхность,
    // а не только мост ST.
    const eventsCore = createEventsCore(engine.registerCaller('core.events', 'cores', { tier: 'official' }));

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

    const uiHost = engine.registerCaller('core.ui.engine', 'cores', { tier: 'official' });
    const uiEngine = createUiEngineCore(() => createFinalUiPc(uiHost));
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

    // Полоса под последним сообщением: три независимых виджета, во всю ширину
    // чата. Модель её не видит вовсе — она живёт только в DOM.
    const messageFooterHost = engine.registerCaller('core.ui.messageFooter', 'cores', { tier: 'official' });
    const messageFooter = createMessageFooterCore(messageFooterHost, { createFinalUi: () => createFinalUiPc(messageFooterHost) });

    let panelUi = null;
    // Самообновление: единственное Ядро, которому выдано право выходить в сеть
    // помимо моделей — оно сверяет наш код с GitHub напрямую.
    const selfUpdate = createSelfUpdateCore(
        engine.registerCaller('core.selfUpdate', 'cores', { tier: 'official', networkAccess: true }),
        { extensionName: deriveExtensionName(scriptUrl), ...CORE_REPO },
    );

    let enginePanelRef = null;
    const modules = createModuleRegistry({
        engine,
        uiModules,
        panelSettled: () => panelUi?.settled() ?? Promise.resolve(),
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
    });
    enginePanelRef = enginePanel;

    // Every Ядро is constructed by now (Settings Core included) — safe to
    // actually read back whatever was persisted last time.
    await Promise.all([modelsCore.restoreWorkers(), trackingCore.restoreTrackers(), macrosCore.restorePrograms()]);

    // Панель монтируется здесь же, а не у вызывающего: реестру Модулей нужно
    // уметь дождаться её перерисовки, чтобы положить дерево Модуля в слот.
    // Строго ПОСЛЕ восстановления: панель читает конфигурацию один раз при
    // открытии, и смонтируй мы её раньше — она честно показала бы пустоту,
    // хотя настройки на диске есть. Ровно это и случилось при первой попытке.
    panelUi = await enginePanel.open();
    await panelUi.settled();

    await messageFooter.start();

    const notificationsUi = notifications.open();
    await notificationsUi.settled();
    document.body.append(notificationsUi.getRoot());

    // Слух движка включается ПОСЛЕ восстановления конфигурации: иначе
    // событие ST могло бы прилететь трекеру, которого ещё нет.
    await eventsCore.bridge();

    // И только теперь движок забирает себе саму отправку. Строго последним:
    // с этого момента генерация ST физически идёт через нас, и делать это до
    // того, как вкладчики восстановлены, значило бы держать первую генерацию
    // ради ещё не собранного пайплайна.
    await generationCore.install();

    return { engine, modelsCore, trackingCore, macrosCore, eventsCore, generationCore, pipelineCore, uiEngine, uiModules, notifications, messageFooter, selfUpdate, modules, enginePanel, panelUi };
}
