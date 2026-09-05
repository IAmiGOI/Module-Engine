import { h } from '../../cores/ui/tree.js';
import { computed } from '../../cores/ui/reactive.js';

/**
 * Готовые виджеты — ровно тот слой, который ARCHITECTURE.md закладывала с
 * самого начала: «Ядро UI (примитивы — реактивность, диффинг) внизу, а
 * Библиотека — готовые виджеты поверх, доступна и модулям, и ядрам».
 *
 * Всё здесь — чистые функции, возвращающие дерево `h()`. Ни DOM, ни шины:
 * дерево применит Ядро финального UI через Гейт. Поэтому виджеты
 * тестируются как данные, без браузера.
 *
 * Набор намеренно МАЛЕНЬКИЙ. Виджет добавляется, когда он реально нужен
 * второй раз, а не «на будущее» — иначе библиотека виджетов превращается в
 * собственный фреймворк, который никто не просил.
 *
 * Поля связаны с сигналом в обе стороны: сигнал → `value` (diff.js резолвит
 * сигналы в пропсах), ввод → `signal.set()`. Каретка при этом не прыгает —
 * см. защиту от лишней записи в services/dom.js.
 */

export function Button(label, onClick, { variant = 'default', disabled = false } = {}) {
    return h('button', {
        type: 'button',
        class: variant === 'danger' ? 'menu_button stme-danger' : 'menu_button',
        disabled,
        'on:click': onClick,
    }, label);
}

export function TextInput(valueSignal, { placeholder = '', type = 'text', onInput } = {}) {
    return h('input', {
        class: 'text_pole',
        type,
        placeholder,
        value: valueSignal,
        'on:input': event => {
            valueSignal.set(event.target.value);
            // `onInput` — для случая, когда правка обязана дойти ещё куда-то
            // (запись в общий список, например). Без него такому вызывающему
            // пришлось бы держать значение в том же сигнале, что и структуру
            // списка, и перерисовывать список на каждую букву.
            onInput?.(event.target.value);
        },
    });
}

export function TextArea(valueSignal, { placeholder = '', rows = 3 } = {}) {
    return h('textarea', {
        class: 'text_pole',
        rows,
        placeholder,
        value: valueSignal,
        'on:input': event => valueSignal.set(event.target.value),
    });
}

/** Число — отдельным виджетом, а не `TextInput type="number"`: сигнал должен получать ЧИСЛО, иначе `every: "5"` уедет в Директора строкой. */
export function NumberInput(valueSignal, { min, max, step = 1 } = {}) {
    return h('input', {
        class: 'text_pole stme-number',
        type: 'number',
        min,
        max,
        step,
        value: valueSignal,
        'on:input': event => valueSignal.set(event.target.value === '' ? null : Number(event.target.value)),
    });
}

/**
 * Ползунок с живым числом справа от подписи — форма из Alpha (`SliderField`).
 * Для «каждый N-й ответ» он честно лучше поля ввода: диапазон видно целиком,
 * промахнуться мимо допустимых значений нельзя, и подкрутить можно не целясь
 * в цифру. Числовое поле остаётся для случаев без внятных границ.
 *
 * Сигнал остаётся ЧИСЛОВЫМ: `<input type=range>` отдаёт строку, и без явного
 * `Number()` в условие Директора уехало бы `every: "5"`.
 */
export function Slider(label, valueSignal, { min = 0, max = 100, step = 1 } = {}) {
    return h('label', { class: 'stme-slider' },
        h('span', { class: 'stme-slider-head' },
            h('span', {}, label),
            h('output', {}, valueSignal),
        ),
        h('input', {
            type: 'range',
            min,
            max,
            step,
            value: valueSignal,
            'on:input': event => valueSignal.set(Number(event.target.value)),
        }),
    );
}

/**
 * Настоящий тумблер, а не голая галочка — форма из Alpha (`.stme-switch`):
 * сам `<input>` уводится с глаз, видимую дорожку с бегунком рисует
 * `.stme-switch-track`. Разметка именно такая, потому что стиль опирается на
 * соседний селектор `input:checked + .stme-switch-track` — состояние берётся
 * из настоящего чекбокса, а не дублируется классом, так что клавиатура и
 * фокус работают сами.
 */
