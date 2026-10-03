import { createPromptManagerCore } from '../../cores/prompt-manager/index.js';
import { createDrawerGuardCore } from '../../cores/drawer-guard/index.js';
import { createEventsCore } from '../../cores/events/index.js';
import { createGenerationCore } from '../../cores/generation/index.js';
import { createPipelineCore } from '../../cores/pipeline/index.js';
import { createInternalEngineModelsCore } from '../../cores/models/internal-engine.js';
import { createDiffusionCore } from '../../cores/models/diffusion.js';
import { createBackupCore, createChatMetadataBackupSource, createExtensionSettingsBackupSource, createGraphLibraryBackupSource, createPmPresetsBackupSource } from '../../cores/backup/index.js';
import { createTrackingCore } from '../../cores/tracking/index.js';
import { createMacrosCore } from '../../cores/macros/index.js';
import { createSpeakerCore } from '../../cores/speaker/index.js';
import { createMapCore } from '../../cores/map/index.js';
import { createMapNarrationCore } from '../../cores/map-narration/index.js';
import { createLorebookCore } from '../../cores/lorebook/index.js';
import { createCharacterCardsCore } from '../../cores/character-cards/index.js';
import { createClassifierCore } from '../../cores/classifier/index.js';
import { createBasicSummaryCore } from '../../cores/summary/index.js';
import { createMemoryGraphCore } from '../../cores/memory-graph/index.js';

/** Ядра данных и логики: события, модели, пайплайн, генерация, Prompt Manager, макросы, трекинг, карта, лорбук, память. Получает общий контекст сборки (`ctx`), возвращает то, что создал. */
export async function wireDataCores(ctx) {
    const { engine } = ctx;

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


    return { backupHost, backupCore, eventsCore, modelsHost, modelsCore, diffusionHost, diffusionCore, pipelineCore, generationCore, promptManagerCore, drawerGuardCore, macrosCore, trackingCore, speakerCore, mapCore, mapNarrationCore, lorebookCore, classifierCore, characterCardsCore, summaryCore, memoryGraphCore };
}
