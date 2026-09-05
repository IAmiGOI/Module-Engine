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
 * Форма сообщения нормализуется: `{ isUser, isSystem, name, text }`. Наружу не
 * протекают ни `mes`, ни `is_user` — сырые имена полей ST остаются внутри
 * этого файла, как и везде в Сервисах.
 */
export function registerStChatService(bus, { getContext } = {}) {
    /** `limit` — сколько ПОСЛЕДНИХ сообщений вернуть; `includeSystem` по умолчанию false, системные строки в контексте почти всегда шум. */
    function readChat({ limit = 10, includeSystem = false } = {}) {
        const chat = getContext()?.chat;
        if (!Array.isArray(chat)) return [];
        return chat
            .filter(message => includeSystem || !message?.is_system)
            .slice(-Math.max(0, limit))
            .map(message => ({
                isUser: Boolean(message?.is_user),
                isSystem: Boolean(message?.is_system),
                name: String(message?.name ?? ''),
                text: String(message?.mes ?? ''),
            }));
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
        bus.register('stChat.messageElement', params => messageElement(params?.mesid), { loadMetric: () => 0 }),
        /** Контейнер всего чата — за ним наблюдают, чтобы заметить перерисовку, о которой никто не сообщил. */
        bus.register('stChat.container', () => document.getElementById('chat'), { loadMetric: () => 0 }),
        /** Идентификаторы всех сообщений, что сейчас в DOM. */
        bus.register('stChat.renderedIds', () => [...document.querySelectorAll('#chat .mes[mesid]')].map(node => node.getAttribute('mesid')), { loadMetric: () => 0 }),
        bus.register('stChat.length', () => (Array.isArray(getContext()?.chat) ? getContext().chat.length : 0), { loadMetric: () => 0 }),
    ];

    return () => { for (const unregister of unregisters) unregister(); };
}
