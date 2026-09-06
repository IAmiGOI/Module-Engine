import { request } from '../../libraries/shared/request.js';
import { fillTemplate } from '../../libraries/core/fill-template.js';
import { parseModelJson } from '../../libraries/core/parse-model-json.js';
import { createPersistedList } from '../../libraries/core/persisted-list.js';

const PERSISTENCE_NAMESPACE = 'core.tracking';
/** Сколько последних сообщений уходит модели как контекст, и сколько символов берётся от каждого — числа из Alpha, там они себя оправдали. */
const CONTEXT_MESSAGES = 10;
const CONTEXT_MESSAGE_CHARS = 900;

const DEFAULT_PROMPT_TEMPLATE =
    'Recent conversation:\n\n{context}\n\n' +
    'Update the tracked fields below based on that conversation. ' +
    'Reply with ONLY a JSON object mapping each field name to its new value — no other text.\n\n{fields}';

/**
 * Склеивает сообщения чата в текст для модели. Роли называются нейтрально
 * («Player»/«Character»), потому что трекер спрашивает не персонажа, а
 * стороннюю модель — ей важно, кто говорил, а не как зовут собеседника.
 */
export function buildTrackerContext(messages = []) {
    return messages
        .map(message => `${message.isUser ? 'Player' : 'Character'}: ${String(message.text ?? '').slice(0, CONTEXT_MESSAGE_CHARS)}`)
        .join('\n\n');
}

/**
 * Подстановки, общие для системной и пользовательской половин промпта —
 * посчитаны один раз, чтобы обе видели одни и те же поля/контекст/vars.
 *
 * Плейсхолдеры: `{context}` — недавняя переписка, `{fields}` — что трекать с
 * подсказками и текущими значениями, `{fieldsJson}` — только имена (удобно
 * требовать точную форму ответа), `{current}` — текущее состояние объектом.
 *
 * **Контекст обязателен, а не приятное дополнение.** Раньше шаблон по
 * умолчанию говорил «based on the current context», но самого контекста в
 * него не подставлялось ничего: модель просили обновить поля по переписке,
 * которой она не видела, и отвечала она выдумкой.
 */
function buildTrackerSubstitutions(fields, messages, vars) {
    const fieldLines = fields.map(field => `- ${field.name}: ${field.prompt ?? ''} (current: ${JSON.stringify(field.value)})`).join('\n');
    return {
        context: buildTrackerContext(messages) || '(no messages yet)',
        fields: fieldLines,
        fieldsJson: fields.map(field => `"${field.name}"`).join(', '),
        current: JSON.stringify(Object.fromEntries(fields.map(field => [field.name, field.value]))),
        // Подстановки ОТ ВЫЗЫВАЮЩЕГО — то, чего Ядро знать не может и не
        // должно. Специализированному Модулю (определитель времени) нужна в
        // промпте своя временная шкала; заводить ради неё понятие «время» в
        // общем Ядре трекинга значило бы затащить в него чужую предметную
        // область.
        ...vars,
    };
}

/** Pure — точный текст пользовательского сообщения, уходящий модели за один опрос. Экспортируется, чтобы проверяться напрямую, без Ядра и Сервисов вокруг. */
export function buildTrackerPrompt(tracker, fields, messages = [], vars = {}) {
    return fillTemplate(tracker.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE, buildTrackerSubstitutions(fields, messages, vars));
}

/**
 * Системное сообщение — ЕСЛИ у трекера оно вообще есть (`systemPromptTemplate`).
 * Разделение на системное (инструкция: что и как делать) и пользовательское
 * (сама история: переписка/показания) — приём специализированного Модуля
 * («RP Time» первым его использовал), а не требование для каждого трекера:
 * пользовательский трекер, настроенный руками через Модуль «Трекер», как и
 * раньше обходится одним `promptTemplate` целиком в `user` — никого не
 * заставляем переучиваться ради разделения, которое не просили.
 *
 * Без `systemPromptTemplate` возвращает `''`, и `model.generate` тогда не
 * получает системного сообщения вовсе (см. `resolveGenerateRequest()`) —
 * поведение НЕ меняется для тех, кто это поле не задавал.
 */
