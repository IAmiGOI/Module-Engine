import { registerDomService } from '../../services/dom.js';
import { registerHtmlRasterizerService } from '../../services/html-rasterizer.js';
import { registerWebglRendererService } from '../../services/webgl-renderer.js';
import { registerRasterCacheService } from '../../services/raster-cache.js';
import { registerTextPainterService } from '../../services/text-painter.js';
import { registerGlAnimationService } from '../../services/gl-animation.js';
import { registerStBackgroundsService } from '../../services/st-backgrounds.js';
import { registerImageScaleService } from '../../services/image-scale.js';
import { registerStUserDataService } from '../../services/st-user-data.js';
import { registerSyncStateService } from '../../services/sync-state.js';
import { registerSyncSignalService } from '../../services/sync-signal.js';
import { registerSyncPeerService } from '../../services/sync-peer.js';
import { registerHttpService } from '../../services/http.js';
import { registerChatMetadataService } from '../../services/chat-metadata.js';
import { registerStChatService } from '../../services/st-chat.js';
import { registerStHomeService } from '../../services/st-home.js';
import { registerEmbeddingService } from '../../services/embedding.js';
import { registerAudioStoreService } from '../../services/audio-store.js';
import { registerImageStoreService } from '../../services/image-store.js';
import { registerGraphLibraryService } from '../../services/graph-library.js';
import { registerPmPresetsService } from '../../services/pm-presets.js';
import { registerStPromptDataService } from '../../services/st-prompt-data.js';
import { registerStPmUiService } from '../../services/st-pm-ui.js';
import { registerAudioPlaybackService } from '../../services/audio-playback.js';
import { registerExtensionSettingsService } from '../../services/extension-settings.js';
import { registerFileService } from '../../services/file.js';
import { registerStMacrosService } from '../../services/st-macros.js';
import { registerStLorebookService } from '../../services/st-lorebook.js';
import { registerStCharacterService } from '../../services/st-character.js';
import { registerStCharacterCardsService } from '../../services/st-character-cards.js';
import { registerCharacterCardVersionsService } from '../../services/character-card-versions.js';
import { registerStWebSearchService } from '../../services/st-web-search.js';
import { registerStChatArchiveService } from '../../services/st-chat-archive.js';
import { registerStCharacterAvatarService } from '../../services/st-character-avatar.js';
import { registerStEventsService } from '../../services/st-events.js';
import { registerStToolsService } from '../../services/st-tools.js';
import { registerStGenerationService } from '../../services/st-generation.js';
import { registerStExtensionsService } from '../../services/st-extensions.js';
import { registerStWorldInfoService } from '../../services/st-worldinfo.js';
import { registerStPresetService } from '../../services/st-preset.js';
import { registerStDrawerGuard } from '../../services/st-drawer-guard.js';
import { registerSessionService } from '../../services/session.js';
import { createChatMemoryCore } from '../../cores/memory/index.js';
import { createChatHistoryCore } from '../../cores/chat-history/index.js';
import { createSettingsCore } from '../../cores/settings/index.js';

/** Сервисы и общие Ядра, без которых не стартует ничего другое (DOM, сеть, ST-адаптеры, хранилище, история чата). Получает общий контекст сборки (`ctx`), возвращает то, что создал. */
export async function wireServices(ctx) {
    const { getContext, fetch, interceptTarget, engine } = ctx;

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
    registerStChatArchiveService(engine.buses.services, { getContext, fetch });
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


    return {  };
}
