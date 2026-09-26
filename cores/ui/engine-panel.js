import { h } from './tree.js';
import { signal, computed } from './reactive.js';
import { request } from '../../libraries/shared/request.js';
import { Button, NumberInput, Field, Row, Card, ProgressBar } from '../../libraries/shared/widgets.js';
import { createCollapseState } from '../../libraries/shared/collapse-state.js';

import { isMobileSurface } from './final-ui-android.js';
import { createSyncCard } from './sync-card.js';
import { createPanelWatch } from './panel-cards/panel-watch.js';
import { createPanelTrees } from './panel-cards/panel-trees.js';
import { createUpdatesCard } from './panel-cards/updates-card.js';
import { createChatViewportCard } from './panel-cards/chat-viewport-card.js';
import { createBackgroundsCard } from './panel-cards/backgrounds-card.js';
import { createStatusCard } from './panel-cards/status-card.js';
import { createPresetCard } from './panel-cards/preset-card.js';
import { createModulesCard } from './panel-cards/modules-card.js';
import { createModelsCard } from './panel-cards/models-card.js';
import { createMacrosCard } from './panel-cards/macros-card.js';
import { createLorebookCard } from './panel-cards/lorebook-card.js';
import { createSummaryCard } from './panel-cards/summary-card.js';
export { sanitizeMacroName } from './panel-cards/macros-card.js';

/**
 * Экран движка — то, что пользователь реально видит и трогает.
 *
 * Это **Ядро**, а не Модуль: движок без своего интерфейса не работает, и
 * пользователь его не подключает (см. критерий в ARCHITECTURE.md).
 *
 * Панель поделена пополам: слева — своё, ядро и сервисы; справа — то, что
 * подключает пользователь. Модулей пока нет вообще, и правая половина честно
 * это показывает, а не притворяется занятой.
 *
 * Здесь НЕТ вёрстки как таковой: всё, что можно переиспользовать, живёт в
 * [libraries/shared/widgets.js](../../libraries/shared/widgets.js) — в этом
 * файле остаётся только проводка виджетов к настоящим контрактам своей Шины.
 * И всё, что панель делает с моделями, она делает через контракты
 * (`model.workers.get/set`, `model.generate`), а не через JS-ссылку на Ядро:
 * править эндпоинты и ключи в обход Шины было бы ровно тем случаем, ради
 * которого Гейты и существуют.
 */
