/**
 * A minimal but real fake `document` — real tree operations (append/remove/
 * replaceWith), a real attribute map, real event listener bookkeeping.
 * Scoped to exactly what services/dom.js calls; not a general-purpose DOM
 * harness. Shared between tests/dom-service.test.js and
 * tests/final-ui-pc.test.js (built once for the first, extracted here once
 * the second needed the exact same thing — same practice Alpha's own
 * tests/helpers/fake-dom.js followed).
 */
export class FakeElement {
    constructor(tag) {
        this.tagName = tag;
        this.nodeType = 1;
        this.children = [];
        this.parent = null;
        this.attributes = {};
        this.style = {};
        this.className = '';
        this.value = undefined;
        this.checked = undefined;
        this._listeners = new Map();
        this._clicked = 0;
    }
    /** Aliases matching the REAL DOM names (`childNodes`/`parentNode`) — services/dom.js's paint helpers walk real nodes and must work unchanged against this fake. */
    get childNodes() { return this.children; }
    get parentNode() { return this.parent; }
    /** Real `Element.textContent` recursively concatenates every descendant text node; the setter mirrors the real DOM's own behavior of REPLACING every existing child with one plain text node. */
    get textContent() { return this.children.map(child => child.textContent ?? '').join(''); }
    set textContent(value) { for (const child of [...this.children]) child.remove(); this.append(new FakeTextNode(String(value ?? ''))); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, fn) { this._listeners.set(type, fn); }
    removeEventListener(type, fn) { if (this._listeners.get(type) === fn) this._listeners.delete(type); }
    append(child) { child.parent?._detach(child); this.children.push(child); child.parent = this; }
    /** Real `Node.insertBefore` semantics: `ref === null` appends at the end. */
    insertBefore(child, ref) {
        child.parent?._detach(child);
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index === -1) this.children.push(child);
        else this.children.splice(index, 0, child);
        child.parent = this;
        return child;
    }
    remove() { this.parent?._detach(this); }
    // Real anchor-download flow (services/file.js) never dispatches a real
    // click event through this fake tree — just records that it happened,
    // which is all a test needs to assert the Service actually triggered one.
    click() { this._clicked += 1; }
    replaceWith(other) {
        const parent = this.parent;
        if (!parent) return;
        parent.children[parent.children.indexOf(this)] = other;
        other.parent = parent;
        this.parent = null;
    }
    _detach(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parent = null;
    }
}

export class FakeTextNode {
    constructor(text) { this._text = text; this.parent = null; this.nodeType = 3; }
    get parentNode() { return this.parent; }
    /** `nodeValue`/`textContent` both alias the same string on a real Text node. */
    get nodeValue() { return this._text; }
    set nodeValue(value) { this._text = value; }
    get textContent() { return this._text; }
    set textContent(value) { this._text = value; }
    /** Kept for existing callers (dom-service.test.js reads `.text` directly). */
    get text() { return this._text; }
    remove() { this.parent?._detach(this); }
}

export function makeFakeDocument() {
    return {
        body: new FakeElement('body'),
        createElement: tag => new FakeElement(tag),
        createTextNode: text => new FakeTextNode(text),
    };
}
