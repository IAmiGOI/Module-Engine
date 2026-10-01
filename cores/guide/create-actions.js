import { normalizeTracker, normalizeMacro, normalizeLorebookEntry } from '../../libraries/core/guide-create.js';

/**
 * Действия гида «создать по описанию» — трекер, макрос, запись лорбука. Модель присылает их блоком ```proposal```; человек видит на карточке
 * то, что реально запишется (`describeProposal` из той же библиотеки), и создаётся оно только нажатием «Apply». Существующее не перезаписывается:
 * совпадение имени — отказ с объяснением, а не тихая замена. Каждое действие идёт через контракты Ядер, как это делают Модули.
 */
export function createCreateActions({ call, modules }) {
    const failure = message => ({ ok: false, message });
    const moduleHint = (id, title) => (modules?.enabled?.().includes(id) ? '' : ` Turn on the ${title} module to see it.`);

    return {
        'tracker.create': {
            description: 'Create a tracker (an automatic note the model keeps up to date from the chat, e.g. health or location). Params: {"title": "Health", "fields": [{"name": "health", "prompt": "how hurt the hero is, 0-100", "default": 100}], "when": "everyReply" | "everyNReplies" | "onUserMessage" | "beforeSend" | "manual", "every": 3 (only with everyNReplies)}. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeTracker(params);
                if (!made.ok) return failure(made.error);
                const { when, every, ...record } = made.value;
                const listed = await call('tracking.trackers');
                const current = listed.ok ? listed.value ?? [] : [];
                if (current.some(tracker => tracker.id === record.id)) return failure(`A tracker called “${record.id}” already exists — pick another name.`);
                const workers = await call('model.workers.get');
                const saved = await call('tracking.configure', { trackers: [...current, { ...record, workerId: (workers.ok ? workers.value ?? [] : [])[0]?.id ?? '' }] });
                if (!saved.ok) return failure(saved.error.message);
                return { ok: true, message: `Tracker “${record.id}” is created.${moduleHint('module.tracker', 'Tracker')}` };
            },
        },
        'macro.create': {
            description: 'Create a macro usable as {{name}} in prompts. Params: {"name": "weather", "text": "It is raining."} for a fixed text (preferred), or {"name": "hp", "code": "set h to get \\"health:health\\"\\nreturn \\"HP: \\" + h"} for a small program that reads a tracker field ("trackerId:field"). Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeMacro(params);
                if (!made.ok) return failure(made.error);
                const listed = await call('macros.programs');
                const current = listed.ok ? listed.value ?? [] : [];
                if (current.some(program => program.id === made.value.id || program.macroName === made.value.macroName)) return failure(`A macro {{${made.value.macroName}}} already exists — pick another name.`);
                if (made.value.kind === 'code') {
                    const tested = await call('macros.test', { program: made.value });
                    if (!tested.ok || tested.value?.ok === false) return failure(`That program doesn't run: ${tested.ok ? tested.value.error : tested.error.message}`);
                }
                const saved = await call('macros.configure', { programs: [...current, made.value] });
                if (!saved.ok) return failure(saved.error.message);
                return { ok: true, message: `Macro {{${made.value.macroName}}} is created — use it in any prompt.` };
            },
        },
        'lorebook.addEntry': {
            autoApply: true, // добавление ничего не затирает (убрать запись — одним удалением): без кнопки, как правки карточек
            thenContinue: true,
            description: 'Add an entry to a lorebook; it is applied at once. Params: {"title": "Old Mill", "keys": ["mill", "miller"], "content": "The abandoned mill north of town…", "always": false, "book": "optional book name; without it the first book active for this chat or character"}. Several entries at once: lorebook.addEntries. Send it in a ```proposal``` block.',
            async run(params = {}) {
                const made = normalizeLorebookEntry(params);
                if (!made.ok) return failure(made.error);
                const book = typeof params.book === 'string' && params.book.trim() ? params.book.trim() : undefined;
                const books = await call('lorebook.books');
                if (!book && (!books.ok || !(books.value ?? []).length)) return failure('There is no lorebook for this chat or character yet — create one with lorebook.createBook, or name an existing book in "book".');
                const created = await call('lorebook.createEntry', { patch: made.value, ...(book ? { book } : {}) });
                if (!created.ok) return failure(created.error.message);
                return { ok: true, message: `Entry “${made.value.comment}” is added to “${created.value?.book ?? book ?? books.value[0]}”.` };
            },
        },
    };
}
