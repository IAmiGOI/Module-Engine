import { normalizeLorebookEntry } from '../../libraries/core/guide-create.js';
import { renderBookPage, countByBook, describeOutline, BOOK_PAGE_MAX_CHARS } from '../../libraries/core/lorebook-page.js';

/**
 * Краулер гида по лорбукам (World Info): книга может быть огромной, поэтому её не кладут в контекст, а «открывают» страницей в бэкенде (Сервис `stWebSearch.openText`):
 * каждая запись — раздел `## #uid Название [ключи]`, дальше её читают теми же `web.page` / `web.find`, что и веб-страницы (поиск и по словам, и по смыслу). Безопасное действие:
 * ничего не меняет, поэтому идёт без кнопки и даёт ей следующий ход. Править записи она потом может по номеру `#uid` из заголовка (`lorebook.updateEntry` и другие).
 */
/** Книга короче этого приходит в ответ целиком. */
const SMALL_BOOK_CHARS = 3000;
/** Сколько записей можно записать одним блоком (больше — следующим блоком). */
const MAX_BATCH = 20;

export function createLorebookActions({ call, callService }) {
    const failure = message => ({ ok: false, message });
    const reason = text => String(text ?? '').replace(/[.\s]+$/, '');
    const knownBooks = async () => {
        const state = await callService('stLorebook.rawState');
        return [...new Set([...(state.ok ? state.value?.allNames ?? [] : [])])];
    };

    return {
        'lorebook.open': {
            safe: true,
            thenContinue: true,
            description: 'Open a lorebook (World Info) in the engine memory WITHOUT pulling it into the chat — books can be huge. Params: {"book": "<book name>"} (without it: the books active now are listed, or the only one is opened). The book becomes a page where every entry is a section "## #uid Title [keys]". Then read it with web.page {"id": "p3", "section": 4 or part of the title} and look for things with web.find {"id": "p3", "query": "…"} (by the words AND by the meaning). To change an entry afterwards use its #uid with lorebook.updateEntry / lorebook.deleteEntry.',
            async run(params = {}) {
                const wanted = String(params.book ?? params.name ?? params.title ?? '').trim();
                let name = wanted;
                let entries;
                if (wanted) {
                    const loaded = await callService('stLorebook.load', { name: wanted });
                    if (!loaded.ok || !loaded.value || typeof loaded.value.entries !== 'object') {
                        const names = await knownBooks();
                        return failure(`There is no lorebook named “${wanted}”.${names.length ? ` Books that exist: ${names.slice(0, 60).join(', ')}.` : ''}`);
                    }
                    entries = Object.values(loaded.value.entries);
                } else {
                    await call('lorebook.scan');
                    const all = await call('lorebook.entries');
                    const active = all.ok ? all.value ?? [] : [];
                    const counts = countByBook(active);
                    if (!counts.length) {
                        const names = await knownBooks();
                        return { ok: true, message: 'No lorebook is active right now.', detail: `No lorebook is attached to this chat or character.${names.length ? ` Books that exist: ${names.slice(0, 60).join(', ')}. Open one with {"book": "<name>"}.` : ' There are no books at all yet.'}` };
                    }
                    if (counts.length > 1) {
                        const list = counts.map(item => `“${item.book}” (${item.count} entries)`).join('; ');
                        return { ok: true, message: `${counts.length} lorebooks are active.`, detail: `Active books: ${list}. Open one with {"book": "<name>"}.` };
                    }
                    name = counts[0].book;
                    entries = active.filter(entry => entry.book === name);
                }
                const opened = await callService('stWebSearch.openText', { url: `lorebook:${name}`, text: renderBookPage(name, entries), maxChars: BOOK_PAGE_MAX_CHARS });
                if (!opened.ok) return failure(`The book did not open: ${opened.error.message}`);
                const page = opened.value;
                if (page.chars <= SMALL_BOOK_CHARS) {
                    const whole = await callService('stWebSearch.view', { id: page.id, offset: 0, chars: SMALL_BOOK_CHARS });
                    if (whole.ok) return { ok: true, message: `Opened lorebook “${name}” (${entries.length} entries, short).`, detail: `Book ${page.id} — “${name}” (${page.chars} characters, whole):\n${whole.value.text}` };
                }
                return {
                    ok: true,
                    message: `Opened lorebook “${name}”: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${page.chars} characters.`,
                    detail: `Book ${page.id} — “${name}” (${entries.length} entries, ${page.chars} characters). Only the list is here; read an entry with web.page {"id": "${page.id}", "section": N} and look for things with web.find {"id": "${page.id}", "query": "…"}.\nEntries (number. #uid title [keys]):\n${describeOutline(page.outline.filter(item => item.title !== 'Beginning'))}`,
                };
            },
        },
        'lorebook.createBook': {
            autoApply: true, // новая пустая книга ничего не затирает: без кнопки, как и добавление записей
            thenContinue: true,
            description: 'Create a new empty lorebook; it is applied at once. Params: {"name": "Mushoku Tensei", "avatar": "<optional: a character file — the book is attached to that character, so it works in every chat with them>"}. Then fill it with lorebook.addEntries {"book": "<the same name>", …}. An existing name is refused.',
            async run(params = {}) {
                const name = String(params.name ?? params.book ?? params.title ?? '').trim();
                if (!name) return failure('What should the lorebook be called? Send {"name": "…"}.');
                const created = await callService('stLorebook.create', { name });
                if (!created.ok) return failure(created.error.message);
                let attached = '';
                const avatar = String(params.avatar ?? '').trim();
                if (avatar) {
                    const linked = await call('characterCard.update', { avatar, fields: { world: created.value.name }, negationsOk: true });
                    attached = linked.ok ? ` and attached to ${avatar}` : ` (it could not be attached to ${avatar}: ${linked.error.message})`;
                }
                await call('lorebook.scan');
                return { ok: true, message: `Lorebook “${created.value.name}” is created${attached}.` };
            },
        },
        'lorebook.addEntries': {
            autoApply: true,
            thenContinue: true,
            description: `Add several entries to a lorebook in one go (up to ${MAX_BATCH}); applied at once. Params: {"book": "<name, optional: the first active book>", "entries": [{"title": "Old Mill", "keys": ["mill"], "content": "…", "always": false}, …]}. Entries that fail are listed in the result; the rest are written.`,
            async run(params = {}) {
                const list = Array.isArray(params.entries) ? params.entries.slice(0, MAX_BATCH) : [];
                if (!list.length) return failure('Send {"book": "…", "entries": [{"title": "…", "keys": ["…"], "content": "…"}]}.');
                const book = typeof params.book === 'string' && params.book.trim() ? params.book.trim() : undefined;
                if (!book) {
                    const books = await call('lorebook.books');
                    if (!books.ok || !(books.value ?? []).length) return failure('There is no active lorebook: create one with lorebook.createBook, or name an existing book in "book".');
                }
                const written = [];
                const failed = [];
                for (const item of list) {
                    const made = normalizeLorebookEntry(item ?? {});
                    if (!made.ok) { failed.push(`“${item?.title ?? '?'}”: ${reason(made.error)}`); continue; }
                    const created = await call('lorebook.createEntry', { patch: made.value, ...(book ? { book } : {}) });
                    if (created.ok) written.push(`#${created.value?.uid} ${made.value.comment}`);
                    else failed.push(`“${made.value.comment}”: ${reason(created.error.message)}`);
                }
                const where = book ? `“${book}”` : 'the active lorebook';
                const message = `${written.length} of ${list.length} entr${list.length === 1 ? 'y' : 'ies'} written to ${where}.${failed.length ? ` ${failed.length} not written.` : ''}`;
                return { ok: written.length > 0, message, detail: `${message}\n${written.length ? `Written: ${written.join('; ')}.` : ''}${failed.length ? `\nNot written: ${failed.join('; ')}.` : ''}`.trim() };
            },
        },
    };
}
