import { buildPresetView } from '../../libraries/core/guide-preset.js';

/**
 * Что гид знает о пресетах Prompt Manager: список (id, имя, какой активен, дубли по имени) и, пока тема в фокусе, полный вид активного пресета и названного в переписке
 * (по полному имени) со списком сохранённых версий. Полные тексты идут только для двух пресетов: пресет весит тысячи токенов, а гиду нужны именно те, что она правит.
 */
const MAX_LISTED = 40;
const MAX_DETAILED = 2;
const MAX_VERSIONS_SHOWN = 8;
const MIN_NAME_LENGTH_TO_MATCH = 4;

const escapeForRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesPresetInText = (name, text) => name.length >= MIN_NAME_LENGTH_TO_MATCH && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeForRegExp(name)}([^\\p{L}\\p{N}]|$)`, 'iu').test(text);
const formatVersionDate = at => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

export function createPresetContext({ call }) {
    async function listEntries() {
        const listed = await call('promptManager.presets');
        return listed.ok ? listed.value ?? [] : [];
    }

    /** `{ lines, count }`: строки для промпта (пусто, пока тема не в фокусе) и число пресетов для строки «есть ещё». */
    async function describe({ focus, query = '' }) {
        const entries = await listEntries();
        if (!focus.presets || !entries.length) return { lines: [], count: entries.length };
        const settings = await call('promptManager.settings');
        const activeId = settings.ok ? settings.value?.activePresetId ?? null : null;
        const counts = new Map();
        for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
        const listed = entries.slice(0, MAX_LISTED).map(entry => `${entry.id} (“${entry.name}”${entry.id === activeId ? ', ACTIVE' : ''}${counts.get(entry.name) > 1 ? ', same name as another' : ''})`).join('; ');
        const lines = [`Prompt Manager presets (id — name): ${listed}${entries.length > MAX_LISTED ? `; …and ${entries.length - MAX_LISTED} more` : ''}. ${settings.ok && settings.value?.enabled === false ? 'The Prompt Manager is switched OFF: ST builds the request itself. ' : ''}Presets below are shown in full; for another preset ask the user to name it.`];
        const picked = [];
        const active = entries.find(entry => entry.id === activeId);
        if (active) picked.push(active);
        for (const entry of entries) {
            if (picked.length >= MAX_DETAILED) break;
            if (!picked.includes(entry) && namesPresetInText(entry.name, query)) picked.push(entry);
        }
        for (const entry of picked) {
            const record = await call('promptManager.preset', { id: entry.id });
            if (!record.ok || !record.value) continue;
            const versions = await call('promptManager.versions', { presetId: entry.id });
            const versionLine = versions.ok && versions.value?.length
                ? `Saved versions of ${entry.id} (newest first; key — when — note): ${versions.value.slice(0, MAX_VERSIONS_SHOWN).map(version => `${version.key} — ${formatVersionDate(version.at)} — ${version.label}`).join('; ')}.`
                : `No saved versions of ${entry.id} yet.`;
            lines.push(`${buildPresetView(record.value, { isActive: entry.id === activeId })}\n${versionLine}`);
        }
        return { lines, count: entries.length };
    }

    return { describe };
}
