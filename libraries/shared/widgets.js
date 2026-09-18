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
 * Выбор цвета — нативный `<input type="color">` (родной пикер браузера/ОС,
 * без своей палитры и без стороннего кода) плюс текстовое поле рядом с тем
 * же hex-значением: пикер удобен мышью, поле — когда цвет нужно ввести/
 * скопировать точно (например из сохранённого пресета). Оба читают/пишут
 * ОДИН сигнал, как `TextInput`/`NumberInput` — виджет не решает, что
 * произойдёт с записанным значением (сохранить, применить сразу), это
 * решение потребителя.
 *
 * `<input type="color">` отдаёт и принимает только полный 6-значный hex
 * (`#rrggbb`) — `resolveColorValue()` защищает виджет от пустого/`null`/
 * трёхзначного сигнала (например ещё не назначенный цвет говорящего),
 * подставляя нейтральный дефолт, а не давая браузеру молча откатиться на
 * произвольное собственное значение.
 */
function resolveColorValue(raw) {
    return typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : '#888888';
}

export function ColorPicker(valueSignal, { onChange } = {}) {
    return h('span', { class: 'stme-color-picker' },
        h('input', {
            type: 'color',
            class: 'stme-color-swatch',
            value: computed(() => resolveColorValue(valueSignal())),
            'on:input': event => { valueSignal.set(event.target.value); onChange?.(event.target.value); },
        }),
        h('input', {
            type: 'text',
            class: 'text_pole stme-color-hex',
            value: valueSignal,
            placeholder: '#rrggbb',
            'on:input': event => { valueSignal.set(event.target.value); onChange?.(event.target.value); },
        }),
    );
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
export function FloatingPanel(title, {
    position, size, collapsed, onToggle, onClose, onResize, resizable = Boolean(onResize), drag,
    // `className` (extra CSS class, e.g. a fullscreen-default variant) and
    // `minWidth`/`minHeight` (px, ALWAYS enforced — unlike width/height,
    // which stay unset until the user actually resizes) added for the map
    // module's window (ROADMAP.md 5.43): a window that opens near-fullscreen
    // but must not be shrunk below a usable size.
    className, minWidth, minHeight,
} = {}, ...children) {
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
        if (minWidth) next.minWidth = `${minWidth}px`;
        if (minHeight) next.minHeight = `${minHeight}px`;
        // Неизменяемое окно: CSS `resize: both` из panel.css бьётся инлайном
        // `resize: none` (инлайн специфичнее любого правила таблицы).
        if (!resizable) next.resize = 'none';
        return next;
    });

    return h('div', {
        class: className ? `stme-floating-panel ${className}` : 'stme-floating-panel',
        style,
        // Растягивание заканчивается отпусканием указателя над самим окном.
        // Читаем размер у события — тот же приём, что и с координатами при
        // перетаскивании, никакого поиска узлов. У неизменяемого окна
        // обработчика нет вовсе — не только ручка скрыта, но и размер
        // не персистится.
        //
        // ПОКА СВЁРНУТО — размер НЕ пишется (поймано на живом окне «Картинка»,
        // жалоба: «окна не запоминают размер до сворачивания, после
        // разворачивания не разворачиваются обратно»). Механика бага:
        // pointerup срабатывает РАНЬШЕ click, а state свёрнутости меняет
        // click-обработчик кнопки «+» — значит, в момент pointerup при
        // разворачивании окно ещё свёрнуто, и CSS-правило
        // `.stme-floating-panel:has(> .stme-floating-panel-body[hidden])
        // { height: auto !important }` сжало его до высоты шапки. Без этой
        // проверки getBoundingClientRect() возвращал ~44px шапки, onResize
        // сохранял её как новый размер, и развёрнутое окно оставалось
        // высотой в шапку («разблокировалось, но не развернулось»), а
        // запомненный до сворачивания размер был затёрт.
        'on:pointerup': onResize && resizable
            ? event => {
                if (collapsed?.()) return;
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
export function StatBlock(label, valueSignal, { icon = '◷', onClick, title, showLabel = true, showValue = true } = {}) {
    const read = () => (typeof valueSignal === 'function' ? valueSignal() : valueSignal);
    // Без строки значения нет и «ожидания»: pending-пульс — состояние показания,
    // а не пустого места (кликабельная пилюля значение не показывает вовсе).
    const pending = showValue ? computed(() => !String(read() ?? '').trim()) : null;
    const parts = [
        h('div', { class: 'stme-stat-head' },
            h('span', { class: 'stme-stat-icon' }, icon),
            showLabel ? h('span', { class: 'stme-stat-label' }, label) : null,
        ),
        // Скрытое значение — не «ничего»: невидимый `&nbsp;` держит высоту строки,
        // поэтому компактные варианты остаются в высоту обычного StatBlock'а.
        showValue
            ? h('div', { class: 'stme-stat-value' }, computed(() => (pending() ? '' : read())))
            : h('div', { class: 'stme-stat-value stme-stat-value-ghost' }, '\u00a0'),
    ];
    return h(onClick ? 'button' : 'div', {
        class: computed(() => `stme-stat${pending?.() ? ' stme-stat-pending' : ''}`),
        title: title ?? (pending ? computed(() => (pending() ? 'Waiting for the first update…' : '')) : undefined),
        ...(onClick ? { type: 'button', 'on:click': onClick } : {}),
    }, parts);
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
export function Select(valueSignal, options, { onChange } = {}) {
    const read = typeof options === 'function' ? options : () => options;
    return h('select', {
        class: 'text_pole',
        // `onChange` — для случаев вроде «выбор пресета» (RP Time's своё
        // `applyPreset()`, теперь и у сэмплера воркера): выбор обязан не
        // только запомниться сам, но и заполнить СОСЕДНИЕ поля — то же
        // разделение, что `onChange` у `Toggle()` уже даёт переключателю.
        'on:change': event => { valueSignal.set(event.target.value); onChange?.(event.target.value); },
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
    // `hint` — обычно голая строка (подсказка не меняется, пока карта не
    // перерисуется заново), но иногда обязана следить за чужим состоянием
    // (подсказка пресета сэмплера — за тем, какой пресет выбран СЕЙЧАС), а
    // сама карта строки при этом не перерисовывается: `EditableList` зовёт
    // `renderItem` заново только когда меняется САМ массив, а не поле внутри
    // одной записи. Сигнальная ветка живёт отдельно от строковой, а не
    // единым `computed()` на оба случая: `computed()`, куда положили голую
    // строку, всё равно остаётся ФУНКЦИЕЙ — то есть истинным для `h()`'а
    // фильтра «выбросить null/undefined/false» даже когда подсказки нет, и
    // старый тест «без подсказки — совсем без узла» перестал бы проходить.
    const hintNode = typeof hint === 'function'
        ? computed(() => (hint() ? h('small', {}, hint()) : null))
        : (hint ? h('small', {}, hint) : null);
    return h('label', { class: 'stme-field' },
        h('span', { class: 'stme-field-label' }, label, hintNode),
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

/**
 * Полоса прогресса — процент зажимается в [0,100] и округляется здесь, а не
 * у каждого вызывающего по отдельности (найдено по факту: первый
 * потребитель считал `Math.min(100, Math.round(...))` сам, второй грозил
 * повторить ту же арифметику один в один — LIBRARIES.md, второй реальный
 * потребитель одного и того же паттерна). `label` — уже готовый
 * человекочитаемый текст ("Building… 42%"), эта функция сама ничего не
 * форматирует и не знает о процентах в тексте — вызывающий решает
 * формулировку, здесь только геометрия полосы.
 */
export function ProgressBar(percent, label) {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    return h('div', { class: 'stme-progress' },
        h('div', { class: 'stme-progress-track' }, h('div', { class: 'stme-progress-fill', style: { width: `${clamped}%` } })),
        label ? h('small', { class: 'stme-progress-label' }, label) : null,
    );
}

/**
 * Кнопка, которую нужно ДЕРЖАТЬ, чтобы она сработала — визуальная замена
 * `window.confirm()` для необратимых действий (прямой запрос пользователя:
 * "кнопку, которую нужно держать, с анимацией заполнения, как виджет" — для
 * удаления графа памяти, cores/ui/memory-graph-panel.js). Нативный
 * блокирующий диалог сознательно убран из этого же места ранее
 * (MEMORY_GRAPH.md: "единственное место во всём проекте с блокирующим
 * нативным диалогом... исправлено на немедленное действие, для
 * единообразия") — этот виджет держит то же единообразие (никакого
 * `confirm()`), но всё равно требует осознанного усилия перед необратимым
 * действием, показывая это заливкой, а не текстом плашки.
 *
 * Заливка — чистый CSS `transition: width`, не `setInterval`/`rAF`: класс
 * `stme-holding` ставится на pointerdown, CSS сам анимирует ширину от 0 до
 * 100% за `holdMs`. Единственный JS-таймер — ОДИН `setTimeout` на тот же
 * `holdMs`, чтобы поймать момент, когда удержание длилось достаточно;
 * отпускание раньше (`pointerup`/`pointerleave`/`pointercancel`) чистит его
 * и снимает класс — заливка мгновенно откатывается, ничего не срабатывает.
 */
export function HoldButton(label, onConfirm, { holdMs = 1200, variant = 'danger', disabled = false } = {}) {
    let timer = null;
    // `event.currentTarget` — ТОЛЬКО на время диспетчеризации самого события,
    // браузер сбрасывает его в `null` сразу после выхода из обработчика
    // (спецификация DOM, не баг браузера). Настоящий баг, найден живьём:
    // `setTimeout()`-колбэк читал `event.currentTarget` спустя целый
    // `holdMs` — к этому моменту он уже `null`, `.classList` бросал
    // TypeError молча (нигде не пойманный), поэтому и заливка застревала
    // на 100% (снимающая её строка так и не выполнялась), и `onConfirm()`
    // после неё тоже никогда не доходил до вызова. Фикс — брать элемент
    // из `currentTarget` СРАЗУ, в момент самого `pointerdown`, и держать
    // ссылку в замыкании, а не перечитывать её из события позже.
    const release = element => {
        clearTimeout(timer);
        timer = null;
        element.classList.remove('stme-holding');
    };
    return h('button', {
        type: 'button',
        class: `menu_button stme-hold-button${variant === 'danger' ? ' stme-danger' : ''}`,
        disabled,
        style: { '--stme-hold-ms': `${holdMs}ms` },
        'on:pointerdown': event => {
            if (disabled) return;
            const element = event.currentTarget;
            element.classList.add('stme-holding');
            timer = setTimeout(() => {
                element.classList.remove('stme-holding');
                onConfirm();
            }, holdMs);
        },
        'on:pointerup': event => release(event.currentTarget),
        'on:pointerleave': event => release(event.currentTarget),
        'on:pointercancel': event => release(event.currentTarget),
    },
        h('span', { class: 'stme-hold-button-fill' }),
        h('span', { class: 'stme-hold-button-label' }, label),
    );
}

/**
 * An icon-only button — a distinct affordance from `Button()` (which always
 * carries ST's `menu_button` text-button chrome): a small round tool button
 * showing just an icon (an inline SVG tree or, at a pinch, an emoji string),
 * with an `active` state for toggle-style tool palettes (ROADMAP.md 5.47 —
 * the map module's marker/region tool picker, floating over the canvas
 * rather than sitting in a text-labelled top toolbar).
 */
export function IconButton(icon, onClick, { active = false, title, disabled = false } = {}) {
    return h('button', {
        type: 'button',
        class: `stme-icon-button${active ? ' stme-icon-button-active' : ''}`,
        title,
        disabled,
        'on:click': onClick,
    }, icon);
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

/**
 * Крутящийся индикатор. Отдельным виджетом, а не разметкой внутри `Overlay`:
 * ожидание бывает не только у обновления, и второй раз рисовать то же кольцо
 * руками не придётся.
 */
export function Spinner({ size = 'md' } = {}) {
    return h('div', { class: `stme-spinner stme-spinner-${size}` });
}

/**
 * Наложение на ВЕСЬ экран, перекрывающее доступ к странице.
 *
 * Не «модалка вообще», а именно перекрытие доступа: у Alpha оно появилось,
 * когда просьба была заблокировать САМУ СТРАНИЦУ, а не только свою панель —
 * пока движок обновляется, работать с наполовину заменённым кодом нельзя.
 * Поэтому у него нет ни крестика, ни закрытия по клику: закрывать его
 * пользователю нечем и незачем.
 *
 * `visible` — сигнал: виджет ничего не решает сам, он только рисует то
 * состояние, которое ему дали.
 */
export function Overlay(visibleSignal, { title, description, children } = {}) {
    return h('div', { class: 'stme-overlay-root' },
        computed(() => (visibleSignal() ? h('div', { class: 'stme-overlay' },
            h('div', { class: 'stme-overlay-box' },
                Spinner(),
                h('strong', { class: 'stme-overlay-title' }, title),
                description ? h('p', { class: 'stme-overlay-text' }, description) : null,
                children ?? null,
            ),
        ) : null)),
    );
}

/**
 * Полоса во всю ширину у самого верха страницы — для того, что нельзя
 * пропустить и что не проходит само. Отличается от `Toast` именно этим:
 * плашка временная и уезжает сама, полоса висит, пока причина не устранена, и
 * несёт действие, которым её устраняют.
 *
 * Живёт вне разметки расширения намеренно: у Alpha она была прибита к верху
 * окна ровно потому, что свёрнутая панель не должна прятать сообщение о том,
 * что движок не обновился.
 */
export function Banner(textSignal, { tone = 'warn', icon = '⚠', action, actionLabel = 'Retry', busy } = {}) {
    return h('div', { class: `stme-banner stme-banner-${tone}` },
        h('span', { class: 'stme-banner-icon' }, icon),
        h('span', { class: 'stme-banner-text' }, textSignal),
        action ? computed(() => Button(busy && busy() ? 'Working…' : actionLabel, action, { disabled: Boolean(busy && busy()) })) : null,
    );
}

/**
 * A single round button fixed to the SCREEN, not tied to any panel/tab —
 * for a Module that wants its own always-visible launch point independent
 * of the shared launcher dock in `index.js` (ROADMAP.md 5.43, the map
 * module's dock button: "Кнопка должна быть на экране в целом... кнопка
 * дефолтно находится в правом нижнем углу и её можно перетягивать").
 *
 * Draggable by passing `drag` from [draggable.js](draggable.js)'s
 * `createDragHandlers(positionSignal, { onDrop, onClick })` — `onClick`
 * (not a plain `on:click`) is what tells a near-stationary release apart
 * from an actual drag, since the same pointer handlers serve both.
 */
export function DockButton(icon, { position, drag, title } = {}) {
    const style = computed(() => {
        const { left, top } = (typeof position === 'function' ? position() : position) ?? {};
        const next = {};
        if (left !== undefined) next.left = `${left}px`;
        if (top !== undefined) next.top = `${top}px`;
        return next;
    });
    return h('button', { type: 'button', class: 'stme-dock-button', style, title, ...(drag ?? {}) }, icon);
}

/**
 * A thin protruding tab at the edge of a container, clicked (not hovered —
 * that reveal style is the SHARED launcher dock's own thing, see
 * `index.js`'s `addLauncherDock`) to slide out a settings drawer alongside
 * it. Built for the map module's window ("справа от карты — небольшой
 * выступ, разворачивает полные настройки"), but generic: any floating
 * window with occasional settings that shouldn't compete with its main
 * content for space can reuse it.
 *
 * Pure, like every other widget here: `open` is a signal the CALLER owns,
 * `onToggle` is how this widget asks for it to change — no state of its own.
 */
export function EdgeDrawer(open, { onToggle, title = 'Settings' } = {}, ...children) {
    return h('div', { class: computed(() => `stme-edge-drawer${open() ? ' stme-edge-drawer-open' : ''}`) },
        h('button', {
            type: 'button', class: 'stme-edge-drawer-tab', title,
            'on:click': () => onToggle?.(!open()),
        }, computed(() => (open() ? '›' : '‹'))),
        h('div', { class: 'stme-edge-drawer-body' }, children),
    );
}

// --- Chat Viewport chrome (план `chat-viewport`) --------------------------
//
// Хром — DOM-обвязка вокруг WebGL-текстуры тела сообщения (сам текст рисует
// канвас, не эти виджеты): аватарка, шапка, действия, блок рассуждений.
// Статичные, БЕЗ анимации (см. память feedback-no-animated-effects-reflow —
// анимация рядом с чатом форсирует reflow, обхода в этом окружении нет).

/**
 * Аватарка сообщения — намеренно КРУПНЕЕ дефолтного размера в ST (~32-40px):
 * прямое решение владельца при проектировании шапки Chat Viewport. `url`
 * может быть пустым (нет аватара у этого спикера/сообщения) — тогда рисуется
 * пустая заглушка с первой буквой имени, а не сломанная `<img>`.
 *
 * `width`≠`height` — НАСТОЯЩИЙ прямоугольник (портретные пропорции 3×4), не
 * квадрат со скруглёнными углами: первая версия давала `size` на обе
 * стороны разом (72×72) — владелец поправил дважды подряд, "квадратная а
 * не прямоугольная" именно про ЭТО, квадрат с скруглением всё ещё квадрат.
 * 102×136 — owner: "увеличь аватарку в 1.5 раза в ширину" (68 × 1.5 = 102)
 * "и так, чтобы она была 3x4 в портретном варианте" (102 / 3 × 4 = 136).
 * `border-radius: 14px` — см. `.stme-avatar` в panel.css.
 */
export function Avatar(url, { width = 102, height = 136, name = '' } = {}) {
    const style = { width: `${width}px`, height: `${height}px` };
    if (!url) {
        const initial = String(name ?? '').trim().charAt(0).toUpperCase() || '?';
        return h('div', { class: 'stme-avatar stme-avatar-fallback', style, 'aria-hidden': 'true' }, initial);
    }
    return h('img', { class: 'stme-avatar', style, src: url, alt: name ? `${name}'s avatar` : '' });
}

/**
 * Время сообщения — принимает УЖЕ готовую строку, а не сырую дату: формат
 * ST (`send_date`) — не ISO (`"2024-01-01 @12h00m00s"`), парсить его здесь
 * означало бы держать знание о чужом формате в общем виджете. Вызывающий
 * (Ядро/Модуль) решает, как отформатировать; `title` — полное значение по
 * наведению, когда `text` — сокращённое ("2 min ago").
 */
export function Timestamp(text, { title } = {}) {
    return h('time', { class: 'stme-timestamp', title }, text);
}

/** Реальный SVG-глиф, не эмодзи — та же причина, что у иконок инструментов карты (ROADMAP.md 5.5x): эмодзи рендерится непредсказуемо/по-детски между платформами. */
function editIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M3 21v-3.75L14.81 5.44l3.75 3.75L6.75 21H3zM18.71 4.04a1 1 0 0 1 1.41 0l1.84 1.84a1 1 0 0 1 0 1.41l-1.79 1.79-3.25-3.25 1.79-1.79z' }),
    );
}
function deleteIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H2V5h4l1-2z' }),
    );
}
function swipeLeftIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M15 6l-6 6 6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    );
}
function swipeRightIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M9 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    );
}
function regenerateIcon() {
    return h('svg', { viewBox: '0 0 24 24', class: 'stme-icon-svg', 'aria-hidden': 'true' },
        h('path', { d: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z' }),
    );
}

/**
 * Полоска-светофор генерации — owner: "небольшая полоска генерации как у
 * светофора, которая фиксирует свой последний цвет после завершения
 * генерации. Красная - ген прерван, зеленый - успешен, оранжеый - ген
 * идет." Три состояния, не пять, как у общего Activity Light этого же
 * движка (`cores/ui/activity-light.js` — idle/working/success/warning/
 * error/notify): владелец здесь намеренно свёл "остановлено без ошибки" и
 * "настоящая ошибка" в ОДНО красное — "прерван" тем и тем. `null`/что-то
 * незнакомое — нейтральная полоска БЕЗ цвета (сообщение никогда не
 * генерировалось на глазах этой вкладки — историческое, открыто уже
 * готовым; см. `genStatus` в chat-viewport.js). В ОТЛИЧИЕ от Activity
 * Light — НЕ гаснет обратно в нейтральный по таймеру, держит цвет
 * НАВСЕГДА (сам чат — история, а не живая консоль).
 */
export function GenStripe(status) {
    const known = status === 'working' || status === 'success' || status === 'error';
    return h('div', { class: `stme-chat-viewport-gen-stripe${known ? ` stme-chat-viewport-gen-stripe-${status}` : ''}`, 'aria-hidden': 'true' });
}

/**
 * Хедер сообщения — аватарка, полоска-светофор, имя, номер хода, время
 * генерации (только у НЕ-пользовательских реплик, где оно вообще имеет
 * смысл), время сообщения. `genDurationMs`/`timestampText` — уже готовые
 * строки/числа от вызывающего; виджет ничего не вычисляет сам, только
 * раскладывает.
 */
/**
 * `actions` — уже готовое дерево (обычно `MessageActionsRow(...)`), кладётся
 * в ТОТ ЖЕ ряд, что имя и бейджи, а не отдельной строкой ниже (владелец: "Любые
 * кнопки должны быть в ряд с именем") — `margin-left: auto` в CSS прижимает
 * его к правому краю ряда, не раздувая высоту шапки. Сам ряд несёт класс
 * `stme-message-header-name-row`, под который и написано скрытие-по-наведению
 * (см. panel.css) — виджет только даёт разметку, наведение целиком на CSS.
 *
 * `align-items: flex-start` (panel.css), не `center` — owner: "Имя
 * персонажа не выровнены по верху фото": аватар вырос до портрета 102×136
 * (был квадрат 72×72, до этого 56×56) — центрирование стало заметно
 * сдвигать имя вниз от видимого верхнего края аватарки.
 */
/**
 * ТОЛЬКО имя/бейджи/время — БЕЗ аватарки и полоски-светофора. Владелец
 * (после "мимо" на первую версию — "Оно должно быть СПРАВА от аватарки.
 * Блоки ризонинга тоже. И только после заполнения той зоны спускаться
 * вниз") настоял на НАСТОЯЩЕМ обтекании: не только имя, а ВСЁ (имя,
 * дата, `ReasoningBlock`, ToolCall) должно течь рядом с аватаркой, пока
 * её высота не кончится — а `ReasoningBlock`/ToolCall рисует уже НЕ этот
 * виджет, а `buildRowTree()` в `cores/ui/chat-viewport.js`, отдельными
 * сиблингами. Значит аватарке/полоске нужно быть НАСТОЯЩИМ CSS `float`
 * НАД ВСЕМИ ними разом (обычный `<img style="float:left">` + текст после
 * — ЛЮБОЙ следующий блочный сиблинг в том же контексте форматирования
 * САМ обтекает float, даже если он не прямой ребёнок того же узла, что
 * float, — обычное поведение CSS, не выдумка) — а не только рядом с
 * ЭТИМ конкретным виджетом. Аватарка/полоска поэтому вынесены наружу,
 * в `buildRowTree()`, единственный узел, которому видны ВСЕ сиблинги
 * разом. Собран как раньше — только БЕЗ `Avatar()`/`GenStripe()`
 * внутри и БЕЗ обёртки `.stme-message-header` (та задавала `display:
 * flex` на паре "аватар+инфо" — сейчас аватар снаружи, инфо просто
 * блочный элемент, обтекающий чужой float естественно).
 */
export function MessageHeader({ name = '', turnIndex, genDurationMs, timestampText, isUser = false, actions } = {}) {
    return h('div', { class: 'stme-message-header-info' },
        h('div', { class: 'stme-message-header-name-row' },
            h('strong', { class: 'stme-message-header-name' }, name || (isUser ? 'You' : 'Narrator')),
            turnIndex != null ? Badge(`#${turnIndex}`, { tone: 'muted' }) : null,
            !isUser && genDurationMs != null ? Badge(`${(genDurationMs / 1000).toFixed(1)}s`, { tone: 'muted' }) : null,
            actions ?? null,
        ),
        timestampText ? Timestamp(timestampText) : null,
    );
}

/**
 * Действия над сообщением — edit/delete/swipe/regenerate. Свайп и
 * регенерация показываются, только если вызывающий вообще дал счётчик
 * свайпов (`swipeCount`) — у сообщения пользователя свайпов не бывает, и
 * рисовать нерабочие стрелки хуже, чем не рисовать ничего.
 */
export function MessageActionsRow({ onEdit, onDelete, onSwipeLeft, onSwipeRight, onRegenerate, swipeIndex, swipeCount } = {}) {
    const canSwipe = Number.isFinite(swipeCount) && swipeCount > 1;
    return h('div', { class: 'stme-message-actions' },
        onEdit ? IconButton(editIcon(), onEdit, { title: 'Edit' }) : null,
        onDelete ? IconButton(deleteIcon(), onDelete, { title: 'Delete' }) : null,
        canSwipe ? IconButton(swipeLeftIcon(), onSwipeLeft, { title: 'Previous swipe' }) : null,
        canSwipe ? h('span', { class: 'stme-message-swipe-counter' }, `${(swipeIndex ?? 0) + 1}/${swipeCount}`) : null,
        canSwipe ? IconButton(swipeRightIcon(), onSwipeRight, { title: 'Next swipe' }) : null,
        onRegenerate ? IconButton(regenerateIcon(), onRegenerate, { title: 'Regenerate' }) : null,
    );
}

/**
 * Блок рассуждений (CoT) — свёрнут по умолчанию (тот же родной `<details>`,
 * что и `Details()`, но собран здесь напрямую, а не через неё — `onToggle`
 * нужен ТОЛЬКО этому виджету, а `Details()` используют много вызывающих с
 * другой сигнатурой, менять её ради одного случая рискованно). `text`
 * пуст/отсутствует — виджет не рисует НИЧЕГО, а не пустую секцию.
 *
 * `onToggle` — НАЙДЕНО ЖИВЬЁМ: раскрытие/сворачивание `<details>` — чисто
 * браузерное действие, движок о нём никак не узнаёт сам по себе. Высота
 * строки (и, следом, позиция ВСЕХ строк ниже неё в виртуализации) меняется,
 * а `render()` никто не зовёт — открытие рассуждений визуально не двигало
 * ничего под ним, следующие сообщения оставались на старом месте и
 * накладывались. `'on:toggle'` — родное DOM-событие `<details>`, дёшево
 * подписаться, дальше вызывающий (`cores/ui/chat-viewport.js`) решает, что
 * с этим делать (обычно — `render()` заново).
 */
export function ReasoningBlock(text, { onToggle } = {}) {
    if (!text) return null;
    return h('details', { class: 'stme-details', 'on:toggle': onToggle },
        h('summary', {}, 'Reasoning'),
        h('div', { class: 'stme-reasoning-text' }, text),
    );
}