export function Toggle(label, checkedSignal, { hint, onChange } = {}) {
    return h('label', { class: 'stme-switch' },
        h('input', {
            type: 'checkbox',
            checked: checkedSignal,
            'on:change': event => {
                checkedSignal.set(event.target.checked);
                onChange?.(event.target.checked);
            },
        }),
        h('span', { class: 'stme-switch-track' }),
        h('span', { class: 'stme-switch-label' }, label, hint ? h('small', {}, hint) : null),
    );
}

/**
 * Одна всплывающая плашка. Живёт не в потоке страницы, а в плавающем стеке
 * (`FloatingStack`), поэтому длинный текст не растягивает ничего вокруг —
 * ровно та беда, из-за которой она и появилась: результат проверки
 * подключения раньше был плашкой во всю ширину карточки.
 */
export function Toast(text, { tone = 'muted', onDismiss, key } = {}) {
    return h('div', { class: `stme-toast stme-toast-${tone}`, key },
        h('span', { class: 'stme-toast-text' }, text),
        onDismiss ? h('button', { type: 'button', class: 'stme-toast-close', title: 'Dismiss', 'on:click': onDismiss }, '×') : null,
    );
}

/**
 * Плавающий стек плашек в углу ЭКРАНА. Сам ничего не знает про их появление и
 * исчезновение — только рисует то, что сейчас в сигнале; жизненный цикл ведёт
 * [Ядро уведомлений](../../cores/ui/notifications.js).
 */
export function FloatingStack(itemsSignal, { corner = 'top-left', renderItem } = {}) {
    return h('div', { class: `stme-floating stme-floating-${corner}` },
        computed(() => itemsSignal().map(renderItem ?? (item => Toast(item.text, { tone: item.tone, key: item.id })))),
    );
}

/**
 * Плавающая панель — как в Alpha's Tracker HUD: висит поверх страницы в углу
 * ЭКРАНА, показывает живое состояние и ни от чего в разметке не зависит.
 *
 * Отличается от `FloatingStack` назначением: стек — поток временных
 * сообщений, панель — ПОСТОЯННОЕ окно с содержимым. Общее у них только то,
 * что оба плавают.
 */
export function FloatingPanel(title, { position, size, collapsed, onToggle, onClose, onResize, drag } = {}, ...children) {
    // Ключ попадает в стиль ТОЛЬКО когда значение есть. Пустая строка здесь
    // означала бы «сбросить», а размер окну задаёт сам браузер через
    // `resize: both` — записав width: '' на любой перерисовке, мы отменяли бы
    // то, что пользователь только что растянул руками.
    const style = computed(() => {
        const { left, top } = (typeof position === 'function' ? position() : position) ?? {};
        const { width, height } = (typeof size === 'function' ? size() : size) ?? {};
        const next = {};
        if (left !== undefined) next.left = `${left}px`;
        if (top !== undefined) next.top = `${top}px`;
        if (width) next.width = `${width}px`;
        if (height) next.height = `${height}px`;
        return next;
    });

    return h('div', {
        class: 'stme-floating-panel',
        style,
        // Растягивание заканчивается отпусканием указателя над самим окном.
        // Читаем размер у события — тот же приём, что и с координатами при
        // перетаскивании, никакого поиска узлов.
        'on:pointerup': onResize
            ? event => {
                const box = event.currentTarget?.getBoundingClientRect?.();
                if (box) onResize({ width: Math.round(box.width), height: Math.round(box.height) });
            }
            : undefined,
    },
        // Ручка перетаскивания — вся шапка. Обработчики приходят готовым
        // набором из libraries/shared/draggable.js, здесь о них ничего не
        // знают, кроме того, что их надо разложить на элемент.
        h('div', { class: 'stme-floating-panel-head', ...(drag ?? {}) },
            h('span', { class: 'stme-floating-panel-grip', title: 'Drag to move' }, '⠿'),
            h('strong', {}, title),
            onToggle
                ? h('button', {
                    type: 'button',
                    class: 'stme-floating-panel-btn',
                    title: computed(() => (collapsed?.() ? 'Expand' : 'Collapse')),
                    'on:click': () => onToggle(!collapsed?.()),
                }, computed(() => (collapsed?.() ? '+' : '–')))
                : null,
            onClose ? h('button', { type: 'button', class: 'stme-floating-panel-btn', title: 'Hide', 'on:click': onClose }, '×') : null,
        ),
        h('div', { class: 'stme-floating-panel-body', hidden: collapsed ?? false }, children),
    );
}