export function createEnginePanelCore(host, { mount, mountSettings, listContracts, modules: moduleRegistry, openMemoryGraphPanel, chatViewport, inputBar, home, isMobile = isMobileSurface } = {}) {
    // Что свёрнуто — помнится между сеансами. По умолчанию свёрнуто всё.
    const collapse = createCollapseState(host.own, { namespace: 'core.ui.panel' });
    const workers = signal([]);
    const macros = signal([]);
    const lorebookEntries = signal([]);
    const lorebookBooks = signal([]);
    const memoryGraphNodeCount = signal(0);
    // Прогресс бутстрапа из Lorebook (решено с пользователем: "нет ивентов
    // начала и конца построения WI... нет индикатора прогресса. Это очень
    // плохо" + следом "добавь прогресс-бар"). `memoryGraphFlash` — та же
    // пульсация обводки, что у "Test" воркера/проверки обновления (см.
    // `flash()` ниже), только выставляется НАПРЯМУЮ (не автогаснущим
    // `flash()`) на всё время бутстрапа — гаснет сама только на `finished`.
    // `memoryGraphProgress` — null, когда бутстрап не идёт; `{done, total,
    // phase}` — грубая, но живая оценка (`cores/memory-graph/index.js`'s
    // `bootstrapFromLorebook()` тикает её по ходу дела), не точный процент.
    const memoryGraphFlash = signal('');
    const memoryGraphProgress = signal(null);
    // Чувствительность отбора "сильных изменений" (`thresholdK` — реальная
    // жалоба пользователя: "не работает это, я могу подкрутить сам это
    // число? Где оно?" — раньше настраивалось ТОЛЬКО кодом/контрактом
    // напрямую, никакого UI не было вовсе).
    const memoryGraphThresholdK = signal(1.5);
    const summaries = signal([]);
    const summaryLevels = signal([]);
    const summaryProtectedWindow = signal(20);
    const summaryWorkerId = signal('');
    const summaryVerifyEnabled = signal(false);
    const summaryVerifyWorkerId = signal('');
    // Список трекеров (с полями) для «Insert a value» под редактором кода —
    // источник, откуда пикер берёт настоящие `get "id:field"` ключи, а не
    // заставляет вводить их руками (реальный `id` трекера — не его название).
    const trackerFields = signal([]); // [{ id, fields: [name, ...] }]
    const modules = signal([]);
    const enabledIds = signal([]);
    // Один СТАБИЛЬНЫЙ сигнал включённости на модуль. Раньше здесь был
    // computed(), создаваемый заново внутри отрисовки карточки — то есть на
    // каждую перерисовку узел получал НОВЫЙ сигнал, а подписан оставался на
    // старый. Та же ошибка, что уже ловили с памятью о свёрнутом: сигнал,
    // рождённый в функции отрисовки, живёт меньше, чем узел, который его читает.
    const enabledSignals = new Map(); // moduleId -> signal(boolean)

    function enabledSignal(moduleId) {
        if (!enabledSignals.has(moduleId)) enabledSignals.set(moduleId, signal(enabledIds.peek().includes(moduleId)));
        return enabledSignals.get(moduleId);
    }

    function syncEnabled(ids) {
        enabledIds.set(ids);
        for (const [moduleId, state] of enabledSignals) state.set(ids.includes(moduleId));
    }
    const contracts = signal([]);
    const generationStage = signal('idle');
    const repository = signal({ owner: '', repo: '', extensionName: '' });
    const eventCount = signal(0);

    async function call(contract, params) {
        return request(host.own, contract, { params });
    }

    /**
     * Вызов СЕРВИСНОГО контракта — через Гейт (host.services), а не через
     * host.own: file.* зарегистрированы на Шине сервисов, и домашняя Шина
     * ядер их не видит в принципе. Каждый такой вызов проходит реальную
     * проверку прав на пересечении домена (ARCHITECTURE.md: «даже когда
     * резолвинг тривиален») — здесь это Ядро UI, tier official.
     */
    async function callService(contract, params) {
        return request(host.services, contract, { params });
    }

    /**
     * `callService()` отдаёт СЫРОЙ конверт `{ok, value, error}` — существующие
     * места сами решают, как обработать отказ (см. `exportPreset()`/
     * `importPreset()`: разная реакция на разные контракты). Chat Viewport
     * зовёт `dom.*`/`stChat.*` десятками подряд ради одной операции
     * (`enableChatViewport()`), и для НЕГО отказ в середине цепочки всегда
     * означает одно и то же — прервать и сообщить, поэтому здесь один общий
     * разворачиватель, а не ручная проверка `.ok` на каждой строке.
     */
    async function callServiceOrThrow(contract, params) {
        const result = await callService(contract, params);
        if (!result.ok) throw new Error(`${contract}: ${result.error.message}`);
        return result.value;
    }

    /**
     * Включение/выключение делает НЕ панель — она только просит реестр
     * Модулей. Кто их грузит и монтирует, знает сборщик движка (в будущем —
     * Раннер), а панель обязана оставаться экраном, а не менеджером
     * жизненного цикла чужого кода.
     */
    async function toggleModule(entry, enable) {
        if (!moduleRegistry) return;
        // Панель НЕ отслеживает состояние сама: реестр сообщит о смене через
        // `refreshModules()` — и когда переключили здесь, и когда Модуль
        // включили в обход панели. Держи она свой список, эти два пути
        // разъехались бы.
        await (enable ? moduleRegistry.enable(entry.id) : moduleRegistry.disable(entry.id));
    }

    const { loadWorkers, modelsCard } = createModelsCard({ call, workers, notify, flash, collapse });
    const { loadMacros, loadTrackerFields, macrosCard } = createMacrosCard({ call, macros, trackerFields, notify, flash, collapse });
    const { loadLorebook, lorebookCard } = createLorebookCard({ call, lorebookEntries, lorebookBooks, flash, notify, collapse });
    const { loadSummaries, loadMemoryGraphCount, loadMemoryGraphSettings, saveMemoryGraphThresholdK, loadSummarySettings, summaryCard } = createSummaryCard({ call, summaries, memoryGraphNodeCount, memoryGraphThresholdK, notify, summaryLevels, summaryProtectedWindow, summaryWorkerId, summaryVerifyEnabled, summaryVerifyWorkerId, flash, collapse, workers });

    function notify(tone, text) {
        return call('ui.notify', { tone, text });
    }

    /** Вспышка гаснет сама: это подтверждение, а не состояние, и оставлять его висеть незачем. Берёт сигнал напрямую — годится и записи воркера (`record.flash`), и одиночному сигналу вроде `updateFlash`. */
    function flash(flashSignal, tone) {
        flashSignal.set(tone);
        setTimeout(() => { if (flashSignal.peek() === tone) flashSignal.set(''); }, 1600);
    }

    /**
     * Только вход в отдельное floating-окно (`cores/ui/memory-graph-panel.js`,
     * решено с пользователем: "полноценный UI... окно, а не узкая секция") —
     * счётчик узлов и кнопка, сам граф эта карточка не рисует вообще.
     */
    /** Ярлык фазы бутстрапа для текста над полосой прогресса — `phase` приходит с бэкенда (`cores/memory-graph/index.js`'s `tick()`), словами, не сырым техническим именем. */
    function memoryGraphProgressPhaseLabel(phase) {
        switch (phase) {
            case 'reading': return 'reading Lorebook';
            case 'skeleton': return 'laying out regions';
            case 'centers': return 'adding region centers';
            case 'placing': return 'placing entries';
            case 'linking': return 'linking regions';
            case 'connecting': return 'connecting isolated entries';
            case 'finalizing': return 'finalizing';
            default: return 'building';
        }
    }

    /** Полоса прогресса бутстрапа — видна только пока `memoryGraphProgress()` не null (решено с пользователем: "нет индикатора прогресса. Это очень плохо" → "добавь прогресс-бар"). Проценты — грубая оценка (see `bootstrapFromLorebook()`'s doc-comment), не точный расчёт, этого достаточно, чтобы полоска реально двигалась, а не стояла мёртвым нулём. */
    function memoryGraphProgressBar() {
        return computed(() => {
            const progress = memoryGraphProgress();
            if (!progress) return null;
            const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
            const phase = progress.detail ? `${memoryGraphProgressPhaseLabel(progress.phase)} — ${progress.detail}` : memoryGraphProgressPhaseLabel(progress.phase);
            return ProgressBar(percent, `Building memory graph — ${phase}… ${percent}%`);
        });
    }

    function memoryGraphCard() {
        return Card('Memory Graph', {
            ...collapse.bind('card:memoryGraph'),
            subtitle: computed(() => `${memoryGraphNodeCount()} node${memoryGraphNodeCount() === 1 ? '' : 's'}`),
            className: computed(() => (memoryGraphFlash() ? `stme-flash stme-flash-${memoryGraphFlash()}` : '')),
        },
            h('p', { class: 'stme-summary-help' }, 'Long-term memory as a mind-map — facts as nodes, typed edges between them, retrieved by relevance instead of recency.'),
            memoryGraphProgressBar(),
            Row(
                Field('Sensitivity (thresholdK)', NumberInput(memoryGraphThresholdK, { min: 0.1, max: 10, step: 0.1 }), {
                    hint: 'How many standard deviations a message must stand out by before it is even considered for a new memory. LOWER catches more (more SideCar calls, more nodes); HIGHER catches less.',
                }),
                Button('Save', saveMemoryGraphThresholdK),
            ),
            Row(Button('Open Graph Editor', () => openMemoryGraphPanel?.())),
        );
    }

    // Карточка «Sync» (cores/ui/sync-card.js): своё состояние, свои события; панель лишь встраивает её и передаёт ей общую свёртку.
    const syncCard = createSyncCard({ host, collapse, notify: (tone, text) => notify(tone, text) });

    const { updatesCard } = createUpdatesCard({ call, flash, notify, collapse, repository });
    const { chatViewportCard, restoreChatViewportState } = createChatViewportCard({ chatViewport, inputBar, home, host, callService, callServiceOrThrow, notify, collapse, isMobile });
    const { refreshBackgrounds, backgroundsCard } = createBackgroundsCard({ host, collapse });
    const { statusCard } = createStatusCard({ collapse, contracts, generationStage, eventCount });
    const { presetCard } = createPresetCard({ call, flash, notify, callService, collapse });
    const { modulesCard } = createModulesCard({ enabledSignal, collapse, toggleModule, modules });

    async function open() {
        // Сначала память о свёрнутом — иначе первый кадр раскрылся бы по
        // умолчанию, а потом схлопнулся, и это было бы видно.
        await collapse.restore();
        await restoreChatViewportState();
        await loadWorkers();
        await loadMacros();
        await loadTrackerFields();
        await loadLorebook();
        await loadSummarySettings();
        await loadSummaries();
        await loadMemoryGraphCount();
        await loadMemoryGraphSettings();
        await refreshBackgrounds();
        await syncCard.refresh();
        // Список контрактов приходит от сборщика движка: своя шина доступна
        // через host.own, а шины сервисов и сети — нет (у Ядра туда только
        // Гейт-аксессор, и это правильно). Так что «что вообще подключено»
        // знает тот, кто движок собирал.
        contracts.set(listContracts ? listContracts() : host.own.contracts?.() ?? []);
        const repo = await call('selfUpdate.repository');
        if (repo.ok) repository.set({ owner: '', repo: '', extensionName: '', ...repo.value });
        modules.set(moduleRegistry?.list() ?? []);
        syncEnabled(moduleRegistry?.enabled() ?? []);
        const ui = await mount(tree());
        // Второе дерево — экран настроек — монтируется СВОИМ ключом рядом
        // (см. settingsTree()): корень забирает index.js в body своего
        // full-screen оверлея. Один `open()` поднимает ОБА дерева — данные у
        // них общие, раздельный монтаж порождал бы два чтения конфигурации.
        // `mountSettings` опционален: тесты/упрощённые хосты поднимают только
        // основную панель, экран настроек тогда просто не существует.
        settingsUi = mountSettings ? await mountSettings(settingsTree()) : null;
        return ui;
    }

    const { watch } = createPanelWatch({ host, eventCount, generationStage, loadTrackerFields, loadLorebook, syncCard, loadSummaries, notify, loadMemoryGraphCount, memoryGraphFlash, memoryGraphProgress, flash });
    const { tree, settingsTree } = createPanelTrees({ modelsCard, macrosCard, lorebookCard, summaryCard, modulesCard, statusCard, chatViewportCard, presetCard, updatesCard, syncCard, backgroundsCard });

    const subscriptions = watch();
    // Корень второго дерева (экран настроек) — забирает index.js. null, пока
    // open() не отработал или хост не дал mountSettings.
    let settingsUi = null;

    return {
        open,
        refresh: loadWorkers,
        refreshModules: () => { modules.set(moduleRegistry?.list() ?? []); syncEnabled(moduleRegistry?.enabled() ?? []); },
        /** Корень дерева экрана настроек — null, если экран не поднимался. */
        settingsRoot: () => settingsUi?.getRoot() ?? null,
        settingsSettled: () => settingsUi?.settled() ?? Promise.resolve(),
        close: () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); },
    };
}
