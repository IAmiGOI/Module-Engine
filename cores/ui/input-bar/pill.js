import { computeFieldHeight, maxFieldHeight, sendButtonMode } from '../../../libraries/shared/input-bar-model.js';

/** Высота однострочного поля: строка 20px + по 11px сверху и снизу (в CSS те же числа — `styles/chrome/input-bar.css`). */
const FIELD_MIN_HEIGHT = 42;

/**
 * Пилюля набора текста: слева круглая «Перегенерировать», по центру поле (растёт вместе с текстом), справа круглая «Отправить»/«Стоп».
 * Круги — по высоте ОДНОЙ строки и прижаты к нижним углам: краем совпадают с закруглением пилюли, а при росте поля остаются внизу.
 *
 * Собирает и оживляет только DOM; что значит «отправить», решает вызывающий (`onSend`/`onStop`/`onRegenerate`/`onInput`/`shouldSend`).
 * Браузерное (`document`, `getWindowHeight`, `ResizeObserverCtor`) — инъекцией: пилюля проверяется на подставном DOM.
 */
export function createInputPill({
    document: doc = globalThis.document,
    onInput = () => {}, onSend = () => {}, onStop = () => {}, onRegenerate = () => {}, shouldSend = () => false,
    getWindowHeight = () => globalThis.innerHeight,
    ResizeObserverCtor = globalThis.ResizeObserver,
    onResize = () => {},
} = {}) {
    const make = (tag, className) => { const el = doc.createElement(tag); if (className) el.className = className; return el; };
    const icon = name => { const i = make('i', `fa-solid ${name} fa-fw`); return i; };

    const root = make('div', 'stme-input-bar');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Message input');

    const regenerate = make('button', 'stme-input-circle stme-input-regenerate');
    regenerate.setAttribute('type', 'button');
    regenerate.setAttribute('title', 'Regenerate the last message');
    regenerate.setAttribute('aria-label', 'Regenerate the last message');
    regenerate.append(icon('fa-rotate-right'));

    const field = make('textarea', 'stme-input-field');
    field.setAttribute('rows', '1');
    field.setAttribute('placeholder', 'Type a message…');
    field.setAttribute('aria-label', 'Message');

    const send = make('button', 'stme-input-circle stme-input-send');
    send.setAttribute('type', 'button');

    root.append(regenerate, field, send);

    let generating = false;

    function renderSendButton() {
        const mode = sendButtonMode({ generating });
        send.className = `stme-input-circle stme-input-send${mode === 'stop' ? ' stme-input-send-stop' : ''}`;
        send.setAttribute('title', mode === 'stop' ? 'Stop generating' : 'Send');
        send.setAttribute('aria-label', mode === 'stop' ? 'Stop generating' : 'Send');
        send.replaceChildren(icon(mode === 'stop' ? 'fa-stop' : 'fa-paper-plane'));
    }
    renderSendButton();

    /** Высота поля по тексту: сбрасываем в `auto`, читаем полную высоту, ставим итог (не выше потолка — дальше прокрутка внутри). */
    function autosize() {
        field.style.height = 'auto';
        const { height, scrolls } = computeFieldHeight({
            scrollHeight: field.scrollHeight, minHeight: FIELD_MIN_HEIGHT, maxHeight: maxFieldHeight(getWindowHeight()),
        });
        field.style.height = `${height}px`;
        field.style.overflowY = scrolls ? 'auto' : 'hidden';
    }

    field.addEventListener('input', () => { autosize(); onInput(field.value); });
    field.addEventListener('keydown', event => {
        if (!shouldSend(event)) return;
        event.preventDefault();
        onSend();
    });
    // Кнопки не отбирают фокус у поля (на телефоне это закрывало бы клавиатуру при каждой отправке).
    for (const button of [regenerate, send]) button.addEventListener('mousedown', event => event.preventDefault());
    regenerate.addEventListener('click', () => onRegenerate());
    send.addEventListener('click', () => { if (generating) onStop(); else onSend(); });

    // Пилюля растёт с текстом — вьюпорту чата нужно знать её высоту (нижний отступ), поэтому наружу уходит событие на любой размер.
    let observer = null;
    if (typeof ResizeObserverCtor === 'function') {
        observer = new ResizeObserverCtor(() => onResize());
        observer.observe(root);
    }

    return {
        root,
        field,
        mount: parent => { parent.append(root); autosize(); },
        /** Левый край и ширина — колонка сообщений. */
        setColumn: ({ left, width }) => { root.style.left = `${left}px`; root.style.width = `${width}px`; },
        setGenerating: next => { const value = Boolean(next); if (value === generating) return; generating = value; renderSendButton(); },
        setValue: value => { if (field.value === value) return; field.value = value; autosize(); },
        getValue: () => field.value,
        focus: () => field.focus(),
        autosize,
        height: () => root.offsetHeight ?? 0,
        dispose: () => { observer?.disconnect(); root.remove(); },
    };
}