/**
 * Одно именованное значение — форма бейджа Alpha: кружок с иконкой, подпись
 * капителью и КРУПНОЕ значение под ней. Ровно то, чего не хватало первой
 * версии полосы под сообщением: подпись и значение одного кегля, слипшиеся в
 * строку, читаются как случайный текст, а не как показание.
 *
 * **Пока значения нет — не показывается НИЧЕГО, а рамка пульсирует.** Так
 * видно, что показание ещё готовится, и при этом на экран не лезет ни
 * «(not established yet)», ни прочерк, ни прошлое значение, выдающее себя за
 * свежее.
 */
export function StatBlock(label, valueSignal, { icon = '◷' } = {}) {
    const read = () => (typeof valueSignal === 'function' ? valueSignal() : valueSignal);
    const pending = computed(() => !String(read() ?? '').trim());
    return h('div', {
        class: computed(() => `stme-stat${pending() ? ' stme-stat-pending' : ''}`),
        title: computed(() => (pending() ? 'Waiting for the first update…' : '')),
    },
        h('div', { class: 'stme-stat-head' },
            h('span', { class: 'stme-stat-icon' }, icon),
            h('span', { class: 'stme-stat-label' }, label),
        ),
        h('div', { class: 'stme-stat-value' }, computed(() => (pending() ? '' : read()))),
    );
}

/** Маленькая кликабельная метка. У Alpha ими вставлялись токены полей в шаблон — приём хороший, поэтому переехал в общую библиотеку, а не остался внутри одного модуля. */
export function Chip(label, { title, onClick } = {}) {
    return h('button', {
        type: 'button',
        class: 'stme-chip',
        title,
        'on:click': onClick,
    }, label);
}

/** Свёрнутая по умолчанию секция для продвинутого — чтобы редкое не занимало место у частого. */
export function Details(summary, ...children) {
    return h('details', { class: 'stme-details' }, h('summary', {}, summary), ...children);
}

/** `options` — массив `{ value, label }` или сигнал на него. */
export function Select(valueSignal, options) {
    const read = typeof options === 'function' ? options : () => options;
    return h('select', {
        class: 'text_pole',
        'on:change': event => valueSignal.set(event.target.value),
    }, computed(() => read().map(option => h('option', {
        key: option.value,
        value: option.value,
        // Выбор отмечается на самом <option>, а не записью в select.value:
        // пропсы элемента ставятся ДО того, как к нему добавлены дети, так
        // что select.value в этот момент ещё некуда применить.
        selected: computed(() => valueSignal() === option.value),
    }, option.label ?? option.value))));
}

export function Field(label, control, { hint } = {}) {
    return h('label', { class: 'stme-field' },
        h('span', { class: 'stme-field-label' }, label, hint ? h('small', {}, hint) : null),
        control,
    );
}

export function Row(...children) {
    return h('div', { class: 'stme-row' }, children);
}

/**
 * Общая начинка Card и Section. Сворачиваемость — на `<details>`/`<summary>`,
 * как в Alpha, а не на своём флаге с ручным скрытием: браузер уже умеет и
 * состояние, и клавиатуру, и доступность, а разметка остаётся честной.
 *
 * Кнопки в шапке живут ВНУТРИ `<summary>`, поэтому их клик приходится
 * останавливать: иначе нажатие «Remove» заодно сворачивало бы карточку —
 * `<summary>` переключается от любого клика по себе.
 */
