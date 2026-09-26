/**
 * Сервис чата ST — единственное место, знающее про `context.chat` (сам массив
 * сообщений). Логический адаптер: отдать последние N сообщений в нейтральной
 * форме, и всё. Ни обрезки под промпт, ни склейки в текст — это уже решение
 * потребителя, а у разных потребителей оно разное.
 *
 * Отдельно от [Сервиса метаданных чата](chat-metadata.js): тот про
 * `chatMetadata` (наше хранилище при чате), этот — про сами сообщения. Их
 * легко перепутать по названию, но это разные части ST API.
 *
 * Форма сообщения нормализуется: `{ mesid, isUser, isSystem, name, text,
 * sendDate, isToolCall, hasReasoning }`. Наружу не протекают ни `mes`, ни
 * `is_user`/`extra` целиком — сырые имена полей ST остаются внутри этого
 * файла, как и везде в Сервисах.
 *
 * `mesid` — индекс сообщения в `context.chat`, тем же числом-строкой, каким
 * его ставит сама ST в разметку (`.mes[mesid]`, см. `stChat.rendered` ниже).
 * Посчитан ДО фильтрации системных, а не после: иначе позиция в отфильтрованном
 * списке разъехалась бы с реальным индексом, и всё, что привязывает свою
 * информацию к КОНКРЕТНОМУ сообщению (Ядро истории чата), привязывалось бы не
 * туда.
 *
 * `isToolCall`/`hasReasoning` добавлены для BasicSummary (ROADMAP.md): без них
 * нечем отличить цепочку ToolCall (вызов → результат → настоящий ответ — «черновик
 * по пути», см. doc-comment [cores/generation/index.js](../cores/generation/index.js))
 * от простого сообщения при подсчёте порога свёртки. Поле проверено по
 * реальному ST: `extra.tool_invocations` — тот же признак, каким сама ST
 * фильтрует `coreChat` (script.js, `Generate()`).
 *
 * `mesids` — второй, ТОЧЕЧНЫЙ режим чтения, рядом с `limit` (BasicSummary
 * verify, ROADMAP.md): когда задан, возвращает РОВНО эти сообщения по их
 * `mesid`, в исходном порядке, полностью игнорируя `limit`/хвостовой срез —
 * проверка саммари уровня 2 читает КОНКРЕТНЫЕ старые сообщения (из
 * `coveredIds` давно свёрнутых детей уровня 1), которые почти всегда далеко
 * за пределами любого разумного «последние N». `includeSystem` в этом режиме
 * неявно `true` — иначе уже скрытые Summary-фолдом сообщения (ровно то, ради
 * чего этот режим и нужен) никогда бы не вернулись.
 */
/**
 * Аватар сообщения — та же логика, что настоящая `updateMessageElement()`
 * (script.js:2559): `force_avatar` (персона/переключение голоса — уже
 * готовый URL) в приоритете; иначе, для НЕ-пользовательской реплики, аватар
 * текущего персонажа (`context.characters[context.characterId]`). Пользова-
 * тельская реплика БЕЗ `force_avatar` возвращает `null` честно — глобальный
 * `user_avatar` (аватар персоны по умолчанию) не экспортирован через
 * `getContext()`, резолвить его отсюда нечем.
 *
 * `/characters/<file>` — НЕ `context.getThumbnailUrl('avatar', ...)` —
 * НАЙДЕНО ЖИВЬЁМ: owner: "нужно в фото увеличить его четкость, оно очень
 * пиксельное". `getThumbnailUrl` отдаёт СЕРВЕРНЫЙ уменьшенный превью-файл
 * (проверено: 96×144, заметно и агрессивно сжатый JPEG) — рассчитан на
 * родной аватар ST (~32-40px), где сжатие не видно. Chat Viewport рисует
 * аватар в разы крупнее (102×136 портрет, см. `Avatar()` в widgets.js) —
 * тот же файл, растянутый чуть больше номинала, показывает компрессионные
 * артефакты как есть. `/characters/<file>` — тот же путь, что настоящая
 * ST дёргает для сброса кэша аватарки (script.js, `fetch(\`/characters/
 * ${avatarKey}\`...)`) — отдаёт ИСХОДНЫЙ файл карточки персонажа без
 * пережатия (проверено: 900×888) — браузер сам уменьшает его до 102×136
 * при отрисовке, с нормальным сглаживанием, а не отдаёт уже готовый
 * маленький сжатый файл. `force_avatar`-путь (переключение голоса/
 * персоны) этот фикс НЕ затрагивает — там свой, отдельный сервер-side
 * превью-путь ST, не разобран здесь за неимением живого случая для
 * проверки.
 */
