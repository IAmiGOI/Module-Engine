/**
 * Контракт виджета рабочего стола Module Engine — чистые функции, без DOM. Виджет — САМОДОСТАТОЧНЫЙ файл (`widgets/<id>/widget.js` или объект, зарегистрированный
 * на лету): он ничего не импортирует из движка, а рабочий стол ничего не знает про его внутренности. Между ними только эта форма данных:
 *
 *   {
 *     id: 'clock',                        // [a-z0-9-]+, уникален
 *     title: 'Clock', description: '…',
 *     size: { w: 220, h: 130 },           // размер блока (зажимается в WIDGET_SIZE_LIMITS)
 *     rights: ['storage.settings.get'],   // контракты, к которым виджету можно тянуться (Гейт как у Модулей); нет — только своё
 *     create(host) → instance             // фабрика; host — см. cores/ui/home/widgets.js
 *   }
 *   instance = {
 *     html(),                              // тело блока: HTML-строка для WebGL-растра (классы `wg-*`, см. `widgetCss`); рисует ТОЛЬКО внутри блока
 *     actions?: [{ id, icon, title }],     // круглые кнопки блока (DOM); нажатие → onAction(id)
 *     rows?(),                             // необязательный СПИСОК строк: [{ id, image?, imageFallback?, click?, actions: [{ id, icon, title }] }] — `click` — id действия при нажатии на саму строку (не на кнопку); рабочий стол рисует для каждой аватар (`image`, DOM)
 *                                          // и круглые кнопки; текст строки виджет кладёт в `html()` по `host.layout` (строка i — `rowsTop + i * rowH`, слева колонка аватара)
 *     search?: { placeholder, value },     // необязательная строка ПОИСКА над списком (DOM-поле рабочего стола); ввод → onSearch(value), список строк сдвигается на `layout.searchH`
 *     onAction?(id, rowId?), onSearch?(value), start?(), stop?()   // нажатие кнопки блока (rowId — у кнопки строки); start после монтирования, stop при снятии (обязателен для всего запущенного)
 *   }
 * Виджет сообщает «перерисуй меня» вызовом `host.invalidate()`.
 * host = { instanceId, widgetId, invalidate(), request(contract, params, { via: 'cores'|'services' }), storage.get/set, subscribe(event, cb) → unsubscribe, layout: { rowsTop, rowH, searchH } }.
 */

/** Раскладка строк списка (`instance.rows()`): пара к `HEAD_H` и `RECENT_ROW_H` в `home-model.js` (тест следит, чтобы не разошлись). */
export const WIDGET_LAYOUT = Object.freeze({ rowsTop: 52, rowH: 46, searchH: 36 });

export const WIDGET_SIZE_LIMITS = Object.freeze({ minW: 140, maxW: 520, minH: 90, maxH: 420 });
export const WIDGET_DEFAULT_SIZE = Object.freeze({ w: 220, h: 130 });
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const clamp = (value, min, max) => Math.max(min, Math.min(max, Math.round(value)));

/**
 * Проверяет и нормализует определение виджета. `{ ok: true, widget }` или `{ ok: false, error }` — ничего не бросает: чужой виджет не должен ронять
 * рабочий стол, его просто не берут с понятной причиной.
 */
export function normalizeWidget(definition) {
    if (!definition || typeof definition !== 'object') return { ok: false, error: 'the widget definition is not an object' };
    const { id, title, description = '', size, rights = [], create } = definition;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, error: `bad widget id "${String(id)}" (lowercase letters, digits and dashes)` };
    if (typeof title !== 'string' || !title.trim()) return { ok: false, error: `widget "${id}" has no title` };
    if (typeof create !== 'function') return { ok: false, error: `widget "${id}" has no create(host) function` };
    if (!Array.isArray(rights) || rights.some(item => typeof item !== 'string')) return { ok: false, error: `widget "${id}": rights must be a list of contract names` };
    const { minW, maxW, minH, maxH } = WIDGET_SIZE_LIMITS;
    const w = clamp(Number(size?.w) || WIDGET_DEFAULT_SIZE.w, minW, maxW);
    const h = clamp(Number(size?.h) || WIDGET_DEFAULT_SIZE.h, minH, maxH);
    return { ok: true, widget: { id, title: title.trim(), description: String(description), size: { w, h }, rights: [...rights], create } };
}

/** Экземпляр виджета на столе: id блока и следующий свободный id экземпляра (`w1`, `w2`, …) — один виджет можно поставить несколько раз. */
export const widgetBlockId = instanceId => `widget:${instanceId}`;
export function nextInstanceId(existing = []) {
    const used = new Set(existing);
    let n = 1;
    while (used.has(`w${n}`)) n += 1;
    return `w${n}`;
}

/** Проверяет форму экземпляра (`create(host)` вернул что-то пригодное): `html()` обязателен. */
export function isValidInstance(instance) {
    return Boolean(instance) && typeof instance.html === 'function';
}

/** Безопасный HTML тела: ошибка внутри виджета не роняет кадр — блок показывает текст ошибки. */
export function safeBodyHtml(instance, escape) {
    try {
        const html = instance.html();
        return typeof html === 'string' ? html : `<div class="hb"><div class="wg-muted" style="top:14px;left:14px">${escape('Widget returned no HTML.')}</div></div>`;
    } catch (error) {
        return `<div class="hb"><div class="wg-muted" style="top:14px;left:14px;right:14px">${escape(`Widget error: ${error?.message ?? error}`)}</div></div>`;
    }
}

/** Общие классы для тел виджетов: у растра свой CSS (см. `homeCss`), поэтому виджет берёт готовые классы, а не тянет свои стили. Цвета — из токенов. */
export const widgetCss = ({ text, muted, accent }) => `
.wg-title { color: ${accent}; font-size: 13px; font-weight: 700; line-height: 18px; }
.wg-big { color: ${text}; font-size: 38px; font-weight: 700; line-height: 46px; letter-spacing: 1px; }
.wg-text { color: ${text}; font-size: 13px; line-height: 18px; }
.wg-muted { color: ${muted}; font-size: 12px; line-height: 16px; }
`;
