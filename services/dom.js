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
 * SVG tags need `document.createElementNS()`, not the plain
 * `document.createElement()` used for everything else — a `<circle>`/
 * `<polygon>`/etc. created via `createElement` is a generic, non-rendering
 * `HTMLUnknownElement` (attributes like `cx`/`r` are still settable as
 * plain DOM attributes, so `getAttribute()` lies that everything is fine),
 * not a real `SVGCircleElement` — it paints NOTHING, at a `getBoundingClientRect()`
 * of `{width:0, height:0}`. Found live (ROADMAP.md 5.47): the map module's
 * whole region/node/edge canvas rendered zero visible shapes despite every
 * node/attribute being present and correct in the tree. `__isSvg` is set on
 * creation so `setProp()` below can ALSO route `class` through `setAttribute`
 * for these — `SVGElement.className` is a read-only `SVGAnimatedString`,
 * so the plain `el.className = value` used for HTML elements silently does
 * nothing on a real SVG element either.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
    'svg', 'g', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'rect', 'image',
    'text', 'tspan', 'defs', 'use', 'symbol', 'marker', 'clipPath', 'linearGradient', 'radialGradient', 'stop',
]);

function createElement(doc, tag) {
    if (!SVG_TAGS.has(tag)) return doc.createElement(tag);
    const el = doc.createElementNS(SVG_NS, tag);
    el.__isSvg = true;
    return el;
}

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
    if (key === 'class') {
        if (el.__isSvg) el.setAttribute('class', value ?? '');
        else el.className = value ?? '';
        return;
    }
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

const PAINT_CLASS = 'stme-speaker-paint';
const PAINT_MARK_ATTR = 'data-stme-paint';

/** Every real Text node under `node`, in document order — walks real `childNodes`/`nodeType`, not the virtual-dom `h()` tree from cores/ui/tree.js. */
function collectTextNodes(node, acc = []) {
    for (const child of node.childNodes ?? []) {
        if (child.nodeType === 3) acc.push(child);
        else if (child.nodeType === 1) collectTextNodes(child, acc);
    }
    return acc;
}

/** Undoes a previous paintTextRuns() pass — unwraps every `[data-stme-paint]` span back to its own plain text node. Never touches anything else, so re-painting is always safe to call blind (see message-footer.js's own "idempotent attach()" precedent). */
function clearPaintedRuns(container) {
    const spans = [];
    (function walk(node) {
        for (const child of [...(node.childNodes ?? [])]) {
            if (child.nodeType === 1 && child.getAttribute?.(PAINT_MARK_ATTR) != null) spans.push(child);
            else if (child.nodeType === 1) walk(child);
        }
    }(container));
    for (const span of spans) {
        const parent = span.parentNode;
        const inner = span.childNodes?.[0];
        if (parent && inner) { parent.insertBefore(inner, span); span.remove(); }
        else span.remove();
    }
}

/**
 * `computeX` — pure derivation, no DOM: for each text node (`{ index, start,
 * end, text }`, offsets over the CONCATENATION of every text node under the
 * container), works out which sub-slices fall under a paint run and which
 * stay plain. Exported so the splitting logic is tested as data, same
 * discipline as widgets.js — `paintTextRuns()` below is just this plan
 * executed against real nodes.
 *
 * A text node with no overlapping run at all is left out of the result
 * entirely (the caller must leave it untouched) — rebuilding a node that
 * needs no change would be a needless DOM write for every repaint.
 */
export function computeTextNodePaintPlan(nodeInfos, runs) {
    const sortedRuns = (runs ?? []).filter(run => run.end > run.start).sort((a, b) => a.start - b.start);
    const plans = [];
    for (const info of nodeInfos) {
        const overlapping = sortedRuns.filter(run => run.start < info.end && run.end > info.start);
        if (overlapping.length === 0) continue;

        const breakpoints = new Set([0, info.text.length]);
        for (const run of overlapping) {
            breakpoints.add(Math.max(0, Math.min(info.text.length, run.start - info.start)));
            breakpoints.add(Math.max(0, Math.min(info.text.length, run.end - info.start)));
        }
        const sorted = [...breakpoints].sort((a, b) => a - b);

        const pieces = [];
        for (let i = 0; i < sorted.length - 1; i += 1) {
            const from = sorted[i];
            const to = sorted[i + 1];
            if (to <= from) continue;
            const globalFrom = info.start + from;
            const globalTo = info.start + to;
            const covering = overlapping.find(run => run.start <= globalFrom && run.end >= globalTo);
            pieces.push({ text: info.text.slice(from, to), color: covering ? covering.color : null });
        }
        plans.push({ index: info.index, pieces });
    }
    return plans;
}