export function buildTrackerSystemPrompt(tracker, fields, messages = [], vars = {}) {
    if (!tracker.systemPromptTemplate) return '';
    return fillTemplate(tracker.systemPromptTemplate, buildTrackerSubstitutions(fields, messages, vars));
}

function fieldKey(trackerId, fieldName) {
    return `${trackerId}:${fieldName}`;
}

/**
 * Ядро трекинга (CORES.md) — configurable fields + poll triggers +
 * publication, generalized from Alpha's Tracker. Two kinds of tracker
 * (`kind: 'user' | 'system'`), both bound to one specific worker in Ядро
 * внутренних моделей движка (`workerId`, pinned via `model.generate`'s own
 * `workerId` param — see that Ядро's doc comment) — "каждый трекер привязан
 * к сайдкару" applies to both kinds identically, per the user's own
 * clarification. They differ only in WHERE an update publishes:
 * `tracking.blocks.changed` for user trackers, `tracking.systemBlocks.changed`
 * for system ones — kept structurally separate, never mixed into one stream.
 *
 * **Triggers**: a tracker's `triggers` is a LIST of Шина событий event
 * names (`generation.beforeSend`/`sending`/`completed`/`toolCall` from
 * PIPELINE.md, or any custom name) — several can fire the same tracker, and
 * this Ядро auto-polls on every one of them. A manual, on-demand poll is
 * always available too, via the `tracking.poll` contract directly — the two
 * are the same underlying `poll()`, just triggered differently.
 *
 * **`ownerId` — чей это трекер.** Отдельно от `kind`, потому что это разные
 * вопросы. `kind` отвечает «куда публикуется и пишется ли макрос»; `ownerId`
 * отвечает «кто им распоряжается». Трекер с `ownerId` завёл СВОЙ Модуль
 * (например, «RP Time»): он такой же полноценный `kind: 'user'` — пишет макрос
 * и публикуется в общий поток, — но настраивает его тот Модуль, а не человек
 * руками. Без этого различения специализированный трекер Модуля вылезал в
 * список и в плавающую панель Модуля трекеров как обычный, чужой и
 * недоредактируемый. Само Ядро на `ownerId` не смотрит вовсе — оно только
 * хранит и отдаёт его; решает тот, кто рисует список.
 *
 * `onUserFieldRegistered` (defaults to a no-op) is the hook a USER tracker
 * field's every update is handed to — engine-wiring.js passes a real one
 * that calls Ядро исполнения макросов's `setValueMacro()`, closing the loop
 * to a real `{{macro}}`. Generation-lifecycle trigger event NAMES
 * (PIPELINE.md) need no stub at all — this Ядро just `subscribe()`s to
 * whatever name is configured, and fires for real the moment something
 * actually emits it. Publication likewise doesn't need the full Блоки
 * primitive to exist — it only needs the event-naming discipline Блоки
 * already settled on (`<domain>.<category>.changed`), applied directly.
 * Tracker configuration itself is real, persisted `storage.settings` state
 * (`configureTrackers()`/`restoreTrackers()`, see
 * [persisted-list.js](../../libraries/core/persisted-list.js)), not memory
 * that resets on reload.
 *
 * **Конфигурация — глобальная (одна на все чаты, как воркеры). Натрекан-
 * ные ЗНАЧЕНИЯ полей — НЕТ.** Раньше `values` были голым `Map` в памяти
 * процесса: ни персистентности, ни привязки к чату — переключил чат в ST
 * (SPA, страница не перезагружается) и трекер продолжал невозмутимо
 * показывать значения ПРЕДЫДУЩЕГО разговора, а обычная перезагрузка страницы
 * стирала их вовсе. Реальный баг, пойманный не по коду, а по ощущению «трекер
 * будто одна память на все чаты». Значения теперь лежат в `storage.
 * chatMemory` (то же Ядро памяти чата, которым уже пользуется шкала «RP
 * Time» — см. doc-comment [modules/time/index.js](../../modules/time/index.js)):
 * `restoreTrackers()` подгружает их для ТЕКУЩЕГО чата сразу после
 * конфигурации, а подписка на `st.chatChanged` перечитывает их заново при
 * каждом переключении и объявляет `tracking.blocks.changed`/`systemBlocks.
 * changed` по каждому трекеру, чтобы плавающая панель и подвал сообщений
 * узнали о смене без ручной перезагрузки. `chatValues` в памяти — только
 * КЭШ для быстрого синхронного чтения; источник правды — `storage.
 * chatMemory`, куда каждое `setField()`/`reset()` дописывается настоящим
 * запросом. Хост без Ядра памяти чата рядом (узкие тесты) не ломается —
 * чтение/запись просто не находят поставщика и тихо остаются в памяти,
 * ровно как читает контекст `readContext()` ниже.
 *
 * **Промпт может прийти ДВУМЯ половинами.** `promptTemplate` (обязательный,
 * идёт в `user`) остаётся ровно тем же, чем был — генерический трекер,
 * настроенный руками через Модуль «Трекер», как и раньше не знает никакого
 * разделения. `systemPromptTemplate` — опциональный: специализированный
 * Модуль (первым — «RP Time») может вынести в него ИНСТРУКЦИЮ (что и как
 * делать), оставив в `user` только саму ИСТОРИЮ (переписку/показания).
 * Разделение реальное: обе половины уходят в `model.generate` как разные
 * поля (`prompt`/`systemPrompt`), а не склеиваются заранее.
 *
 * **Сэмплер и ризонинг — свойство ТРЕКЕРА, не воркера, который его
 * исполнит.** Один воркер может нести и точный трекинг, и творческую
 * генерацию одновременно, и им нужны разные настройки — `temperature`/
 * `topP`/`topK`/`maxTokens`/`reasoningMode`/`reasoningEffort`/
 * `reasoningBudget` читаются С САМОГО трекера и уходят в `model.generate`
 * явными параметрами запроса, которые (см. doc-comment
 * `resolveGenerateRequest()` в [internal-engine.js](../models/internal-engine.js))
 * побеждают дефолт воркера тем же механизмом, что уже держит пиннинг по
 * `workerId`. Трекер, не задавший ни одного из этих полей, ведёт себя
 * ровно как раньше — тихо использует дефолт воркера/движка.
 */
