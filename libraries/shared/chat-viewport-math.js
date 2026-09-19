/**
 * Chat Viewport — чистая математика видимого окна списка сообщений. Ни DOM,
 * ни WebGL здесь нет: только числа на входе, числа на выходе — тот же
 * принцип, что у [draggable.js](draggable.js)'s `createDragHandlers`/
 * `clampToViewport` (координаты в чистую функцию, наружу тоже координаты).
 *
 * Высота строки сообщения ЗАРАНЕЕ неизвестна — сообщения радикально разной
 * длины (одна реплика vs абзацы + блок рассуждений + данные Tracker/RP Time).
 * Поэтому вход — не фиксированная величина строки, а карта `mesid → высота`,
 * заполняемая Ядром по мере измерения уже отрисованных строк
 * (`dom.measureRect`/`dom.observeResize` со стороны Сервиса). Для ещё НЕ
 * измеренных строк используется `estimatedHeight` — оценка, которая либо
 * подтвердится, либо будет тут же исправлена на следующий пересчёт: это
 * обычный компромисс виртуализации с переменной высотой, не баг.
 */

/** Высота строки — измеренная, если есть, иначе оценка. */
function heightOf(mesid, heights, estimatedHeight) {
    const measured = heights?.get?.(mesid);
    return Number.isFinite(measured) && measured > 0 ? measured : estimatedHeight;
}

/** Кумулятивные смещения по `order`: `offsets[i]` — сумма высот строк ДО индекса `i`. `offsets[order.length]` — суммарная высота всего списка. Один линейный проход, переиспользуется и для поиска окна, и для итоговых `offsetTop`/`totalHeight`. */
function computeOffsets(order, heights, estimatedHeight) {
    const offsets = new Array(order.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < order.length; i += 1) {
        offsets[i + 1] = offsets[i] + heightOf(order[i], heights, estimatedHeight);
    }
    return offsets;
}

/**
 * `order` — список ВСЕХ `mesid` в текущем порядке отображения (обычно просто
 * `["0","1","2",...]`, но не предполагается непрерывным индексом — история
 * может фильтровать системные сообщения так же, как `services/st-chat.js`
 * уже делает для `readChat()`).
 *
 * `heights` — `Map(mesid -> число)`, только для тех `mesid`, что уже были
 * измерены хотя бы раз.
 *
 * Возвращает `{ startIndex, endIndex, offsetTop, totalHeight }`:
 * `startIndex`/`endIndex` — границы в `order` (endIndex исключительно, как
 * `Array.slice`), `offsetTop` — на сколько пикселей сдвинут первый видимый
 * элемент от начала списка, `totalHeight` — сумма всех высот (реальных и
 * оценочных) — то, что вешают на "распорку" контейнера прокрутки, чтобы
 * скроллбар был правильного размера сразу, без ожидания измерения каждой
 * строки.
 */
export function computeVisibleRange({
    order,
    heights,
    scrollTop,
    viewportHeight,
    estimatedHeight = 96,
    overscan = 3,
} = {}) {
    const list = Array.isArray(order) ? order : [];
    const offsets = computeOffsets(list, heights, estimatedHeight);
    const totalHeight = offsets[list.length];

    const top = Math.max(0, Number(scrollTop) || 0);
    const bottom = top + Math.max(0, Number(viewportHeight) || 0);

    // offsets is non-decreasing, so the first index whose row EXTENDS past
    // `top` is the first visible row; the first index whose row STARTS past
    // `bottom` is one past the last visible row. Empty list: both loops fall
    // through their bounds, correctly yielding start === end === 0.
    let rawStart = list.length;
    for (let i = 0; i < list.length; i += 1) {
        if (offsets[i + 1] > top) { rawStart = i; break; }
    }
    let rawEnd = list.length;
    for (let i = rawStart; i < list.length; i += 1) {
        if (offsets[i] > bottom) { rawEnd = i; break; }
    }

    const startIndex = Math.max(0, Math.min(rawStart, list.length) - overscan);
    const endIndex = Math.min(list.length, Math.max(rawEnd, rawStart) + overscan);

    return { startIndex, endIndex, offsetTop: offsets[startIndex], totalHeight };
}