/**
 * Wraps character ranges of `container`'s rendered text in colored
 * `<span data-stme-paint>` — the DOM-only mechanism the project owner asked
 * for explicitly: it mutates the RENDERED node ST already drew, never
 * `message.mes`/the chat array, so nothing here can leak into the model
 * context (see cores/ui/message-footer.js's own "the model never sees this"
 * precedent, same guarantee, different surface).
 *
 * `runs` — `[{ start, end, color }]` in offsets over the PLAIN TEXT
 * concatenation of `container`'s current text nodes (exactly what
 * `libraries/core/speaker-detection.js`'s segments already use). Always
 * starts by undoing any earlier paint (`clearPaintedRuns`) so calling this
 * again after ST re-renders the message is always safe and idempotent —
 * never doubles up spans, never leaves a stale color from a previous resolve.
 *
 * Markup INSIDE the message (bold/italic/links from ST's own markdown
 * rendering) is never touched beyond the individual text node it already
 * owns — a run crossing a `<b>` boundary simply becomes two separate colored
 * spans, one per original text node, so existing formatting survives untouched.
 */
function paintTextRuns(container, runs, doc) {
    clearPaintedRuns(container);
    const textNodes = collectTextNodes(container);
    let cursor = 0;
    const nodeInfos = textNodes.map((node, index) => {
        const text = String(node.textContent ?? '');
        const info = { index, start: cursor, end: cursor + text.length, text };
        cursor += text.length;
        return info;
    });

    const plans = computeTextNodePaintPlan(nodeInfos, runs);
    for (const plan of plans) {
        const node = textNodes[plan.index];
        const parent = node.parentNode;
        if (!parent) continue;
        for (const piece of plan.pieces) {
            if (piece.color) {
                const span = doc.createElement('span');
                span.className = PAINT_CLASS;
                span.setAttribute(PAINT_MARK_ATTR, '1');
                span.style.color = piece.color;
                span.append(doc.createTextNode(piece.text));
                parent.insertBefore(span, node);
            } else {
                parent.insertBefore(doc.createTextNode(piece.text), node);
            }
        }
        node.remove();
    }
    return true;
}

/**
 * Registers every `dom.*` contract on `servicesBus` (a Service caller's
 * `.own` bus — see engine.js's registerCaller()). `document` is injected so
 * tests never need a real browser; production wiring omits it (defaults to
 * `globalThis.document`).
 */
export function registerDomService(servicesBus, { document: doc = globalThis.document } = {}) {
    const unregisters = [
        servicesBus.register('dom.createElement', ({ tag }) => createElement(doc, tag), { loadMetric: () => 0 }),
        servicesBus.register('dom.createTextNode', ({ text }) => doc.createTextNode(text), { loadMetric: () => 0 }),
        servicesBus.register('dom.setProp', ({ el, key, value }) => setProp(el, key, value), { loadMetric: () => 0 }),
        servicesBus.register('dom.removeProp', ({ el, key }) => removeProp(el, key), { loadMetric: () => 0 }),
        servicesBus.register('dom.append', ({ parent, child }) => parent.append(child), { loadMetric: () => 0 }),
        servicesBus.register('dom.remove', ({ node }) => node.remove(), { loadMetric: () => 0 }),
        servicesBus.register('dom.replaceWith', ({ oldNode, newNode }) => oldNode.replaceWith(newNode), { loadMetric: () => 0 }),
        servicesBus.register('dom.paintTextRuns', ({ container, runs }) => paintTextRuns(container, runs, doc), { loadMetric: () => 0 }),
        servicesBus.register('dom.clearPaintedRuns', ({ container }) => { clearPaintedRuns(container); return true; }, { loadMetric: () => 0 }),
        /** Read-only text extraction — the one property read a Модуль is never allowed to take directly off a node it was handed (see ARCHITECTURE.md: no exceptions for "just a read"). */
        servicesBus.register('dom.textContent', ({ node }) => String(node?.textContent ?? ''), { loadMetric: () => 0 }),
        /** Reads a CSS custom property off `documentElement` — the same theme accent ST itself exposes (`--SmartThemeQuoteColor`), used by Модуль «Speaker Colors» to derive its auto palette from the user's actual theme rather than a hardcoded color. */
        servicesBus.register('dom.readCssVariable', ({ name }) => {
            const source = doc.documentElement ?? doc.body;
            const value = (doc.defaultView ?? globalThis).getComputedStyle?.(source)?.getPropertyValue(name);
            return String(value ?? '').trim();
        }, { loadMetric: () => 0 }),
    ];
    return () => { for (const unregister of unregisters) unregister(); };
}

/** Exported for services/dom.test.js's own unit-level coverage of the raw DOM logic, independent of the contract/Gate plumbing. */
export const domOperations = { setProp, removeProp, paintTextRuns, clearPaintedRuns, createElement };
