import { request } from '../../libraries/shared/request.js';
import { buildSnapshot, isValidSnapshot, resolveSnapshotSources } from '../../libraries/core/backup-snapshot.js';

/**
 * Полноценное Бэкап Ядро (CORES.md) — экспорт/импорт снапшота во ВНЕШНИЙ
 * файл (не снапшоты внутри чата — осознанный выбор: другое устройство,
 * переустановка, ручной перенос между установками). Ничего не знает о
 * chatMetadata/extensionSettings/что угодно ещё конкретно — источники
 * пристёгиваются снаружи через `registerSource()`, тем же принципом, что
 * `configureWorkers()` у Ядра внутренних моделей движка: этот файл не
 * меняется, когда появляется новый источник (например, будущее Ядро
 * сохранения) — регистрируется извне, при сборке движка.
 *
 * *(Заготовка на будущее, не реализовано сейчас: когда появятся настоящие
 * Блоки (ARCHITECTURE.md), источники смогут САМИ объявлять себя через Блок
 * `backup.sources`, и это Ядро сможет обнаруживать их динамически вместо
 * ручной регистрации — сейчас Блоков ещё нет в коде, ручная регистрация
 * проще и ничего не блокирует такой переход позже.)*
 *
 * Регистрирует `backup.export`/`backup.import` на Шине ядер. Сам файловый
 * ввод-вывод (скачать/прочитать файл) — отдельный тонкий Сервис
 * ([services/file.js](../../services/file.js)) — это Ядро говорит только на
 * языке JS-объекта снапшота, сериализация в JSON и вызов `file.download`/
 * `file.readText` — забота будущего Модуля с UI поверх обоих Ядер.
 */
export function createBackupCore(host) {
    const sources = new Map(); // id -> { readRaw: () => Promise<raw>, writeRaw: (raw) => Promise<void> }

    /** `source` = `{ readRaw: () => Promise<any>, writeRaw: (raw) => Promise<void> }`. Returns an unregister function. */
    function registerSource(id, source) {
        sources.set(id, source);
        return () => sources.delete(id);
    }

    async function exportSnapshot() {
        const entries = await Promise.all([...sources.entries()].map(async ([id, source]) => ({ id, raw: await source.readRaw() })));
        return buildSnapshot(entries);
    }

    /** Restores every source the snapshot AND this engine both recognize; a source id present in the file but not currently registered here is silently skipped — an older/differently-configured engine's backup must not fail outright just because it mentions a Ядро this install doesn't have. Returns the list of source ids actually restored. */
    async function importSnapshot(snapshot) {
        if (!isValidSnapshot(snapshot)) throw new Error('backup.import: not a recognizable backup snapshot.');
        const restored = [];
        for (const [id, raw] of Object.entries(resolveSnapshotSources(snapshot))) {
            const source = sources.get(id);
            if (!source) continue;
            await source.writeRaw(raw);
            restored.push(id);
        }
        return restored;
    }

    const unregisterExport = host.own.register('backup.export', () => exportSnapshot());
    const unregisterImport = host.own.register('backup.import', params => importSnapshot(params?.snapshot));

    return {
        registerSource,
        unregister: () => { unregisterExport(); unregisterImport(); },
    };
}

/**
 * The one concrete source adapter that exists today — bridges Ядро бэкапа to
 * Ядро внутренней памяти чата's own thin Сервис ([services/chat-metadata.js](../../services/chat-metadata.js)),
 * through the SAME `host.services` a real Ядро внутренней памяти чата
 * instance would use (real Гейт, real rights check — this Ядро has no
 * special access of its own). `host` here belongs to whoever calls
 * `registerSource('chatMemory', createChatMetadataBackupSource(host))` —
 * ordinarily this Ядро бэкапа's OWN host, since reading/writing chatMetadata
 * is a `cores` -> `services` crossing either way.
 */
export function createChatMetadataBackupSource(host) {
    return {
        async readRaw() {
            const result = await request(host.services, 'chatMetadata.read', {});
            if (!result.ok) throw new Error(result.error.message);
            return result.value ?? {};
        },
        async writeRaw(raw) {
            const result = await request(host.services, 'chatMetadata.write', { params: { raw } });
            if (!result.ok) throw new Error(result.error.message);
        },
    };
}

/**
 * The second concrete source adapter — the "будущее Ядро сохранения
 * подключится тем же способом" promise above, now real. Mirrors
 * `createChatMetadataBackupSource()` exactly, just against
 * [services/extension-settings.js](../../services/extension-settings.js)
 * (global settings) instead of chatMetadata (chat-scoped data) — this file
 * itself needed zero changes to gain a second source.
 */
export function createExtensionSettingsBackupSource(host) {
    return {
        async readRaw() {
            const result = await request(host.services, 'extensionSettings.read', {});
            if (!result.ok) throw new Error(result.error.message);
            return result.value ?? {};
        },
        async writeRaw(raw) {
            const result = await request(host.services, 'extensionSettings.write', { params: { raw } });
            if (!result.ok) throw new Error(result.error.message);
        },
    };
}
