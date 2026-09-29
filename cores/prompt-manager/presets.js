import { request } from '../../libraries/shared/request.js';
import { stToPreset } from '../../libraries/core/pm-st-import.js';
import { presetToSt, stripSecrets } from '../../libraries/core/pm-st-export.js';
import { PM_FORMAT_VERSION } from '../../libraries/core/pm-preset-format.js';

const MAX_VERSIONS = 30;
const newId = () => `pm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Хранение пресетов PM (записи в indexedDB через Сервис `pmPresets.*`): создание, импорт из ST, экспорт
 * (в формат ST и в свой), версии с откатом. Запись: `{ id, name, sourceName, updatedAt, size, preset }`;
 * `sourceName` — имя пресета ST, из которого сделана внутренняя копия (файлы ST не трогаем).
 */
export function createPresetStore(host, { now = () => Date.now() } = {}) {
    const call = async (contract, params) => {
        const result = await request(host.services, contract, { params });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
    };

    const list = () => call('pmPresets.list', {});
    const get = id => call('pmPresets.get', { id });

    async function save(record, { label = 'save', version = true } = {}) {
        const updatedAt = now();
        const full = { ...record, id: record.id ?? newId(), updatedAt, size: JSON.stringify(record.preset).length };
        await call('pmPresets.put', { record: full });
        if (version) {
            await call('pmPresets.versions.put', { record: { key: `${full.id}:${updatedAt}`, presetId: full.id, at: updatedAt, label, preset: full.preset } });
            const versions = await call('pmPresets.versions.list', { presetId: full.id });
            for (const old of versions.slice(MAX_VERSIONS)) await call('pmPresets.versions.delete', { key: old.key });
        }
        return full;
    }

    async function importSt(json, { name, sourceName } = {}) {
        const preset = stToPreset(json, { name: name ?? sourceName ?? 'Imported preset' });
        return save({ name: preset.name, sourceName: sourceName ?? null, preset }, { label: 'import' });
    }

    /** Внутренние копии всех пресетов ST, у которых копии ещё нет (файлы ST не меняются). Возвращает созданные. */
    async function prepareFromSt(stPresets) {
        const existing = new Set((await list()).map(item => item.sourceName).filter(Boolean));
        const created = [];
        for (const { name, preset } of stPresets) {
            if (existing.has(name)) continue;
            try { created.push(await importSt(preset, { name, sourceName: name })); } catch { /* не пресет Chat Completion — пропускаем */ }
        }
        return created;
    }

    async function exportSt(id) {
        const record = await get(id);
        if (!record) throw new Error(`promptManager: unknown preset "${id}".`);
        return presetToSt(record.preset);
    }

    /** Свой формат: пресет целиком + версия формата; секреты в непрозрачных полях чистятся и здесь. */
    async function exportNative(id) {
        const record = await get(id);
        if (!record) throw new Error(`promptManager: unknown preset "${id}".`);
        return { format: 'st-module-engine-preset', formatVersion: PM_FORMAT_VERSION, name: record.name, preset: { ...record.preset, opaque: stripSecrets(record.preset.opaque) } };
    }

    async function importNative(file) {
        if (file?.format !== 'st-module-engine-preset' || !file.preset) throw new Error('This file is not a Module Engine preset.');
        return save({ name: file.name ?? file.preset.name, sourceName: null, preset: file.preset }, { label: 'import' });
    }

    async function duplicate(id, name) {
        const record = await get(id);
        if (!record) throw new Error(`promptManager: unknown preset "${id}".`);
        return save({ name: name ?? `${record.name} (copy)`, sourceName: null, preset: structuredClone(record.preset) }, { label: 'duplicate' });
    }

    async function rollback(presetId, key) {
        const version = await call('pmPresets.versions.get', { key });
        const record = await get(presetId);
        if (!version || !record) throw new Error('promptManager: unknown version.');
        return save({ ...record, preset: version.preset }, { label: `rollback to ${new Date(version.at).toISOString()}` });
    }

    return {
        list, get, save, importSt, prepareFromSt, exportSt, exportNative, importNative, duplicate, rollback,
        remove: id => call('pmPresets.delete', { id }),
        versions: presetId => call('pmPresets.versions.list', { presetId }),
    };
}
