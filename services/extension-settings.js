const DEFAULT_STORAGE_KEY = 'stme_settings';

/**
 * Сервис для extensionSettings — просто логический адаптер (ARCHITECTURE.md),
 * зеркало [chat-metadata.js](chat-metadata.js) но для ГЛОБАЛЬНЫХ (не
 * привязанных к чату) настроек. Реальный ST API — тот же, что Alpha
 * использовала напрямую в module-engine.js: `context.extensionSettings`
 * (обычный объект) + сохранение через `saveSettingsDebounced` с фоллбэком
 * на `saveSettings` — разные версии ST выставляют один из двух методов.
 */
export function registerExtensionSettingsService(bus, { getContext, storageKey = DEFAULT_STORAGE_KEY } = {}) {
    function readRaw() {
        return getContext().extensionSettings?.[storageKey] ?? {};
    }

    function writeRaw(raw) {
        const context = getContext();
        context.extensionSettings ??= {};
        context.extensionSettings[storageKey] = raw;
        context.saveSettingsDebounced?.();
        context.saveSettings?.();
    }

    const unregisterRead = bus.register('extensionSettings.read', () => readRaw(), { loadMetric: () => 0 });
    const unregisterWrite = bus.register('extensionSettings.write', ({ raw }) => { writeRaw(raw); return true; }, { loadMetric: () => 0 });

    return () => { unregisterRead(); unregisterWrite(); };
}
