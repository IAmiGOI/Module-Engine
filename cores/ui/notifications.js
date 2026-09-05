import { signal } from './reactive.js';
import { FloatingStack, Toast } from '../../libraries/shared/widgets.js';

/**
 * Ядро уведомлений — одна общая плавающая полоса сообщений в углу ЭКРАНА.
 *
 * **Почему отдельное Ядро, а не слот в Ядре UI для Engine.** Слот — это просто
 * место, куда кто-то другой кладёт своё дерево. Здесь же есть собственная
 * логика: очередь, ограничение длины, автоснятие по времени, схлопывание
 * повторов. Как только у поверхности появляется жизненный цикл, она перестаёт
 * быть слотом. По критерию Ядро/Модуль это именно Ядро: пользователь его не
 * подключает, и без него движку нечем сообщить об ошибке.
 *
 * **Почему вообще появилось.** Результаты («OK · 3117ms», «Saved 1
 * connection») жили плашками прямо в карточке и растягивались во всю её
 * ширину — длинная строка ломала вёрстку блока, к которому относилась. У
 * сообщения нет причины занимать место в разметке: оно временное. Плавающий
 * стек снимает эту связь совсем.
 *
 * Сообщение — это ДАННЫЕ (`{ tone, text }`), а рисование — виджеты
 * `Toast`/`FloatingStack` из общей Библиотеки. Никакого DOM здесь нет.
 */

const DEFAULT_TIMEOUT_MS = 4500;
/** Больше нескольких штук на экране — уже не уведомление, а лента; старые вытесняются. */
const MAX_VISIBLE = 4;

export function createNotificationsCore(host, { mount, timeoutMs = DEFAULT_TIMEOUT_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
    const items = signal([]);
    const timers = new Map(); // id -> timer
    let counter = 0;

    function dismiss(id) {
        const timer = timers.get(id);
        if (timer !== undefined) { cancel(timer); timers.delete(id); }
        items.set(items.peek().filter(item => item.id !== id));
        return true;
    }

    /**
     * `tone`: 'ok' | 'error' | 'muted'. Повтор того же текста подряд не
     * плодит вторую плашку, а продлевает первую — иначе «Save» пять раз
     * подряд забивает угол пятью одинаковыми строками.
     */
    function notify({ tone = 'muted', text, timeoutMs: ownTimeout } = {}) {
        const message = String(text ?? '').trim();
        if (!message) throw new Error('ui.notify: "text" is required.');

        const existing = items.peek().find(item => item.text === message && item.tone === tone);
        if (existing) {
            cancel(timers.get(existing.id));
            timers.set(existing.id, schedule(() => dismiss(existing.id), ownTimeout ?? timeoutMs));
            return existing.id;
        }

        counter += 1;
        const id = `note_${counter}`;
        const next = [...items.peek(), { id, tone, text: message }];
        // Вытесняем самые старые, а не самые новые: свежее сообщение почти
        // всегда и есть то, ради чего пользователь сюда смотрит.
        for (const dropped of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) dismiss(dropped.id);
        items.set(next.slice(-MAX_VISIBLE));
        timers.set(id, schedule(() => dismiss(id), ownTimeout ?? timeoutMs));
        return id;
    }

    function tree() {
        return FloatingStack(items, {
            corner: 'top-left',
            renderItem: item => Toast(item.text, { tone: item.tone, key: item.id, onDismiss: () => dismiss(item.id) }),
        });
    }

    const unregisters = [
        host.own.register('ui.notify', params => notify(params)),
        host.own.register('ui.notify.dismiss', params => dismiss(params?.id)),
    ];

    return {
        notify,
        dismiss,
        items: () => items.peek().map(item => ({ ...item })),
        tree,
        open: () => mount(tree()),
        unregister: () => {
            for (const timer of timers.values()) cancel(timer);
            timers.clear();
            for (const unregister of unregisters) unregister();
        },
    };
}
