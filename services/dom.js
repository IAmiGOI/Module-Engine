/**
 * Сервис DOM — the real, single leaf implementation of "touch the actual
 * page" that Ядро финального UI для PC (cores/ui/final-ui-pc.js) draws on.
 * Просто логический адаптер (ARCHITECTURE.md): no logic of its own beyond
 * what a single real DOM call needs — every decision (WHAT to build, WHEN)
 * stays in the Core; this only knows HOW to do one primitive DOM operation.
 *
 * Reached ONLY through the Шина сервисов, like every other Сервис — no
 * exception, even though there's structurally only one real DOM per
 * platform (see ARCHITECTURE.md's own note on this: trivial resolving
 * never excuses skipping the rights check). Each primitive operation is
 * its own contract, `immediate` priority (PIPELINE.md-style) — fast, but
 * still Гейт-checked on every single call, same as anything else.
 */

const DOM_PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'textContent', 'className', 'open', 'hidden']);

/**
 * Что мы САМИ последний раз записали в этот проп — не то, что сейчас
 * ЧИТАЕТСЯ из `el[key]`. Проверено на реальном браузере: у `<option>` без
 * явно выставленного content-атрибута `value` геттер `.value` откатывается на
 * `textContent` — если сравнение ниже читает живой `el.value`, а не то, что
 * писали МЫ, запись `value: ''` на свежий `<option>` (ДО того, как в него
 * положили текст-подпись) читается как «уже ''», пропускается, атрибут так и
 * не выставляется — и после того, как подпись дописалась, `.value` тихо
 * съезжает на неё саму. Тем же путём словил бы и `checked`/`selected` на
 * элементе, где браузер зачем-то откатывается на своё умолчание.
 */
const lastWritten = new WeakMap(); // el -> { [key]: value }

function setProp(el, key, value) {
    if (key.startsWith('on:')) {
        const type = key.slice(3);
        el.__listeners ??= {};
        if (el.__listeners[type]) el.removeEventListener(type, el.__listeners[type]);
        if (value) { el.addEventListener(type, value); el.__listeners[type] = value; }
        else delete el.__listeners[type];
        return;
    }
    if (key === 'class') { el.className = value ?? ''; return; }
    if (key === 'style' && value && typeof value === 'object') { Object.assign(el.style, value); return; }
    // Присваивание того же значения — не безобидный no-op: у <input> запись
    // в .value ставит каретку в конец, даже если строка не изменилась. А
    // реактивное связывание поля именно это и делает на каждое нажатие
    // (ввод → сигнал → диффинг → сюда), так что без этой проверки печатать
    // в середине строки было бы невозможно. Сравниваем с тем, что писали МЫ
    // (см. doc-comment `lastWritten` выше), а не с текущим `el[key]`.
    if (DOM_PROPS.has(key)) {
        const written = lastWritten.get(el);
        if (!written || written[key] !== value) {
            el[key] = value;
            lastWritten.set(el, { ...written, [key]: value });
        }
        return;
    }
    if (value === false || value == null) el.removeAttribute(key);
    else el.setAttribute(key, value === true ? '' : String(value));
}

function removeProp(el, key) {
    setProp(el, key, key === 'class' ? '' : null);
}

/**
 * Registers every `dom.*` contract on `servicesBus` (a Service caller's
 * `.own` bus — see engine.js's registerCaller()). `document` is injected so
 * tests never need a real browser; production wiring omits it (defaults to
 * `globalThis.document`).
 */
export function registerDomService(servicesBus, { document: doc = globalThis.document } = {}) {
    const unregisters = [
        servicesBus.register('dom.createElement', ({ tag }) => doc.createElement(tag), { loadMetric: () => 0 }),
        servicesBus.register('dom.createTextNode', ({ text }) => doc.createTextNode(text), { loadMetric: () => 0 }),
        servicesBus.register('dom.setProp', ({ el, key, value }) => setProp(el, key, value), { loadMetric: () => 0 }),
        servicesBus.register('dom.removeProp', ({ el, key }) => removeProp(el, key), { loadMetric: () => 0 }),
        servicesBus.register('dom.append', ({ parent, child }) => parent.append(child), { loadMetric: () => 0 }),
        servicesBus.register('dom.remove', ({ node }) => node.remove(), { loadMetric: () => 0 }),
        servicesBus.register('dom.replaceWith', ({ oldNode, newNode }) => oldNode.replaceWith(newNode), { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}

/** Exported for services/dom.test.js's own unit-level coverage of the raw DOM logic, independent of the contract/Gate plumbing. */
export const domOperations = { setProp, removeProp };