function collapsible({ root, head, body }, title, { subtitle, actions, key, open = false, onToggle, className } = {}, children) {
    return h('details', {
        // `className` может быть сигналом: им помечается ВРЕМЕННОЕ состояние
        // (например, вспышка обводки после удачной проверки), и оно обязано
        // сниматься само, не перестраивая дерево.
        class: className ? computed(() => `${root} ${typeof className === 'function' ? className() : className}`.trim()) : root,
        key,
        // `open` — можно и голым булевым, и сигналом: сигнал даёт память о
        // состоянии (см. libraries/shared/collapse-state.js). По умолчанию
        // СВЁРНУТО: экран целиком на страницу не помещается, и раскрытым
        // должно быть то, что пользователь раскрыл сам.
        open,
        'on:toggle': onToggle ? event => onToggle(event.target.open) : undefined,
    },
        h('summary', { class: head },
            h('div', { class: 'stme-card-title' },
                h('strong', {}, title),
                subtitle ? h('small', {}, subtitle) : null,
            ),
            actions ? h('div', { class: 'stme-card-actions', 'on:click': event => event.stopPropagation() }, actions) : null,
        ),
        h('div', { class: body }, children),
    );
}

/**
 * ПЛОСКАЯ сворачиваемая секция — то же, что Card, но без рамки, фона и тени.
 *
 * Существует затем, что рамка внутри рамки внутри рамки читается отвратительно:
 * «Модули» → «Трекер» → «Трекер» → «status» — четыре вложенных обрамления, и
 * взгляду не за что зацепиться. Рамку рисует ТОЛЬКО верхний уровень (Card), а
 * вложенность внутри него видна по фону (шкала глубины в panel.css).
 */
export function Section(title, options = {}, ...children) {
    return collapsible({ root: 'stme-section', head: 'stme-section-head', body: 'stme-section-body' }, title, options, children);
}

/** Обрамлённая карточка — ТОЛЬКО верхний уровень. Внутри неё вкладывается Section, а не другая Card. */
export function Card(title, options = {}, ...children) {
    return collapsible({ root: 'stme-card', head: 'stme-card-head', body: 'stme-card-body' }, title, options, children);
}

/** `tone`: 'ok' | 'error' | 'muted' — цвет берётся из CSS, не отсюда. */
export function Badge(text, { tone = 'muted' } = {}) {
    return h('span', { class: `stme-badge stme-badge-${tone}` }, text);
}

export function EmptyState(text) {
    return h('p', { class: 'stme-empty' }, text);
}

/** Ключёванный список: `renderItem` обязан проставить `key` — по нему diff.js и опознаёт элементы при перестановке. */
export function List(itemsSignal, renderItem) {
    return computed(() => itemsSignal().map(renderItem));
}

/**
 * Две колонки, схлопывающиеся в одну на узком месте (см. CSS). Разделение
 * «слева своё, справа подключаемое» — не частный случай одной панели, а
 * форма, которая понадобится любому экрану с тем же делением.
 */
export function TwoColumn({ left, right }) {
    return h('div', { class: 'stme-two-column' },
        h('div', { class: 'stme-column' }, left),
        h('div', { class: 'stme-column' }, right),
    );
}

/**
 * Список записей, который можно править: строки + кнопка «добавить» + текст
 * для пустого случая. Сам НЕ знает, что за записи внутри — `renderItem`
 * рисует строку, `onAdd` добавляет. Ровно тот повторяющийся кусок, который
 * нужен и менеджеру моделей, и трекерам, и макросам, и любому модулю со
 * списком чего угодно.
 */
export function EditableList({ items, renderItem, onAdd, addLabel = '+ Add', empty = 'Nothing here yet.', actions }) {
    return h('div', { class: 'stme-editable-list' },
        computed(() => (items().length ? items().map(renderItem) : [EmptyState(empty)])),
        // «Добавить» и «Сохранить» — ОДНА строка под списком, а не две подряд.
        // Обе кнопки относятся к списку целиком, и разносить их по разным
        // строкам значило бы намекать, что они про разное.
        onAdd || actions ? h('div', { class: 'stme-list-actions' }, onAdd ? Button(addLabel, onAdd) : null, actions ?? null) : null,
    );
}
