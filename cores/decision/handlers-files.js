import { createFileLayer, parseCharacterPath } from './files-layer.js';
import { pendingDecisions } from '../../libraries/core/decision-director.js';

/**
 * Обработчики файловых инструментов (`view`, `edit`, `create`) и решения по
 * предложениям резолвера. Правка `decree.md` — это и есть выпуск Указа: она
 * отмечается в состоянии цикла директора (часть 21).
 */
export function createFileHandlers({ banks = null, state = {}, publishEvent = () => {}, by = 'director', layer = null, beforeWrite = null } = {}) {
    const files = layer ?? createFileLayer({ banks, beforeWrite });
    const noteDecree = paths => {
        const names = paths.map(parseCharacterPath).filter(target => target?.part === 'decree').map(target => target.name);
        if (!names.length) return;
        state.decreeIssued = true;
        state.decreeNames = [...new Set([...(state.decreeNames ?? []), ...names])];
        publishEvent('decision.decree', { characters: names, at: '' });
    };
    return {
        view: async args => {
            const path = String(args?.path ?? '').trim();
            if (!path) return { ok: true, files: await files.list() };
            return files.read(path);
        },
        edit: async args => {
            const result = await files.edit({ edits: args?.edits, comment: String(args?.comment ?? '') }, { by });
            noteDecree((Array.isArray(result?.files) ? result.files : []).filter(file => file.ok && !file.unchanged).map(file => file.path));
            return result;
        },
        create: async args => {
            const result = await files.create({ path: args?.path, text: args?.text, comment: String(args?.comment ?? '') }, { by });
            if (result?.ok !== false) noteDecree([String(args?.path ?? '')]);
            return result;
        },
        resolve_proposals: async args => {
            const decisions = [];
            for (const item of pendingDecisions(args?.decisions)) {
                const answer = await banks?.great?.resolvePending?.(item);
                decisions.push({ character: item.character, accept: item.accept, ok: answer?.ok !== false, ...(answer?.error ? { error: answer.error } : {}) });
            }
            return { ok: true, decisions };
        },
    };
}