export function createTrackingCore(host, { onUserFieldRegistered = () => {}, publish } = {}) {
    // Публикация идёт через Ядро событий (защиты от петель/штормов, реестр
    // событийной поверхности) — оно передаётся при сборке движка. Фоллбэк на
    // прямой эмит оставлен только для узких тестов, которые поднимают это
    // Ядро в одиночку, без Ядра событий рядом.
    const publishEvent = publish ?? ((event, payload) => host.events.emit(event, payload));
    let trackers = new Map(); // id -> config
    // Кэш натрекан­ных значений ТЕКУЩЕГО чата — не голая память, см. doc-comment
    // выше. Обычный объект, не Map: это ровно то, что уходит в `storage.
    // chatMemory.set` целиком, без промежуточной пере­упаковки.
    let chatValues = {}; // fieldKey -> value
    const triggerUnsubscribers = new Map(); // trackerId -> [unsubscribe...]

    function requireTracker(trackerId) {
        const tracker = trackers.get(trackerId);
        if (!tracker) throw new Error(`tracking: unknown tracker "${trackerId}".`);
        return tracker;
    }

    function requireField(tracker, fieldName) {
        const field = (tracker.fields ?? []).find(item => item.name === fieldName);
        if (!field) throw new Error(`tracking: tracker "${tracker.id}" has no field "${fieldName}".`);
        return field;
    }

    function getField(trackerId, fieldName, fallback) {
        const tracker = requireTracker(trackerId);
        requireField(tracker, fieldName);
        const key = fieldKey(trackerId, fieldName);
        return key in chatValues ? chatValues[key] : fallback;
    }

    /**
     * Меняет значение СИНХРОННО в кэше текущего чата — персистентность
     * отдельным шагом (`saveChatValues()`), который вызывающий сам решает,
     * когда позвать: `poll()` копит несколько полей и сохраняет одним
     * запросом, `tracking.set`/`reset()` — сразу же.
     */
    function setField(trackerId, fieldName, value) {
        const tracker = requireTracker(trackerId);
        requireField(tracker, fieldName);
        chatValues[fieldKey(trackerId, fieldName)] = value;
        if (tracker.kind === 'user') onUserFieldRegistered({ trackerId, fieldName, value });
        publishEvent(tracker.kind === 'system' ? 'tracking.systemBlocks.changed' : 'tracking.blocks.changed', { trackerId });
        return true;
    }

    /** Дефолты — только для того, у чего в ТЕКУЩЕМ чате ещё вообще нет значения. Зовётся и при подгрузке чата (после чтения `storage.chatMemory`), и при живой перенастройке (новое поле/трекер должно тут же читаться, а не как `undefined` до первого опроса). */
    function seedDefaults() {
        for (const tracker of trackers.values()) {
            for (const field of tracker.fields ?? []) {
                const key = fieldKey(tracker.id, field.name);
                if (!(key in chatValues)) chatValues[key] = field.default;
            }
        }
    }

    /** Читает натрекан­ные значения ТЕКУЩЕГО чата — источник правды `storage.chatMemory`, кэш в памяти только ускоряет повторные чтения. Без Ядра памяти чата рядом (узкие тесты) тихо остаётся при дефолтах. */
    async function loadValuesForCurrentChat() {
        const result = await request(host.own, 'storage.chatMemory.get', {
            params: { namespace: PERSISTENCE_NAMESPACE, key: 'values', fallback: {} },
        });
        chatValues = result.ok ? { ...(result.value ?? {}) } : {};
        seedDefaults();
    }

    /** Пишет ВЕСЬ кэш текущего чата одним запросом — та же форма, что `saveBadges()` у Модуля «RP Time». Молча остаётся только в памяти, если писать некуда (см. doc-comment Ядра). */
    async function saveChatValues() {
        await request(host.own, 'storage.chatMemory.set', {
            params: { namespace: PERSISTENCE_NAMESPACE, key: 'values', value: chatValues },
        });
    }

    function listFields(trackerId) {
        const tracker = requireTracker(trackerId);
        return (tracker.fields ?? []).map(field => ({ ...field, value: getField(trackerId, field.name) }));
    }

    /** Недавняя переписка для промпта. Сервиса может не быть (узкие тесты) — тогда опрос идёт без контекста, но и шаблон честно скажет «(no messages yet)». */
    async function readContext(tracker) {
        const result = await request(host.services, 'stChat.messages', {
            params: { limit: tracker.contextMessages ?? CONTEXT_MESSAGES },
        });
        return result.ok ? result.value ?? [] : [];
    }

    async function poll(trackerId, vars = {}) {
        const tracker = requireTracker(trackerId);
        const fields = listFields(trackerId);
        const messages = await readContext(tracker);
        const prompt = buildTrackerPrompt(tracker, fields, messages, vars);
        const systemPrompt = buildTrackerSystemPrompt(tracker, fields, messages, vars);
        const result = await request(host.own, 'model.generate', {
            params: {
                prompt, systemPrompt, workerId: tracker.workerId,
                // Пресет сэмплера/ризонинга — свойство ЭТОГО трекера, а не
                // воркера, который его исполнит: один и тот же воркер вправе
                // нести и точный трекинг, и творческую генерацию одновременно,
                // и им нужны разные настройки — «выбирается индивидуально под
                // каждый запрос», не привязкой к модели. Поля не заданы —
                // `resolveGenerateRequest()` тихо возьмёт дефолт воркера/
                // движка, как и раньше; заданы — явный параметр запроса
                // побеждает (тот же механизм, что уже держит пиннинг воркера).
                temperature: tracker.temperature, topP: tracker.topP, topK: tracker.topK, maxTokens: tracker.maxTokens,
                reasoningMode: tracker.reasoningMode, reasoningEffort: tracker.reasoningEffort, reasoningBudget: tracker.reasoningBudget,
            },
        });
        if (!result.ok) throw new Error(result.error.message);
        const parsed = parseModelJson(result.value);
        if (!parsed || typeof parsed !== 'object') throw new Error(`tracking.poll: tracker "${trackerId}"'s model reply was not a JSON object.`);
        let changed = false;
        for (const field of tracker.fields ?? []) {
            if (Object.prototype.hasOwnProperty.call(parsed, field.name)) { setField(trackerId, field.name, parsed[field.name]); changed = true; }
        }
        // Одним запросом на весь опрос, а не по одному на поле — `setField()`
        // уже обновил кэш и объявил событие для каждого, здесь только
        // персистентность в `storage.chatMemory`.
        if (changed) {
            await saveChatValues();
            await annotateMessage(trackerId, messages);
        }
        return listFields(trackerId);
    }

    /**
     * Привязывает СНИМОК ЦЕЛИКОМ (все поля трекера, а не только что менялись
     * в этот опрос — «на сообщении N трекер выглядел вот так») к сообщению,
     * которое было последним в контексте опроса. Через Ядро истории чата
     * (см. doc-comment [cores/chat-history/index.js](../chat-history/index.js)),
     * а не своим механизмом: то же самое, что раньше писала только шкала
     * «RP Time», теперь доступно любому трекеру, не только специализированному
     * Модулю. Тихо ничего не делает, если в контексте не было ни одного
     * сообщения (пустой чат) или Ядра истории чата рядом нет (узкие тесты) —
     * это ДОПОЛНИТЕЛЬНАЯ история, а не единственный источник текущего значения
     * (им остаётся `chatValues`/`storage.chatMemory`, см. doc-comment Ядра).
     */
    async function annotateMessage(trackerId, messages) {
        const mesid = messages.at(-1)?.mesid;
        if (mesid === undefined || mesid === null) return;
        const snapshot = Object.fromEntries(listFields(trackerId).map(field => [field.name, field.value]));
        await request(host.own, 'chatHistory.annotate', { params: { namespace: trackerId, mesid, value: snapshot } });
    }

    /** Adopts a tracker set into memory — re-subscribes every trigger fresh; a field with no value yet starts at its own `default`. The persisting `configureTrackers()` below is this PLUS a real `storage.settings` write (see persisted-list.js). */
    function applyTrackers(list) {
        for (const unsubscribers of triggerUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
        triggerUnsubscribers.clear();

        trackers = new Map((list ?? []).map(tracker => [tracker.id, tracker]));
        for (const tracker of trackers.values()) {
            // Триггер — это `when` Директора, а не ручная подписка на Шину
            // событий: строка `'st.messageReceived'` или полноценное условие
            // `{ event: 'st.messageReceived', debounceMs: 500 }`. Всё, что
            // сложнее «просто по событию» (каждый N-й, дребезг, дедупликация,
            // один раз), обслуживает Директор — здесь для этого нет и не должно
            // быть ни строчки кода (ARCHITECTURE.md, приоритет №3).
            triggerUnsubscribers.set(tracker.id, (tracker.triggers ?? []).map(trigger =>
                host.own.subscribe('tracking.poll', {
                    params: { trackerId: tracker.id },
                    when: typeof trigger === 'string' ? { event: trigger } : trigger,
                }, () => {})));
        }
        // Дефолты — для текущего чата (`chatValues`), не для конфигурации:
        // новый трекер/поле обязано читаться сразу, даже до того, как для
        // ЭТОГО чата вообще позвали `loadValuesForCurrentChat()`.
        seedDefaults();
    }

    const persisted = createPersistedList(host, { namespace: PERSISTENCE_NAMESPACE, key: 'trackers', apply: applyTrackers });
    /**
     * Конфигурация трекеров — глобальная, из `storage.settings`
     * (`persisted.restore()`). Натрекан­ные значения — для ТЕКУЩЕГО чата,
     * из `storage.chatMemory`, и подгружаются здесь же, сразу следом: до
     * этого момента `chatValues` держит только дефолты из `seedDefaults()`,
     * которые сама конфигурация уже успела заполнить.
     */
    async function restoreTrackers() {
        const list = await persisted.restore();
        await loadValuesForCurrentChat();
        return list;
    }

    /**
     * **Владение трекером НЕ отнимается.** `tracking.configure` задаёт набор
     * целиком, а значит каждый, кто пишет свои трекеры, обязан вернуть обратно
     * чужие — и запросто теряет при этом `ownerId`, потому что его собственная
     * форма такого поля не знает. Один такой круг превращал трекер Модуля
     * («RP Time») в обычный пользовательский: он всплывал и в списке Модуля
     * трекеров, и в его плавающей панели, хотя человек его не заводил и править
     * не может. Поэтому уже известное владение переживает любую перезапись:
     * `ownerId` можно ПОСТАВИТЬ у нового трекера, но не стереть и не перебить у
     * существующего.
     *
     * Событие `tracking.trackersChanged` — чтобы список у того, кто его
     * показывает, не зависел от порядка загрузки Модулей: Модуль трекеров
     * читает набор при своей загрузке, а Модуль времени заводит свой трекер
     * позже, и без объявления первый об этом никогда бы не узнал.
     */
    async function configureTrackers(list, by = null) {
        const kept = (list ?? []).map(tracker => {
            const existingOwner = trackers.get(tracker.id)?.ownerId;
            return existingOwner ? { ...tracker, ownerId: existingOwner } : tracker;
        });
        const result = await persisted.save(kept);
        // `by` — чтобы записавший узнал собственное эхо и не перечитывал себя же
        // посреди правки формы.
        publishEvent('tracking.trackersChanged', { count: kept.length, by });
        return result;
    }

    /** Сбрасывает накопленные значения трекера к его же `default`, для ТЕКУЩЕГО чата. Отдельно от `configure`: «забыть, что натрекалось» и «поменять настройку» — разные намерения. */
    async function reset(trackerId) {
        const tracker = requireTracker(trackerId);
        for (const field of tracker.fields ?? []) chatValues[fieldKey(trackerId, field.name)] = field.default;
        await saveChatValues();
        publishEvent(tracker.kind === 'system' ? 'tracking.systemBlocks.changed' : 'tracking.blocks.changed', { trackerId });
        return listFields(trackerId);
    }

    const unregisters = [
        host.own.register('tracking.value', params => getField(params?.trackerId, params?.fieldName, params?.fallback)),
        host.own.register('tracking.set', async params => {
            const result = setField(params?.trackerId, params?.fieldName, params?.value);
            await saveChatValues();
            return result;
        }),
        host.own.register('tracking.fields', params => listFields(params?.trackerId)),
        host.own.register('tracking.poll', params => poll(params?.trackerId, params?.vars)),
        host.own.register('tracking.reset', params => reset(params?.trackerId)),
        // Читать и править конфигурацию трекеров через Шину — иначе UI пришлось
        // бы держать JS-ссылку на Ядро, то есть ходить в обход Гейта ровно там,
        // где правится, к какой модели и по какому событию трекер обращается.
        host.own.register('tracking.trackers', () => [...trackers.values()].map(tracker => ({ ...tracker }))),
        host.own.register('tracking.configure', (params, { callerId } = {}) => configureTrackers(params?.trackers ?? [], callerId ?? null)),
    ];

    // Другой чат — другие натрекан­ные значения: перечитываем из `storage.
    // chatMemory` заново (та же реакция, что у шкалы «RP Time» на этот же
    // ивент) и объявляем изменение по КАЖДОМУ трекеру, чтобы плавающая
    // панель и подвал сообщений отрисовали то, что реально принадлежит
    // новому чату, а не застывшую картинку из предыдущего.
    const subscriptions = [
        host.events.subscribe('st.chatChanged', () => {
            loadValuesForCurrentChat().then(() => {
                for (const tracker of trackers.values()) {
                    publishEvent(tracker.kind === 'system' ? 'tracking.systemBlocks.changed' : 'tracking.blocks.changed', { trackerId: tracker.id });
                }
            });
        }),
    ];

    return {
        configureTrackers,
        restoreTrackers,
        reset,
        trackers: () => [...trackers.values()].map(tracker => ({ ...tracker })),
        unregister: () => {
            for (const unsubscribers of triggerUnsubscribers.values()) for (const unsubscribe of unsubscribers) unsubscribe();
            for (const unregister of unregisters) unregister();
            for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
        },
    };
}
