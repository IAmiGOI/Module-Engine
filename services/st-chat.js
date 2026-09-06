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
 */
export function registerStChatService(bus, { getContext } = {}) {
    /** `limit` — сколько ПОСЛЕДНИХ сообщений вернуть; `includeSystem` по умолчанию false, системные строки в контексте почти всегда шум. */
    function readChat({ limit = 10, includeSystem = false } = {}) {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return [];
        return chat
            .map((message, index) => ({ message, mesid: String(index) }))
            .filter(({ message }) => includeSystem || !message?.is_system)
            .slice(-Math.max(0, limit))
            .map(({ message, mesid }) => ({
                mesid,
                isUser: Boolean(message?.is_user),
                isSystem: Boolean(message?.is_system),
                name: String(message?.name ?? ''),
                text: String(message?.mes ?? ''),
                sendDate: message?.send_date ?? null,
                isToolCall: Array.isArray(message?.extra?.tool_invocations) && message.extra.tool_invocations.length > 0,
                hasReasoning: Boolean(message?.extra?.reasoning),
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

    const unregisters = [
        bus.register('stChat.messages', params => readChat(params), { loadMetric: () => 0 }),
        bus.register('stChat.setHidden', params => setMessageHidden(params), { loadMetric: () => 0 }),
        bus.register('stChat.messageElement', params => messageElement(params?.mesid), { loadMetric: () => 0 }),
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