/**
 * Обновление карты высот без пересоздания карты целиком по каждому измерению
 * — новая `Map`, но старые записи переиспользованы как есть (для сигнала это
 * одна операция `.set()`, а не N). Возвращает `null`, если высота не
 * изменилась (округление до целого пикселя — суб-пиксельные дрожания
 * `ResizeObserver` не должны гонять пересчёт диапазона на каждый чих
 * браузера).
 */
export function reconcileMeasuredHeight(heights, mesid, newHeight) {
    const rounded = Math.round(Number(newHeight) || 0);
    const prev = heights?.get?.(mesid);
    if (Number.isFinite(prev) && Math.round(prev) === rounded) return null;
    const next = new Map(heights ?? []);
    next.set(mesid, rounded);
    return next;
}

/**
 * Группировка подряд идущих сообщений ОДНОГО отправителя в "глиф" — owner:
 * "Глиф - одна цепочка сообщений от одного пользователя подряд. В нем блоки
 * отдельно (в том числе ToolCalls). Картинка и название и номер
 * привязывается только к началу глифа."
 *
 * `messages` — массив `{mesid, name, isToolCall}` В ПОРЯДКЕ отображения (как
 * из `stChat.messages`). Только ToolCall-сообщения (`isToolCall: true`) НЕ
 * рвут цепочку и НЕ несут своё собственное имя — owner явно уточнил (после
 * первой версии, рвавшей цепочку на КАЖДОМ `is_system`): "Тулл колл должен
 * быть внутри глифа персонажа", а не отдельным глифом. ToolCall просто
 * ПРИСОЕДИНЯЕТСЯ к уже открытому глифу как ещё один блок, не трогая его
 * `name`/`headerMesid`.
 *
 * **НАЙДЕНО ЖИВЬЁМ, почему это именно `isToolCall`, а НЕ просто
 * `isSystem`**: в реальном чате `is_system: true` стоит НЕ только у
 * ToolCall-уведомлений — им ST помечает и обычные СКРЫТЫЕ реплики персонажей
 * (в т.ч. это же поле использует `stChat.setHidden` — см. doc-comment
 * `services/st-chat.js`). Первая версия (на `isSystem`) сворачивала в ОДИН
 * гигантский глиф вообще ВСЁ подряд скрытое, включая настоящие реплики
 * РАЗНЫХ персонажей (Sasha и Vladilena, is_system:true у обеих, но каждая —
 * не ToolCall) — терялась сама граница между говорящими, а не только между
 * ToolCall и репликой. `isToolCall` — узкий, точный признак именно того,
 * что owner просил сворачивать.
 *
 * Единственный край: ToolCall первым сообщением ВООБЩЕ (нет открытого
 * глифа) — тогда он честно открывает свой собственный (присоединяться не к
 * чему).
 *
 * Возвращает массив `{ headerMesid, mesids }` — `headerMesid` первым
 * сообщением цепочки несёт аватар/имя/номер, `mesids` — ВСЕ mesid'ы глифа
 * по порядку (включая сам `headerMesid`).
 */
export function computeGlyphs(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const glyphs = [];
    let current = null;
    for (const message of list) {
        const name = String(message?.name ?? '');
        const isPassthrough = Boolean(message?.isToolCall);
        // Сообщение ИИ продолжает открытый глиф только если это ПРОДОЛЖЕНИЕ ТОГО ЖЕ ХОДА: предыдущее сообщение глифа — вызов инструмента
        // либо ещё не ответ (пустой текст — рассуждение/раунд инструментов). Два законченных ответа ИИ подряд (например, после удаления
        // сообщения пользователя между ними) — два разных глифа, а не один. Сообщения пользователя подряд по-прежнему склеиваются.
        const last = current?.last;
        const continuesTurn = Boolean(last) && (Boolean(last.isToolCall) || String(last.text ?? '').trim() === '');
        const merges = current && (isPassthrough || (current.name === name && (Boolean(message?.isUser) || continuesTurn)));
        if (merges) {
            current.mesids.push(message.mesid);
            current.last = message;
        } else {
            current = { name, headerMesid: message.mesid, mesids: [message.mesid], last: message };
            glyphs.push(current);
        }
    }
    return glyphs.map(({ headerMesid, mesids }) => ({ headerMesid, mesids }));
}