function resolveAvatarUrl(message, context) {
    if (message?.force_avatar) return String(message.force_avatar);
    if (message?.is_user) return null;
    const character = context?.characters?.[context?.characterId];
    if (character && character.avatar && character.avatar !== 'none') {
        return `/characters/${encodeURIComponent(character.avatar)}`;
    }
    return null;
}

/**
 * Время генерации — та же пара полей и то же вычитание, что родная
 * `formatGenerationTimer()` (script.js:2681, там же через `moment().diff()`,
 * здесь — обычным `Date`, так как `moment` — зависимость ST, а не наша).
 * `null`, если ST не проставила хотя бы одно поле (сообщение пользователя,
 * либо старый чат до этой пары полей) — не 0, который выглядел бы как
 * настоящее мгновенное измерение.
 */
function computeGenDurationMs(message) {
    if (!message?.gen_started || !message?.gen_finished) return null;
    const start = new Date(message.gen_started).getTime();
    const finish = new Date(message.gen_finished).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return null;
    return finish - start;
}

export function registerStChatService(bus, { getContext } = {}) {
    /** `limit` — сколько ПОСЛЕДНИХ сообщений вернуть; `includeSystem` по умолчанию false, системные строки в контексте почти всегда шум. `mesids` — см. doc-comment файла. */
    function readChat({ limit = 10, includeSystem = false, mesids = null } = {}) {
        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat)) return [];
        const wanted = Array.isArray(mesids) ? new Set(mesids.map(String)) : null;
        return chat
            .map((message, index) => ({ message, mesid: String(index) }))
            .filter(({ mesid, message }) => (wanted ? wanted.has(mesid) : (includeSystem || !message?.is_system)))
            .slice(wanted ? 0 : -Math.max(0, limit))
            .map(({ message, mesid }) => ({
                mesid,
                isUser: Boolean(message?.is_user),
                isSystem: Boolean(message?.is_system),
                name: String(message?.name ?? ''),
                text: String(message?.mes ?? ''),
                sendDate: message?.send_date ?? null,
                isToolCall: Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0,
                hasReasoning: Boolean(message?.extra?.reasoning),
                reasoningText: String(message?.extra?.reasoning ?? ''),
                // См. doc-comment `resolveAvatarUrl()`/`computeGenDurationMs()`
                // выше файла — обе честно возвращают `null`, когда ST не дала
                // достаточно данных, а не угадывают.
                avatarUrl: resolveAvatarUrl(message, context),
                genDurationMs: computeGenDurationMs(message),
                // `swipes`/`swipe_id` — родные поля ST для алтернативных
                // ответов; `swipeCount` всегда ≥ 1, даже когда `swipes` вовсе
                // нет (ровно одна версия текста — не 0).
                swipeIndex: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0,
                swipeCount: Array.isArray(message?.swipes) ? message.swipes.length : 1,
            }));
    }

    /**
     * Скрытие/показ сообщения — `is_system` не двигает `mesid` (см. doc-comment
     * выше), поэтому это безопасная альтернатива удалению для BasicSummary:
     * свёрнутое сообщение пропадает из промпта (ST сама фильтрует `is_system`
     * при сборке `coreChat`), но остаётся адресуемым по тому же `mesid` для
     * всего, что уже привязало к нему свою информацию (`chatHistory.annotate`).
     */
    async function setMessageHidden({ mesid, hidden } = {}) {
        const context = getContext();
        const chat = context?.chat;
        const index = Number(mesid);
        if (!Array.isArray(chat) || !Number.isInteger(index) || !chat[index]) {
            throw new Error(`stChat.setHidden: no message at mesid "${mesid}".`);
        }
        chat[index].is_system = Boolean(hidden);
        await context.saveChat?.();
        return true;
    }

    /**
     * Полная замена текста сообщения — единственный легальный путь Модуля к
     * `message.mes`. В Alpha Post-Turn Processor лез в `context.chat`
     * напрямую; здесь то же самое делает Сервис, потому что знания «как ST
     * хранит и перерисовывает сообщение» — ST-шные и живут здесь, у Сервисов
     * (см. заголовок файла). После правки текста блок перерисовывается тем же
     * вызовом, каким это делает сама ST (`updateMessageBlock`), и чат
     * сохраняется настоящим `saveChatConditional` (не дебаунснутым: результат
     * пайплайна переписывания терять из-за секундного дебаунса нельзя —
     * та же логика, что у `setHidden` выше).
     */
    /**
     * Пользовательские сообщения раньше были запрещены (написано под
     * BasicSummary — переписыватель никогда не трогает реплики пользователя).
     * Общее редактирование Chat Viewport этого ограничения не разделяет:
     * пользователь редактирует и свои, и чужие реплики — запрет снят здесь, а
     * не обойден по краю вызывающим кодом.
     *
     * Эмитит `MESSAGE_EDITED` ДО перерисовки и `MESSAGE_UPDATED` после — тем
     * же порядком, что родная `messageEditDone()` (script.js) — без этого
     * другие подписчики ST (перевод, память) не узнают, что текст поменялся.
     * Не воспроизведён ровно один нюанс родной функции: она ПЕРЕЧИТЫВАЕТ
     * `chat[id].mes` ПОСЛЕ `MESSAGE_EDITED` (на случай, если сам обработчик
     * события правит текст ещё раз) — здесь то, что записали, то и рисуется.
     */
    async function setMessageText({ mesid, text } = {}) {
        const context = getContext();
        const chat = context?.chat;
        const index = Number(mesid);
        if (!Array.isArray(chat) || !Number.isInteger(index) || !chat[index]) {
            throw new Error(`stChat.setText: no message at mesid "${mesid}".`);
        }
        const message = chat[index];
        const next = String(text ?? '');
        if (!next.trim()) throw new Error(`stChat.setText: "text" is required.`);
        message.mes = next;
        await context.eventSource?.emit?.(context.eventTypes?.MESSAGE_EDITED, index);
        // Перерисовка — тем же механизмом ST, каким она сама обновляет блок
        // сообщения (RP Time/Tracker Alpha звали `context.updateMessageBlock`).
        context.updateMessageBlock?.(index, message);
        await context.eventSource?.emit?.(context.eventTypes?.MESSAGE_UPDATED, index);
        // `saveChatConditional` сначала, `saveChat` следом — оба, как у Alpha:
        // в части сборок ST один из них может отсутствовать.
        await context.saveChatConditional?.();
        await context.saveChat?.();
        return true;
    }

    /**
     * Удаление сообщения — тонкий проброс к `getContext().deleteMessage`
     * (экспортирована самой ST, `st-context.js`). `askConfirmation: false`
     * ВСЕГДА — подтверждение уже наше (Chat Viewport рисует свой диалог), а
     * не родной `callGenericPopup` ST поверх спрятанного нативного чата.
     *
     * **Важное ограничение, найденное в реальном исходнике ST (не
     * гипотетическое)**: `deleteMessage()` сначала ищет
     * `chatElement.find('.mes[mesid="id"]')` и молча выходит, НИЧЕГО не
     * удаляя, если элемент не найден в DOM — то есть родной `#chat` обязан
     * оставаться в документе (пусть и скрытым по CSS), а не быть
     * выброшенным. Это ещё одно, отдельное от стриминга, подтверждение
     * решения "подавлять #chat, не удалять" из плана `chat-viewport`.
     */
    async function deleteMessage({ mesid } = {}) {
        const context = getContext();
        const index = Number(mesid);
        if (!Number.isInteger(index)) throw new Error(`stChat.deleteMessage: invalid mesid "${mesid}".`);
        if (typeof context?.deleteMessage !== 'function') throw new Error('stChat.deleteMessage: SillyTavern deleteMessage() is unavailable.');
        await context.deleteMessage(index, undefined, false);
        return true;
    }

    /**
     * Свайп — тонкий проброс к `getContext().swipe_left`/`swipe_right`.
     * `event: null` — обе функции ST принимают отсутствие реального
     * DOM-события явно (`swipe_right(event = null, ...)` в её исходнике);
     * `message` передаётся ЯВНО (само сообщение из `context.chat`, не индекс)
     * — иначе обе функции по умолчанию свайпают ПОСЛЕДНЕЕ сообщение чата,
     * что для виртуализированного списка неверно почти всегда.
     *
     * `context.swipe?.[direction]` — НАЙДЕНО ЖИВЬЁМ: в реальной установленной
     * версии ST `swipe_left`/`swipe_right` больше НЕ лежат прямо на
     * `context` (`context.swipe_left` — `undefined`) — они переехали под
     * `context.swipe.left`/`context.swipe.right` (см. `st-context.js`).
     * Старое предположение "плоское поле" было верным для более ранней
     * версии, на которой разведка изначально читала исходник, и с тех пор
     * тихо устарело — свайп не работал вообще, на любом сообщении, не
     * только на стартовом (просто оно чаще всего под рукой для проверки).
     * Пробуем оба пути: плоский первым (старые/другие сборки), вложенный —
     * запасной, чтобы не переломать гипотетическую более старую ST снова.
     */
    async function swipeMessage({ mesid, direction } = {}) {
        const context = getContext();
        const chat = context?.chat;
        const index = Number(mesid);
        if (!Array.isArray(chat) || !Number.isInteger(index) || !chat[index]) {
            throw new Error(`stChat.swipe: no message at mesid "${mesid}".`);
        }
        const flat = direction === 'left' ? context.swipe_left : context.swipe_right;
        const nested = context.swipe?.[direction];
        const fn = typeof flat === 'function' ? flat : nested;
        if (typeof fn !== 'function') throw new Error(`stChat.swipe: SillyTavern swipe_${direction} is unavailable.`);
        await fn(null, { message: chat[index] });
        return true;
    }

    /**
     * Регенерация — тонкий проброс к `getContext().generate('regenerate')`.
     * Без `mesid`: ST сама регенерирует последнее сообщение чата — родное
     * поведение (`Generate('regenerate')`, тот же вызов, что использует сама
     * ST для своей кнопки, script.js), Chat Viewport не переизобретает
     * "какое сообщение считается текущим для регенерации".
     */
    async function regenerate() {
        const context = getContext();
        if (typeof context?.generate !== 'function') throw new Error('stChat.regenerate: SillyTavern generate() is unavailable.');
        await context.generate('regenerate');
        return true;
    }

    /**
     * Тонкий проброс к родному `messageFormatting()` — тот же
     * markdown/макро-рендер, каким ST рисует `.mes_text` сама. Существует
     * здесь (а не в Ядре), потому что "как вызвать конкретно ЭТУ функцию ST с
     * конкретно ЭТИМИ аргументами" — ST-шное знание, тот же принцип, что у
     * остального файла. Поля сообщения (`name`/`isSystem`/`isUser`) читаются
     * САМИ по `mesid`, а не передаются вызывающим — Ядру Chat Viewport не
     * нужно знать форму `context.chat`, только `mesid`.
     */
    function formatMessage({ mesid, isReasoning = false } = {}) {
        const context = getContext();
        const chat = context?.chat;
        const index = Number(mesid);
        if (!Array.isArray(chat) || !Number.isInteger(index) || !chat[index]) {
            throw new Error(`stChat.formatMessage: no message at mesid "${mesid}".`);
        }
        if (typeof context.messageFormatting !== 'function') throw new Error('stChat.formatMessage: SillyTavern messageFormatting() is unavailable.');
        const message = chat[index];
        return String(context.messageFormatting(
            String(message?.mes ?? ''),
            String(message?.name ?? ''),
            Boolean(message?.is_system),
            Boolean(message?.is_user),
            index,
            {},
            Boolean(isReasoning),
        ) ?? '');
    }

    /**
     * Куда именно ST рисует одно сообщение. Знание чисто ST-шное (её разметка
     * и атрибут `mesid`), поэтому живёт здесь, а не в общем Сервисе DOM: тот
     * умеет работать с любым узлом, но не обязан знать, как SillyTavern
     * называет свои.
     *
     * `.mes_block` — вся колонка сообщения, включая текст и низ; именно она
     * даёт полную ширину чата. `.mes_text` был бы уже колонкой текста.
     */
    function messageElement(mesid) {
        const root = document.querySelector(`#chat .mes[mesid="${mesid}"]`) ?? document.querySelector(`.mes[mesid="${mesid}"]`);
        return root?.querySelector('.mes_block') ?? root ?? null;
    }

    /**
     * The rendered TEXT column of one message (`.mes_text`) — narrower than
     * `messageElement()`'s `.mes_block` on purpose. Speaker-coloring paints
     * runs of the message's own rendered text (services/dom.js's
     * `dom.paintTextRuns`); the footer bar and other `.mes_block` siblings
     * must never be walked as if they were message prose.
     */
    function messageTextElement(mesid) {
        const root = document.querySelector(`#chat .mes[mesid="${mesid}"]`) ?? document.querySelector(`.mes[mesid="${mesid}"]`);
        return root?.querySelector('.mes_text') ?? null;
    }

    /**
     * Кнопки родного сообщения ST (`.mes_button` в шаблоне `#message_template`): id действия вьюпорта → CSS-селектор кнопки. У ST всю работу
     * (диалог промпта, выбор файла, перевод, ветка чата, скрытие с сохранением) делает обработчик КЛИКА на этой кнопке — вьюпорт нажимает её,
     * а не переписывает логику ST (тот же принцип, что у остальных методов файла). Узла `.mes` может не быть: ST рисует в `#chat` не все сообщения.
     */
    const NATIVE_BUTTONS = Object.freeze({
        hide: '.mes_hide', unhide: '.mes_unhide', prompt: '.mes_prompt', embed: '.mes_embed', translate: '.mes_translate',
        image: '.sd_message_gen', narrate: '.mes_narrate', swipePicker: '.mes_swipe_picker', checkpoint: '.mes_create_bookmark',
        branch: '.mes_create_branch', openCheckpoint: '.mes_bookmark',
    });

    const nativeMessage = mesid => document.querySelector(`#chat .mes[mesid="${mesid}"]`) ?? document.querySelector(`.mes[mesid="${mesid}"]`);
    /** Кнопка «есть» только когда ST её сейчас показывает: одни (промпт, свайпы) ST прячет, пока действие невозможно, другие приходят с расширениями. */
    const nativeButtonAvailable = button => Boolean(button) && document.defaultView.getComputedStyle(button).display !== 'none';

    /** Доступные СЕЙЧАС родные действия сообщения: `{ hasNative, available: [id, …] }`. */
    function nativeActions({ mesid } = {}) {
        const root = nativeMessage(mesid);
        if (!root) return { hasNative: false, available: [] };
        const available = Object.entries(NATIVE_BUTTONS)
            .filter(([, selector]) => nativeButtonAvailable(root.querySelector(selector)))
            .map(([id]) => id);
        return { hasNative: true, available };
    }

    /** Нажимает родную кнопку действия. `false` — кнопки нет или ST её сейчас не показывает. */
    function triggerNative({ mesid, action } = {}) {
        const selector = NATIVE_BUTTONS[action];
        const button = selector ? nativeMessage(mesid)?.querySelector(selector) : null;
        if (!nativeButtonAvailable(button)) return false;
        button.click();
        return true;
    }

    const unregisters = [
        bus.register('stChat.messages', params => readChat(params), { loadMetric: () => 0 }),
        bus.register('stChat.setHidden', params => setMessageHidden(params), { loadMetric: () => 0 }),
        bus.register('stChat.setText', params => setMessageText(params), { loadMetric: () => 0 }),
        bus.register('stChat.deleteMessage', params => deleteMessage(params), { loadMetric: () => 0 }),
        bus.register('stChat.swipe', params => swipeMessage(params), { loadMetric: () => 0 }),
        bus.register('stChat.regenerate', () => regenerate(), { loadMetric: () => 0 }),
        bus.register('stChat.formatMessage', params => formatMessage(params), { loadMetric: () => 0 }),
        bus.register('stChat.nativeActions', params => nativeActions(params), { loadMetric: () => 0 }),
        bus.register('stChat.triggerNative', params => triggerNative(params), { loadMetric: () => 0 }),
        bus.register('stChat.messageElement', params => messageElement(params?.mesid), { loadMetric: () => 0 }),
        bus.register('stChat.messageTextElement', params => messageTextElement(params?.mesid), { loadMetric: () => 0 }),
        /** Контейнер всего чата — за ним наблюдают, чтобы заметить перерисовку, о которой никто не сообщил. */
        bus.register('stChat.container', () => document.getElementById('chat'), { loadMetric: () => 0 }),
        /** Идентификаторы всех сообщений, что сейчас в DOM. */
        bus.register('stChat.renderedIds', () => [...document.querySelectorAll('#chat .mes[mesid]')].map(node => node.getAttribute('mesid')), { loadMetric: () => 0 }),
        /**
         * То же, но с ролью каждого сообщения. Нужно тому, кто рисует что-то
         * ПОД сообщением: бейджу времени нечего делать под репликой
         * пользователя, а по одному `mesid` роль не узнать. Атрибуты `is_user`
         * и `is_system` — строки `"true"`/`"false"` (проверено по разметке ST
         * 1.16.0), наружу отдаём нормальные булевы, как и `stChat.messages`.
         *
         * `isToolCall` — сообщение с вызовом инструмента (ST ставит ему класс
         * `toolCall`, когда у него есть `mes.extra.tool_invocations`, см.
         * script.js). Это НЕ отдельное служебное сообщение — та же самая
         * реплика персонажа, просто с вызовом инструмента внутри; следом за
         * ней ST добавит ЕЩЁ одну, уже настоящую реплику-продолжение. До неё
         * это сообщение — черновик по пути, а не окончательный ответ.
         */
        bus.register('stChat.rendered', () => [...document.querySelectorAll('#chat .mes[mesid]')].map(node => ({
            mesid: node.getAttribute('mesid'),
            isUser: node.getAttribute('is_user') === 'true',
            isSystem: node.getAttribute('is_system') === 'true',
            isToolCall: node.classList.contains('toolCall'),
        })), { loadMetric: () => 0 }),
        bus.register('stChat.length', () => (Array.isArray(getContext()?.chat) ? getContext().chat.length : 0), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
