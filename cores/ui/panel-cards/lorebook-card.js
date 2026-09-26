import { h } from '../tree.js';
import { signal, computed } from '../reactive.js';
import { Button, TextInput, TextArea, NumberInput, Toggle, Field, Row, Card, Section, EditableList } from '../../../libraries/shared/widgets.js';

/** Карточка «Lorebook»: записи активного лорбука ST. */
export function createLorebookCard(deps) {
    const { call, lorebookEntries, lorebookBooks, flash, notify, collapse } = deps;

    /**
     * Интерфейс лорбука («LB scanner», как у Alpha) — тоже часть экрана
     * движка, тем же доводом, что и Macros: чтение реального World Info ST —
     * интеграция уровня движка, не отключаемая фича.
     *
     * В отличие от Workers/Macros/Tracker (локальный черновик списка + ОДНА
     * общая кнопка Save), запись здесь идёт СРАЗУ в настоящий World Info ST:
     * каждое действие (Save строки, +Add, Remove, Publish) — отдельный вызов
     * контракта, а не батч. Так и должно быть — записи лорбука не наша
     * конфигурация, а чужое хранилище, за которым Ядро работы с WI следит
     * само (см. его doc-comment): правка через родной редактор ST так же
     * долетит сюда сама, без ручного Rescan.
     */
    function toLorebookRecord(summary) {
        return {
            key: `lorebook_${summary.book}_${summary.uid}`,
            uid: summary.uid,
            book: summary.book,
            length: summary.length,
            name: signal(summary.name),
            keys: signal(summary.keys.join(', ')),
            content: signal(''),
            disabled: signal(summary.disabled),
            constant: signal(summary.constant),
            order: signal(100),
            probability: signal(100),
            published: signal(false),
            // Полная запись (content и настоящие order/probability) грузится
            // ЛЕНИВО, при первом раскрытии строки — не для всех разом: у
            // лорбука записей может быть много, а content — тяжёлый текст,
            // которого нет даже в самом индексе (`lorebook.find()` его
            // сознательно не отдаёт, см. doc-comment summarizeEntry()).
            loaded: signal(false),
            flash: signal(''),
        };
    }

    async function loadLorebook() {
        const found = await call('lorebook.find');
        const list = (found.ok ? found.value ?? [] : []).map(toLorebookRecord);
        lorebookEntries.set(list);
        const booksResult = await call('lorebook.books');
        lorebookBooks.set(booksResult.ok ? booksResult.value ?? [] : []);
        for (const record of list) {
            call('lorebook.isPublished', { uid: record.uid, book: record.book })
                .then(result => { if (result.ok) record.published.set(result.value); });
        }
    }

    async function loadFullLorebookEntry(record) {
        if (record.loaded.peek()) return;
        const result = await call('lorebook.get', { uid: record.uid, book: record.book });
        if (result.ok && result.value) {
            record.content.set(String(result.value.content ?? ''));
            record.keys.set((result.value.key ?? []).join(', '));
            record.order.set(result.value.order ?? 100);
            record.probability.set(result.value.probability ?? 100);
        }
        record.loaded.set(true);
    }

    async function saveLorebookEntry(record) {
        const patch = {
            comment: record.name.peek().trim(),
            key: record.keys.peek().split(',').map(item => item.trim()).filter(Boolean),
            content: record.content.peek(),
            disable: record.disabled.peek(),
            constant: record.constant.peek(),
            order: record.order.peek(),
            probability: record.probability.peek(),
        };
        const result = await call('lorebook.updateEntry', { uid: record.uid, book: record.book, patch });
        flash(record.flash, result.ok ? 'ok' : 'error');
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Saved "${patch.comment || record.uid}"` : result.error.message);
        // Перечитываем список целиком, а не только эту запись: имя могло
        // поменяться, и заголовок строки/индекс обязаны увидеть это тоже.
        if (result.ok) await loadLorebook();
    }

    async function addLorebookEntry() {
        const result = await call('lorebook.createEntry', { patch: { comment: 'New entry' } });
        if (!result.ok) { await notify('error', result.error.message); return; }
        await loadLorebook();
    }

    async function removeLorebookEntry(record) {
        const result = await call('lorebook.deleteEntry', { uid: record.uid, book: record.book });
        await notify(result.ok ? 'ok' : 'error', result.ok ? `Deleted "${record.name.peek() || record.uid}"` : result.error.message);
        if (result.ok) await loadLorebook();
    }

    async function toggleLorebookPublish(record, checked) {
        record.published.set(checked);
        const result = await call(checked ? 'lorebook.publish' : 'lorebook.unpublish', { uid: record.uid, book: record.book });
        if (!result.ok) { record.published.set(!checked); await notify('error', result.error.message); }
    }

    function lorebookRow(record) {
        const bind = collapse.bind(`lorebook:${record.key}`);
        return Section(computed(() => record.name() || `#${record.uid}`), {
            key: record.key,
            className: computed(() => (record.flash() ? `stme-flash stme-flash-${record.flash()}` : '')),
            ...bind,
            // Раскрытие строки — сигнал первого открытия: грузим полную
            // запись именно СЕЙЧАС, не раньше (см. doc-comment `loaded` в
            // toLorebookRecord()).
            onToggle: next => { bind.onToggle(next); if (next) loadFullLorebookEntry(record); },
            subtitle: `${record.book}${record.length ? ` · ${record.length} chars` : ''}`,
            actions: [
                Toggle('Publish', record.published, {
                    hint: 'Expose as a {{macro}}.',
                    onChange: checked => toggleLorebookPublish(record, checked),
                }),
                Button('Save', () => saveLorebookEntry(record)),
                Button('Remove', () => removeLorebookEntry(record), { variant: 'danger' }),
            ],
        },
            Row(
                Field('Name', TextInput(record.name, { placeholder: 'What is this entry for?' })),
                Field('Keys', TextInput(record.keys, { placeholder: 'comma, separated, keys' })),
            ),
            Row(
                Toggle('Disabled in WI', record.disabled, { hint: 'Matches ST\'s own "Disable" checkbox — a disabled entry never activates, published or not.' }),
                Toggle('Constant', record.constant, { hint: 'Always active, regardless of keys — matches ST\'s own "Constant" toggle.' }),
            ),
            Row(
                Field('Order', NumberInput(record.order, { min: 0 })),
                Field('Probability', NumberInput(record.probability, { min: 0, max: 100 })),
            ),
            Field('Content', TextArea(record.content, { rows: 4, placeholder: 'Entry content…' })),
        );
    }

    function lorebookCard() {
        return Card('Lorebook', {
            ...collapse.bind('card:lorebook'),
            subtitle: computed(() => (lorebookBooks().length ? `Active: ${lorebookBooks().join(', ')}` : 'No lorebook active for this chat/character yet')),
        },
            h('p', { class: 'stme-lorebook-help' }, 'Every entry in your currently active lorebook(s) — global, character, chat, and persona. Create, edit, and delete right here, or in ST\'s own World Info panel — both stay in sync automatically, no manual Rescan needed. Toggle Publish to expose an entry\'s full content as a real {{macro}}, usable in prompts, World Info, or any module — the same way Tracker/RP Time publish their own values.'),
            EditableList({
                items: lorebookEntries,
                renderItem: lorebookRow,
                onAdd: addLorebookEntry,
                addLabel: '+ Add entry',
                empty: 'No entries in the active lorebook(s) yet — add one here, or activate a book in ST\'s own World Info panel.',
                actions: [Button('Rescan', loadLorebook)],
            }),
        );
    }

    return { loadLorebook, lorebookCard };
}
