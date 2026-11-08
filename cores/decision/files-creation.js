import { allSections } from '../../libraries/core/decision-creation.js';
import { renderScaleFile, parseScaleFile, slugOf } from '../../libraries/core/creation-files.js';

/**
 * Поставщик файлового слоя для Creation (часть 21): God правит мир теми же
 * `view` / `edit` / `create`. Раздел — `Creation/<раздел>.md`, система весов —
 * `Creation/Scales/<система>.md`; новая строка в Discoveries — Открытие.
 */
const sectionPath = section => `Creation/${slugOf(section.title)}.md`;
const scalePath = system => `Creation/Scales/${slugOf(system.name)}.md`;
const norm = value => String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase();

export function createCreationProvider({ creation, state = {} }) {
    const current = () => creation.state();
    const findSection = path => allSections(current()).find(section => norm(sectionPath(section)) === norm(path));
    const findScale = path => (current().scales ?? []).find(system => norm(scalePath(system)) === norm(path));
    const isScale = path => /^creation\/scales\//.test(norm(path));

    return {
        owns: path => /^creation\//.test(norm(path)),
        async list() {
            await creation.load();
            return [...allSections(current()).map(sectionPath), ...(current().scales ?? []).map(scalePath)];
        },
        async read(path) {
            await creation.load();
            if (isScale(path)) {
                const system = findScale(path);
                return system ? { ok: true, path: scalePath(system), text: renderScaleFile(system) } : { ok: false, error: `There is no system "${path}" yet — create it.` };
            }
            const section = findSection(path);
            return section ? { ok: true, path: sectionPath(section), text: String(section.text ?? '') } : { ok: false, error: `There is no section "${path}" yet — create it.` };
        },
        async write(path, after, { comment = '' } = {}) {
            await creation.load();
            if (isScale(path)) {
                const before = findScale(path);
                const parsed = parseScaleFile(after);
                if (!parsed.system) parsed.system = before?.name ?? String(path).split('/').pop().replace(/\.md$/i, '').replace(/-/g, ' ');
                const written = await creation.writeScale(parsed);
                const known = new Set((before?.discoveries ?? []).map(item => `${item.rule ? `[${item.rule}] ` : ''}${item.text}`));
                for (const line of parsed.discoveries.filter(item => !known.has(item))) {
                    const tagged = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
                    await creation.writeDiscovery({ system: parsed.system, rule: tagged?.[1] ?? '', text: tagged?.[2] ?? line, at: state.rpLabel ?? '' });
                }
                return written;
            }
            const section = findSection(path);
            const title = section?.title ?? String(path).split('/').pop().replace(/\.md$/i, '').replace(/-/g, ' ');
            return creation.writeSections({ sections: [{ title, text: String(after ?? '') }], at: state.rpLabel ?? '', by: 'god', comment });
        },
    };
}
