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

    const unregisterRead = bus.register('chatMetadata.read', () => readRaw(), { loadMetric: () => 0 });
    const unregisterWrite = bus.register('chatMetadata.write', ({ raw }) => { writeRaw(raw); return true; }, { loadMetric: () => 0 });

    return () => { unregisterRead(); unregisterWrite(); };
}
