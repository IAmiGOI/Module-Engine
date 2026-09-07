const DEFAULT_STORAGE_KEY = 'stme_memory';

/**
 * Сервис для chatMetadata — просто логический адаптер (ARCHITECTURE.md),
 * никакого неймспейсинга или бизнес-логики здесь: только "прочитать сырой
 * объект" / "записать сырой объект + дебаунс-сохранить", тот же
 * chatMetadata + saveMetadataDebounced, что Alpha использовала напрямую
 * (см. Alpha's notebook/store.js, core/data-bus.js). Первый реальный
 * потребитель — cores/memory/index.js, которое владеет неймспейсингом
 * (libraries/core/namespaced-store.js) поверх этого сырого объекта.
 *
 * `storageKey` — единственный ключ внутри chatMetadata, под которым живёт
 * ВСЯ память движка (все Ядра/Модули делят один физический слот в
 * chatMetadata; неймспейсинг внутри него — уровень Ядра, не этого Сервиса).
 */
export function registerChatMetadataService(bus, { getContext, storageKey = DEFAULT_STORAGE_KEY } = {}) {
    function readRaw() {
        return getContext().chatMetadata?.[storageKey] ?? {};
    }

    function writeRaw(raw) {
        const context = getContext();
        context.chatMetadata ??= {};
        context.chatMetadata[storageKey] = raw;
        context.saveMetadataDebounced?.();
    }

    /**
     * Форсирует РЕАЛЬНОЕ сохранение (`context.saveMetadata()`) прямо сейчас,
     * в обход `saveMetadataDebounced()`'s `setTimeout(..., debounce_timeout.relaxed)`
     * (1000ms — проверено по настоящему исходнику ST,
     * `public/scripts/extensions.js`'s `saveMetadataDebounced()`). Найдено
     * живьём (жалоба пользователя): бутстрап из Lorebook пишет `nodes`/
     * `regions`/`staging`/`mergeQueue`/`reconsolidationQueue` — пять
     * последовательных `writeRaw()`, каждый СБРАСЫВАЕТ и заново взводит тот
     * же таймер — если пользователь перезагружает страницу в течение
     * секунды после окончания бутстрапа (типичный момент — он ведь ТОЛЬКО
     * что достроился), реальный `saveMetadata()` ни разу не успевает
     * выполниться, и весь только что построенный граф теряется: после
     * релоада `nodes` в chatMetadata пуст, `bootstrapIfEmpty()` находит
     * пустой граф и достраивает его ЗАНОВО — воспринимается как "старый
     * граф не подгружается автоматически". `context.saveMetadata()` —
     * настоящий, ожидаемый (`await`) метод ST (`saveChatConditional()`),
     * безопасно звать напрямую.
     */
    async function flush() {
        await getContext().saveMetadata?.();
    }

    const unregisterRead = bus.register('chatMetadata.read', () => readRaw(), { loadMetric: () => 0 });
    const unregisterWrite = bus.register('chatMetadata.write', ({ raw }) => { writeRaw(raw); return true; }, { loadMetric: () => 0 });
    const unregisterFlush = bus.register('chatMetadata.flush', () => flush(), { loadMetric: () => 0 });

    return () => { unregisterRead(); unregisterWrite(); unregisterFlush(); };
}
